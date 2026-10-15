CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, sector TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_records_tenant_sector ON records (tenant, sector, created_at);
CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, account TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, balance_after_minor INTEGER NOT NULL, reference TEXT, idem_key TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger (tenant, account, currency, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON ledger (tenant, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, tenant TEXT NOT NULL, route TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tenant, route));
