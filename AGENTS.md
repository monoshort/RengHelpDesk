# AGENTS.md

## Cursor Cloud specific instructions

### Product

Single **Node.js Express** app (`shopify-dpd-dashboard` / Toddie helpdesk): Shopify orders, DPD tracking, mail helpdesk, optional OpenAI. No compile step; no `lint` or `test` npm scripts.

### Dependencies

- **Node.js**: `package.json` specifies `20.x`; CI uses Node 20. The VM may have Node 22 (works with `EBADENGINE` warning).
- **Package manager**: npm only (`package-lock.json`). Install with `npm ci` or `npm install`.

### Standard commands

| Task | Command |
|------|---------|
| Install | `npm ci` |
| Dev server | `npm run dev` (port **3000**, `PORT` overridable) |
| Production-like | `npm start` |
| Env template | `cp .env.example .env` (optional locally; see auth below) |
| CI-equivalent checks | `node --check server/index.js` then `timeout 8s npm start \|\| test $? -eq 124` with `PORT=3999 NODE_ENV=test` |
| Desk knowledge validate | `npm run desk:knowledge:check` |

There is **no** `npm run lint` or `npm test`. Integration smoke scripts exist (`mail:smoke*`, `shopify:check`) but need real API credentials.

### Auth (local dev)

If `DASHBOARD_PASSWORD` is unset, the default password is **`RengTod123!`** (see `server/dashboardAuth.js`). `GET /api/health` is public; protected routes require `POST /api/dashboard/login` with a session cookie.

### Services

Only **one process** must run locally: the Express server. No Docker Compose or Postgres required; without `DATABASE_URL`, cache uses **sql.js** under `./data`.

Optional external APIs (not needed for login + static UI smoke): Shopify, DPD, OpenAI, Microsoft Graph, Gmail, SMTP.

### Running the server in Cloud Agent VMs

Use **tmux** for long-running `npm run dev` (do not rely on one-shot background shells). Example session name: `helpdesk-dev`.

After start: `curl http://localhost:3000/api/health` → `{"ok":true}`.

### Gotchas

- **Shopify overview** (`GET /api/overview`) returns setup errors without `SHOPIFY_ACCESS_TOKEN` / OAuth — expected without secrets.
- **Vercel local simulation**: set `VERCEL=1` so the app does not call `listen` (see README).
- Do not commit `.env` or token files; only `.env.example` is tracked.
