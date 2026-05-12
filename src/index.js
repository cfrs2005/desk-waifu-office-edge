// Workers entrypoint. One file, top-to-bottom, mirrors the Node version's
// routes.js so the API surface stays auditable side-by-side. The big swaps
// vs Node: better-sqlite3 → D1, fs → R2, SSE → polling on the client side.

import { Hono } from 'hono';

const VALID_STATES = new Set([
  'sleep', 'coding', 'peek', 'loading', 'fix_bug',
  'error_shrug', 'celebrate', 'supervise', 'idle_blink',
]);
const VALID_EVENT_TYPES = new Set(['state', 'bubble', 'hud', 'task']);
const BUBBLE_MAX = 28;   // GLM wisecrack — 14 CJK chars worst case
const HUD_MAX = 120;     // rolling activity strip (tool calls, AI prose)
const TASK_MAX = 200;    // sticky master order — the user's full prompt
const MAX_GIF_BYTES = 5 * 1024 * 1024;

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const STATE_RE = /^[a-z_]{2,32}$/;
const validUsername = (u) => typeof u === 'string' && USERNAME_RE.test(u);
const validState = (s) => typeof s === 'string' && STATE_RE.test(s);

// Web Crypto sha256 → lowercase hex. Workers has no node:crypto sync API,
// and Buffer is awkward here; raw DataView walk is fine for 32 bytes.
async function sha256Hex(input) {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// api_key generator: two randomUUIDs flattened, base64url-encoded, sliced
// to 32 chars. Plenty of entropy (>180 bits) and looks like a key, not
// like a UUID — easier for users to spot in logs.
function generateApiKey() {
  const raw = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  // 64 hex chars → 32 bytes; base64url encode the bytes then slice.
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

function parseBearer(h) {
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function authBearer(c) {
  const key = parseBearer(c.req.header('authorization'));
  if (!key) return null;
  const h = await sha256Hex(key);
  const row = await c.env.DB.prepare('SELECT username FROM users WHERE api_key_hash = ?').bind(h).first();
  return row ? row.username : null;
}

const app = new Hono();

// ── /register ────────────────────────────────────────────────────────────
// One-time username claim. Plaintext api_key is returned once, never
// stored. Same contract as Node version.
app.post('/register', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { body = {}; }
  if (!validUsername(body.username)) return c.json({ error: 'invalid_username' }, 400);

  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(body.username).first();
  if (exists) return c.json({ error: 'username_taken' }, 409);

  const key = generateApiKey();
  const hash = await sha256Hex(key);
  await c.env.DB.prepare('INSERT INTO users(username, api_key_hash, created_at) VALUES (?,?,?)')
    .bind(body.username, hash, Date.now()).run();
  return c.json({ username: body.username, api_key: key });
});

// ── PUT /assets/:state ───────────────────────────────────────────────────
// Multipart upload to R2. Dedup via X-Content-Sha256: when the claimed
// hash already matches the row, return 204 (Workers' 304 handling is
// inconsistent vs Node — 204 sidesteps caching surprises).
app.put('/assets/:state', async (c) => {
  const user = await authBearer(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const state = c.req.param('state');
  if (!validState(state) || !VALID_STATES.has(state)) {
    return c.json({ error: 'invalid_state' }, 400);
  }

  const claimedHash = c.req.header('x-content-sha256');
  if (claimedHash) {
    const cur = await c.env.DB.prepare('SELECT sha256 FROM assets WHERE user=? AND state=?')
      .bind(user, state).first();
    if (cur && cur.sha256 === claimedHash) return c.body(null, 204);
  }

  const form = await c.req.formData();
  const file = form.get('gif');
  if (!file || typeof file === 'string') return c.json({ error: 'missing_gif_field' }, 400);
  if (file.size > MAX_GIF_BYTES) return c.json({ error: 'file_too_large' }, 413);

  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(new Uint8Array(buf));

  const r2Key = `${user}/${state}.gif`;
  // R2 put: content-type is needed because we serve it back inline and
  // browsers will mis-sniff a missing one as octet-stream → download.
  await c.env.GIFS.put(r2Key, buf, {
    httpMetadata: { contentType: 'image/gif' },
  });

  await c.env.DB.prepare(
    `INSERT INTO assets(user,state,sha256,r2_key) VALUES (?,?,?,?)
     ON CONFLICT(user,state) DO UPDATE SET sha256=excluded.sha256, r2_key=excluded.r2_key`
  ).bind(user, state, sha, r2Key).run();

  return c.json({ ok: true, sha256: sha });
});

// ── GET /u/:user/gifs/:state.gif ─────────────────────────────────────────
// Public GIF serve. We pipe R2's body straight back; Workers handles the
// stream. Cache-Control:60s — short enough that re-uploads land quickly
// in the room view, long enough to spare R2 on a many-spectator page.
// Hono captures `:state.gif` greedily — the param value is `celebrate.gif`,
// not `celebrate`. Match the full filename and strip `.gif` ourselves.
app.get('/u/:user/gifs/:filename', async (c) => {
  const user = c.req.param('user');
  const filename = c.req.param('filename') || '';
  if (!filename.endsWith('.gif')) return c.body(null, 400);
  const state = filename.slice(0, -4);
  if (!validUsername(user) || !validState(state)) return c.body(null, 400);

  const row = await c.env.DB.prepare('SELECT r2_key FROM assets WHERE user=? AND state=?')
    .bind(user, state).first();
  if (!row) return c.body(null, 404);

  const obj = await c.env.GIFS.get(row.r2_key);
  if (!obj) return c.body(null, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'public, max-age=60',
      'etag': obj.httpEtag,
    },
  });
});

// ── POST /events ─────────────────────────────────────────────────────────
// Hot path. Same validation rules as Node version. No SSE broadcast —
// readers pick up new rows via /api/timeline polling.
app.post('/events', async (c) => {
  const user = await authBearer(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let b;
  try { b = await c.req.json(); } catch { b = {}; }

  if (!b.agent || typeof b.agent !== 'string' || b.agent.length > 64) {
    return c.json({ error: 'bad_agent' }, 400);
  }
  if (!b.instance || typeof b.instance !== 'string' || b.instance.length > 64) {
    return c.json({ error: 'bad_instance' }, 400);
  }
  if (!VALID_EVENT_TYPES.has(b.type)) return c.json({ error: 'bad_type' }, 400);
  if (typeof b.value !== 'string') return c.json({ error: 'bad_value' }, 400);
  if (b.type === 'state' && !VALID_STATES.has(b.value)) {
    return c.json({ error: 'unknown_state' }, 400);
  }
  if (b.type === 'bubble' && b.value.length > BUBBLE_MAX) {
    return c.json({ error: 'bubble_too_long' }, 400);
  }
  if (b.type === 'hud' && b.value.length > HUD_MAX) {
    b.value = b.value.slice(0, HUD_MAX);
  }
  if (b.type === 'task' && b.value.length > TASK_MAX) {
    b.value = b.value.slice(0, TASK_MAX);
  }

  // Normalize ts to milliseconds.
  //   seconds (≈1e9, 10 digits):  *1000
  //   ms      (≈1e12, 13 digits): kept
  //   µs      (≈1e15, 16 digits): /1e3
  //   ns      (≈1e18, 19 digits): /1e6
  // Alibaba-cloud Linux's `date +%s%3N` ignores the precision modifier and
  // emits ns, so we have to scale down server-side as a defensive net even
  // after the client patch.
  let ts = Number.isFinite(b.ts) ? b.ts : Date.now();
  if      (ts >= 1e18) ts = Math.floor(ts / 1e6);
  else if (ts >= 1e15) ts = Math.floor(ts / 1e3);
  else if (ts > 0 && ts < 1e12) ts = ts * 1000;

  // Idempotency: 5-minute window. We do this BEFORE the insert so a retry
  // storm doesn't multiply timeline rows.
  const clientId = c.req.header('x-client-id');
  if (clientId) {
    const prev = await c.env.DB.prepare('SELECT ts FROM idempotency WHERE client_id=?')
      .bind(clientId).first();
    if (prev && Date.now() - prev.ts < 5 * 60 * 1000) {
      return c.json({ ok: true, dedup: true });
    }
    await c.env.DB.prepare('INSERT OR REPLACE INTO idempotency(client_id, ts) VALUES (?,?)')
      .bind(clientId, Date.now()).run();
  }

  // D1 batch: insert + upsert in one round-trip. Beats two awaits — Workers
  // CPU time is bounded and every awaited DB call counts as a network hop.
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO events(user, agent_name, instance_id, type, value, ts) VALUES (?,?,?,?,?,?)')
      .bind(user, b.agent, b.instance, b.type, b.value, ts),
    c.env.DB.prepare(
      `INSERT INTO agents(user, agent_name, instance_id, last_seen) VALUES (?,?,?,?)
       ON CONFLICT(user, agent_name, instance_id) DO UPDATE SET last_seen=excluded.last_seen`
    ).bind(user, b.agent, b.instance, ts),
  ]);

  return c.json({ ok: true });
});

