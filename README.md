# desk-waifu-office-edge

Vendored, edge-deploy variant of `../desk-waifu-office`. Same room view,
same `/events` + `/assets/:state` API surface — but the server runs on
Cloudflare Workers, GIFs live in R2, state lives in D1, and there is no
SSE (the front end polls every 2s instead).

## Architecture

```
            ┌────────────────────────────┐
 browser ──▶│  Worker (src/index.js)     │
   │        │  Hono router + API surface │
   │        └──┬───────────┬─────────────┘
   │           │           │
   │     ┌─────▼─────┐ ┌───▼────────┐
   │     │   D1      │ │     R2     │
   │     │ users/    │ │ GIF blobs  │
   │     │ events/   │ │ key:       │
   │     │ agents/   │ │ user/state │
   │     │ assets/   │ │            │
   │     │ idem.     │ │            │
   │     └───────────┘ └────────────┘
   │
   └── static front end ─▶ Workers Static Assets  (./pages)
```

- **No SSE** — Workers free plan can't keep long-lived streams cheaply.
  Front end polls `/api/room` + `/api/timeline` every 2 seconds.
- **No demo simulator** — Workers can't run a background loop. If you
  need fake load, run an external script that POSTs to `/events`.
- **No local FS** — GIFs go straight into R2.

## Deploy (one-shot)

You need a Cloudflare account with `20260401.xyz` already on it, and
`wrangler login` already done.

```bash
# 1. install
npm install

# 2. create D1 db (one-time). Wrangler prints a database_id — paste it
#    into wrangler.toml in place of REPLACE_AFTER_d1_create.
npx wrangler d1 create office-db

# 3. apply schema to the remote D1
npx wrangler d1 execute office-db --remote --file=schema.sql

# 4. create the R2 bucket (one-time)
npx wrangler r2 bucket create office-assets

# 5. ship the Worker
npx wrangler deploy
```

If step 5 errors on the `[[routes]] custom_domain = true` line (zone
not detected, or zone on a different account), comment that block out
and bind `o.20260401.xyz` from the dashboard:
**Workers & Pages → desk-waifu-office → Triggers → Add custom domain**.

## Local dev

```bash
# applies schema to a local SQLite under .wrangler/state/
npm run db:migrate:local

# start a local Worker on :8787 with hot reload
npx wrangler dev
```

Visit <http://localhost:8787>. The R2 binding has a local emulator too —
uploads to `PUT /assets/:state` are persisted under `.wrangler/state/`.

## Pointing a desk-waifu client at the edge instance

In your existing `desk-waifu` checkout, edit `remote.env`:

```bash
# was:
HUB_URL=http://localhost:7878
# now:
HUB_URL=https://o.20260401.xyz
```

Then re-run the client bootstrap:

```bash
./remote-register.sh   # claims your username + writes api_key
./remote-sync.sh       # uploads your GIFs to R2
```

After that, the agent loop (`remote-emit.sh` or equivalent) keeps
posting `/events` and the office page shows you live.

## API contract (matches Node version)

| Method | Path                          | Auth | Notes                                  |
|--------|-------------------------------|------|----------------------------------------|
| POST   | `/register`                   | —    | `{username}` → `{username, api_key}`   |
| PUT    | `/assets/:state`              | bearer | multipart `gif`, dedupe via `X-Content-Sha256` (returns 204 when unchanged — Node returned 304) |
| GET    | `/u/:user/gifs/:state.gif`    | —    | public, `cache-control: 60s`           |
| POST   | `/events`                     | bearer | `{agent,instance,type,value,ts}`; `X-Client-Id` for 5min idempotency |
| GET    | `/api/room`                   | —    | `{now, online, seats[]}`               |
| GET    | `/api/timeline?limit=N`       | —    | newest first, each event has `id`      |
| GET    | `/healthz`                    | —    | liveness                               |

## Diff vs Node (`../desk-waifu-office`)

| Feature                | Node version           | Edge version                |
|------------------------|------------------------|-----------------------------|
| Server                 | Fastify + Node 20      | Hono on Workers             |
| DB                     | better-sqlite3 (file)  | D1                          |
| GIF storage            | `data/assets/$user/*`  | R2 bucket `office-assets`   |
| Push channel           | SSE `/stream`          | client polls (2s)           |
| Dedup response on PUT  | `304`                  | `204`                       |
| `online` counter       | live SSE clients       | distinct users seen ≤5min   |
| Demo simulator         | `data/demo.js`         | removed (no bg loops)       |
