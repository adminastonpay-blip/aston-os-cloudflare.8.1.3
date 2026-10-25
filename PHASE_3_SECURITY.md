# Phase 3 — Enterprise Fine-Grained Security & RBAC (+5%)

**Version:** 10.8.0  
**Routes:** `/v1/security/*`

## Deliverables

### OLS / ALS
- ALS by role (viewer / operator / compliance / admin)
- Redacts: ssn, tax_id, bank_account, salary, secret, api_key
- `POST /v1/security/als/preview`
- `POST /v1/security/ols/preview`
- Custom policies: `security_policies`

### Multi-tenant
- Strict tenant isolation (`enforceTenant`)
- `POST /v1/security/tenant/check`

### SSO
- `PUT /v1/security/sso` — OIDC/Azure AD/Okta JWT config
- `POST /v1/security/sso/validate` — HS256 + issuer/audience
- Claim → role mapping
- SAML: config placeholder only

### Audit
- `GET /v1/security/whoami`
- `GET /v1/security/audit`