// ── GET /api/room ────────────────────────────────────────────────────────
// Snapshot: latest instance per (user, agent), with latest state/bubble/
// hud values. Same INNER JOIN trick as the Node version. `online` is the
// count of distinct users with a seat seen in the last 5 minutes.
app.get('/api/room', async (c) => {
  const now = Date.now();
  const sql = `
    SELECT a.user, a.agent_name, a.instance_id, a.last_seen,
      (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='state'
         ORDER BY ts DESC LIMIT 1) AS state,
      (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='bubble'
         ORDER BY ts DESC LIMIT 1) AS bubble,
      (SELECT ts FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='bubble'
         ORDER BY ts DESC LIMIT 1) AS bubble_ts,
      (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='hud'
         ORDER BY ts DESC LIMIT 1) AS hud,
      (SELECT ts FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='hud'
         ORDER BY ts DESC LIMIT 1) AS hud_ts,
      (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='task'
         ORDER BY ts DESC LIMIT 1) AS task,
      (SELECT ts FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
         AND e.instance_id=a.instance_id AND e.type='task'
         ORDER BY ts DESC LIMIT 1) AS task_ts
    FROM agents a
    INNER JOIN (
      SELECT user, agent_name, MAX(last_seen) AS max_seen
      FROM agents GROUP BY user, agent_name
    ) latest
      ON a.user=latest.user
     AND a.agent_name=latest.agent_name
     AND a.last_seen=latest.max_seen
    ORDER BY a.user, a.agent_name
  `;
  const seatsRes = await c.env.DB.prepare(sql).all();
  const seats = seatsRes.results || [];

  // "online" = distinct users with a recent seat. Cheaper than a separate
  // SSE-connection counter (we don't have one here anyway).
  const cutoff = now - 5 * 60 * 1000;
  const onlineSet = new Set();
  for (const s of seats) if (s.last_seen >= cutoff) onlineSet.add(s.user);

  return c.json({ now, online: onlineSet.size, seats });
});

// ── GET /api/timeline ────────────────────────────────────────────────────
// Newest first. `id` is exposed so the client can dedupe across polls.
app.get('/api/timeline', async (c) => {
  const raw = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(50, Number.isFinite(raw) && raw > 0 ? raw : 20);
  const res = await c.env.DB.prepare(
    'SELECT id, user, agent_name, type, value, ts FROM events ORDER BY id DESC LIMIT ?'
  ).bind(limit).all();
  return c.json({ events: res.results || [] });
});

app.get('/healthz', (c) => c.json({ ok: true }));

// Anything we don't handle falls through to the ASSETS binding (static
// front-end). Hono's notFound runs after every registered route misses.
app.notFound(async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
