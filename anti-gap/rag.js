/**
 * Anti-Gap Phase 6 — RAG knowledge base
 * R2 for documents, D1 for chunks + optional embeddings.
 * Vectorize when env.ASTON_VECTORIZE is bound; else D1 cosine / keyword.
 */

import { withDbFailover, ensureRoiSchema } from "./roi.js";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

export const RAG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kb_docs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    title TEXT,
    r2_key TEXT,
    bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kb_docs_tenant ON kb_docs (tenant_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant ON kb_chunks (tenant_id, doc_id)`
];

export async function ensureRagSchema(db) {
  if (!db) return;
  await db.batch(RAG_SCHEMA.map((sql) => db.prepare(sql)));
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const t = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + size);
    chunks.push(t.slice(i, end));
    if (end >= t.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.slice(0, 200);
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

export async function embedText(env, text) {
  if (!env?.AI) return null;
  try {
    const out = await env.AI.run(EMBED_MODEL, { text: [String(text).slice(0, 8000)] });
    if (Array.isArray(out?.data?.[0])) return out.data[0];
    if (Array.isArray(out?.data) && typeof out.data[0] === "number") return out.data;
    return null;
  } catch {
    return null;
  }
}

export async function ingestDocument(env, tenantId, { title, text, id }) {
  const tenant = String(tenantId || "").slice(0, 120);
  if (!tenant) return { ok: false, error: "tenant_required" };
  const body = String(text || "");
  if (!body.trim()) return { ok: false, error: "text_required" };
  if (body.length > 500_000) return { ok: false, error: "text_too_large", max: 500000 };

  const docId = id || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const r2Key = `kb/${tenant}/${docId}.txt`;

  if (env.ASTON_R2) {
    await env.ASTON_R2.put(r2Key, body, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { tenant, title: String(title || "").slice(0, 200) }
    });
  }

  const chunks = chunkText(body);
  const chunkRows = [];

  for (let i = 0; i < chunks.length; i++) {
    const emb = await embedText(env, chunks[i]);
    chunkRows.push({
      id: `${docId}_${i}`,
      doc_id: docId,
      tenant_id: tenant,
      idx: i,
      text: chunks[i],
      embedding: emb ? JSON.stringify(emb) : null,
      created_at: createdAt
    });
  }

  await withDbFailover(env, async (db) => {
    await ensureRoiSchema(db);
    await ensureRagSchema(db);
    await db
      .prepare(
        `INSERT OR REPLACE INTO kb_docs (id, tenant_id, title, r2_key, bytes, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(docId, tenant, String(title || "untitled").slice(0, 200), r2Key, body.length, chunks.length, createdAt)
      .run();

    await db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ?`).bind(docId).run();

    for (const c of chunkRows) {
      await db
        .prepare(
          `INSERT INTO kb_chunks (id, doc_id, tenant_id, idx, text, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(c.id, c.doc_id, c.tenant_id, c.idx, c.text, c.embedding, c.created_at)
        .run();
    }
  });

  if (env.ASTON_VECTORIZE) {
    try {
      const vectors = chunkRows
        .filter((c) => c.embedding)
        .map((c) => ({
          id: c.id,
          values: JSON.parse(c.embedding),
          metadata: { tenant, doc_id: docId, idx: c.idx }
        }));
      if (vectors.length) await env.ASTON_VECTORIZE.upsert(vectors);
    } catch (e) {
      console.error("[rag-vectorize]", e?.message || e);
    }
  }

  return {
    ok: true,
    doc_id: docId,
    tenant,
    title: String(title || "untitled").slice(0, 200),
    r2_key: r2Key,
    chunk_count: chunks.length,
    embedded: chunkRows.filter((c) => c.embedding).length,
    vectorize: Boolean(env.ASTON_VECTORIZE)
  };
}

export async function searchKnowledge(env, tenantId, query, topK = 5) {
  const tenant = String(tenantId || "").slice(0, 120);
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "query_required" };
  const k = Math.min(20, Math.max(1, Number(topK) || 5));

  if (env.ASTON_VECTORIZE) {
    try {
      const emb = await embedText(env, q);
      if (emb) {
        const matches = await env.ASTON_VECTORIZE.query(emb, { topK: k * 3, returnMetadata: true });
        const filtered = (matches?.matches || [])
          .filter((m) => m.metadata?.tenant === tenant)
          .slice(0, k);

        const texts = {};
        await withDbFailover(env, async (db) => {
          await ensureRagSchema(db);
          for (const m of filtered) {
            const row = await db.prepare(`SELECT id, text, doc_id FROM kb_chunks WHERE id = ?`).bind(m.id).first();
            if (row) texts[row.id] = row;
          }
        });

        return {
          ok: true,
          mode: "vectorize",
          query: q,
          results: filtered.map((m) => ({
            id: m.id,
            score: m.score,
            doc_id: m.metadata?.doc_id,
            text: texts[m.id]?.text || null
          }))
        };
      }
    } catch (e) {
      console.error("[rag-vectorize-query]", e?.message || e);
    }
  }

  const res = await withDbFailover(env, async (db) => {
    await ensureRagSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, doc_id, text, embedding FROM kb_chunks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500`
      )
      .bind(tenant)
      .all();
    return rows?.results || [];
  });

  if (!res.ok) return { ok: false, error: "kb_unavailable", detail: res.errors };

  const rows = res.result;
  const qEmb = await embedText(env, q);

  let scored;
  if (qEmb) {
    scored = rows
      .map((r) => {
        let emb = null;
        try {
          emb = r.embedding ? JSON.parse(r.embedding) : null;
        } catch {
          emb = null;
        }
        return {
          id: r.id,
          doc_id: r.doc_id,
          text: r.text,
          score: emb ? cosine(qEmb, emb) : 0
        };
      })
      .filter((r) => r.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } else {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 8);
    scored = rows
      .map((r) => {
        const low = (r.text || "").toLowerCase();
        let score = 0;
        for (const t of terms) if (low.includes(t)) score += 1;
        return { id: r.id, doc_id: r.doc_id, text: r.text, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  return {
    ok: true,
    mode: qEmb ? "d1_cosine" : "keyword",
    query: q,
    results: scored
  };
}

export async function listDocuments(env, tenantId, limit = 50) {
  const tenant = String(tenantId || "").slice(0, 120);
  const res = await withDbFailover(env, async (db) => {
    await ensureRagSchema(db);
    const rows = await db
      .prepare(
        `SELECT id, title, r2_key, bytes, chunk_count, created_at FROM kb_docs
         WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .bind(tenant, Math.min(100, Math.max(1, limit)))
      .all();
    return rows?.results || [];
  });
  if (!res.ok) return { ok: false, error: "kb_unavailable" };
  return { ok: true, tenant, documents: res.result };
}

export async function deleteDocument(env, tenantId, docId) {
  const tenant = String(tenantId || "").slice(0, 120);
  const id = String(docId || "").slice(0, 80);
  if (!id) return { ok: false, error: "doc_id_required" };

  let r2Key = null;
  await withDbFailover(env, async (db) => {
    await ensureRagSchema(db);
    const doc = await db
      .prepare(`SELECT r2_key FROM kb_docs WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenant)
      .first();
    r2Key = doc?.r2_key || null;
    await db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ? AND tenant_id = ?`).bind(id, tenant).run();
    await db.prepare(`DELETE FROM kb_docs WHERE id = ? AND tenant_id = ?`).bind(id, tenant).run();
  });

  if (r2Key && env.ASTON_R2) {
    try {
      await env.ASTON_R2.delete(r2Key);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, doc_id: id, deleted: true };
}
