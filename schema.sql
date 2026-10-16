CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_records_tenant_sector ON records (tenant, sector, created_at);
CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, account TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, balance_after_minor INTEGER NOT NULL, reference TEXT, idem_key TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (tenant, account, currency, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON ledger (tenant, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, tenant TEXT NOT NULL, route TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tenant, route));
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT, model TEXT, r2_key TEXT, content_type TEXT, size_bytes INTEGER, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_media_tenant ON media (tenant, created_at);
CREATE TABLE IF NOT EXISTS plugins_state (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs (tenant, created_at);
CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, url TEXT NOT NULL, secret TEXT, events TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

-- Phase 1: bounded metadata for auditable problem diagnosis/planning; raw context is not stored.
CREATE TABLE IF NOT EXISTS problem_runs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, mode TEXT NOT NULL, objective TEXT, domain TEXT NOT NULL, risk_level TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_problem_runs_tenant ON problem_runs (tenant, created_at);
