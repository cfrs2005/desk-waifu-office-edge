// Front end, edge variant. No SSE (Workers free plan can't keep the
// connection open cheaply); we poll /api/room + /api/timeline every 2s.
// Same in-memory seat map, same render path as the Node version — only
// the transport changed.

const KNOWN_AGENTS = new Set(['claude-code', 'hermes', 'codex']);
const SLEEP_DIM_MS = 5 * 60 * 1000;
const POLL_MS = 2000;
const TL_MAX = 30;

const room = document.getElementById('room');
const onlineEl = document.getElementById('online');
const todayEl = document.getElementById('today');
const tpl = document.getElementById('seat-tpl');

todayEl.textContent = new Date().toISOString().slice(0, 10);

const seats = new Map();      // seatId -> seat

function seatId(s) { return `${s.user}::${s.agent}::${s.instance}`; }

// Stable seat order so the layout doesn't jitter when SSE/poll deltas arrive
// in different orders. Sort by user, then agent, then instance.
function sortSeats() {
  const arr = [...seats.values()].sort((a, b) => {
    if (a.user !== b.user) return a.user.localeCompare(b.user);
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    return a.instance.localeCompare(b.instance);
  });
  for (const s of arr) room.appendChild(s.el);  // reorder DOM in place
}

function makeSeatEl(seat) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.username').textContent = '@' + seat.user;
  const agentEl = node.querySelector('.agent');
  agentEl.textContent = seat.agent;
  agentEl.classList.add(KNOWN_AGENTS.has(seat.agent) ? seat.agent : 'generic');
  return node;
}

function applyState(seat) {
  const stateName = seat.state || 'idle_blink';
  const img = seat.el.querySelector('.gif');
  img.src = `/u/${seat.user}/gifs/${stateName}.gif`;
  img.onerror = () => { img.style.opacity = '0.25'; };
  img.onload  = () => { img.style.opacity = '1'; };
  seat.el.querySelector('.statename').textContent = stateName;
  const dot = seat.el.querySelector('.statedot');
  dot.className = 'statedot ' + stateName;

  // Drive the lamp-glow ::before via a single state class on the seat itself.
  // Clear any prior s-* class, then add the current one.
  for (const cls of [...seat.el.classList]) {
    if (cls.startsWith('s-')) seat.el.classList.remove(cls);
  }
  seat.el.classList.add('s-' + stateName);

  const avatar = seat.el.querySelector('.avatar');
  avatar.classList.remove('pulse');
  void avatar.offsetWidth; // restart CSS animation
  avatar.classList.add('pulse');

  updateDim(seat);
}

// task = master's order, sticky from start to session-end. 2-line preview
// with full text in title= for hover. Clears when value is empty.
function setTask(seat, text) {
  const el = seat.el.querySelector('.task');
  if (!text) {
    el.classList.remove('show');
    el.removeAttribute('title');
    setTimeout(() => { el.hidden = true; el.textContent = ''; }, 500);
    return;
  }
  el.textContent = text;
  el.title = text;  // hover-reveal for the full prompt
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
}

// bubble = transient short wisecrack (GLM bubble-writer, ≤14 CJK chars).
// Auto-fade 6s.
function showBubble(seat, text) {
  const el = seat.el.querySelector('.bubble');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (seat._bubbleTimer) clearTimeout(seat._bubbleTimer);
  seat._bubbleTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 500);
  }, 6000);
}

// hud = rolling activity strip. Each new HUD line replaces the previous.
// 60s persist; refreshed by every new event.
function showNarration(seat, text) {
  const el = seat.el.querySelector('.narration');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (seat._narrTimer) clearTimeout(seat._narrTimer);
  seat._narrTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 500);
  }, 60000);
}

// State decay: desk-waifu's local Hammerspoon side auto-transitions
// celebrate → sleep after 60s, and any active state → sleep after 3min
// of silence. We mirror that here so the office room doesn't freeze a
// chibi mid-celebrate forever.
const CELEBRATE_HOLD_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
function effectiveState(rawState, lastSeen) {
  const age = Date.now() - (lastSeen || 0);
  if (rawState === 'celebrate' && age > CELEBRATE_HOLD_MS) return 'sleep';
  if (rawState && rawState !== 'sleep' && rawState !== 'idle_blink'
      && age > IDLE_THRESHOLD_MS) return 'sleep';
  return rawState || 'idle_blink';
}

function updateDim(seat) {
  const state = effectiveState(seat.state, seat.lastSeen);
  const stale = state === 'sleep' && (Date.now() - (seat.lastSeen || 0) > SLEEP_DIM_MS);
  seat.el.classList.toggle('dim', !!stale);
}

function upsertSeat(s) {
  const id = seatId(s);
  let seat = seats.get(id);
  if (!seat) {
    seat = { ...s };
    seat.el = makeSeatEl(seat);
    room.appendChild(seat.el);
    seats.set(id, seat);
    sortSeats();  // keep DOM order stable
  }
  return seat;
}

function removeSeat(id) {
  const seat = seats.get(id);
  if (!seat) return;
  if (seat._bubbleTimer) clearTimeout(seat._bubbleTimer);
  if (seat._narrTimer) clearTimeout(seat._narrTimer);
  seat.el.remove();
  seats.delete(id);
}

// ── Polling loop ─────────────────────────────────────────────────────────
// /api/room is the ground truth for seat membership; /api/timeline gives
// us new events (with ids) so the timeline drawer streams in roughly
// real-time. 2s is the sweet spot: the agent push cadence is ~1–3s, so
// we rarely miss a state change for more than a frame.

const seenEventIds = new Set();
const tlListEl = document.getElementById('timeline-list');
const tlItemTpl = document.getElementById('timeline-item-tpl');
const tlPanel = document.getElementById('timeline');
tlPanel.querySelector('.timeline-toggle').addEventListener('click', () => {
  tlPanel.dataset.open = tlPanel.dataset.open === '1' ? '0' : '1';
});

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function tlAgentClass(a) { return KNOWN_AGENTS.has(a) ? a : 'generic'; }

function tlPrepend({ user, agent, type, value, ts }) {
  const li = tlItemTpl.content.firstElementChild.cloneNode(true);
  li.querySelector('.tl-time').textContent = fmtTime(ts);
  const who = li.querySelector('.tl-who');
  who.textContent = `@${user}·${agent}`;
  who.classList.add(tlAgentClass(agent));
  const arrow = li.querySelector('.tl-arrow');
  arrow.textContent = type === 'bubble' ? '“' : (type === 'hud' ? '·' : '→');
  const payload = li.querySelector('.tl-payload');
  payload.textContent = type === 'bubble' ? `${value}”` : value;
  payload.classList.add(`type-${type}`);
  if (type === 'state') payload.classList.add(`state-${value}`);
  tlListEl.prepend(li);
  while (tlListEl.children.length > TL_MAX) tlListEl.removeChild(tlListEl.lastChild);
  requestAnimationFrame(() => li.classList.add('fresh'));
  setTimeout(() => li.classList.remove('fresh'), 1200);
}

function applyRoom(roomData) {
  const present = new Set();
  for (const row of roomData.seats) {
    const id = `${row.user}::${row.agent_name}::${row.instance_id}`;
    present.add(id);
    const seat = upsertSeat({
      user: row.user, agent: row.agent_name, instance: row.instance_id,
    });
    seat.lastSeen = row.last_seen;
    seat.rawState = row.state || 'idle_blink';

    // Apply effective state (with decay). Keep seat.state holding the
    // currently-rendered state so we don't re-apply on every poll.
    const newState = effectiveState(seat.rawState, seat.lastSeen);
    if (newState !== seat.state) {
      seat.state = newState;
      applyState(seat);
    } else if (!seat._initial) {
      applyState(seat);
      seat._initial = true;
    }

    // task (sticky, multi-line). Set or clear based on whether server
    // returned a value. Track ts to avoid re-rendering identical content.
    if (row.task && row.task_ts && seat._lastTaskTs !== row.task_ts) {
      seat._lastTaskTs = row.task_ts;
      setTask(seat, row.task);
    } else if (!row.task && seat._lastTaskTs !== null) {
      seat._lastTaskTs = null;
      setTask(seat, '');
    }

    if (row.bubble && row.bubble_ts && Date.now() - row.bubble_ts < 30000
        && seat._lastBubbleTs !== row.bubble_ts) {
      seat._lastBubbleTs = row.bubble_ts;
      showBubble(seat, row.bubble);
    }
    if (row.hud && row.hud_ts && Date.now() - row.hud_ts < 5 * 60 * 1000
        && seat._lastHudTs !== row.hud_ts) {
      seat._lastHudTs = row.hud_ts;
      showNarration(seat, row.hud);
    }
  }
  // Cull seats that disappeared from /api/room.
  for (const id of [...seats.keys()]) {
    if (!present.has(id)) removeSeat(id);
  }
}

// Decay-driven re-render: every 5s, re-check each seat and apply the
// effective state. Catches the celebrate→sleep transition without needing
// a fresh poll event.
setInterval(() => {
  for (const seat of seats.values()) {
    const want = effectiveState(seat.rawState, seat.lastSeen);
    if (want !== seat.state) {
      seat.state = want;
      applyState(seat);
    }
  }
}, 5000);

async function tick() {
  try {
    const [roomRes, tlRes] = await Promise.all([
      fetch('/api/room').then((r) => r.json()),
      fetch('/api/timeline?limit=30').then((r) => r.json()),
    ]);
    applyRoom(roomRes);
    onlineEl.textContent = `${roomRes.online} online`;

    // Timeline: API returns newest first. Iterate reversed so prepends
    // preserve chronological order, and skip ids we've already rendered.
    for (const e of [...tlRes.events].reverse()) {
      if (seenEventIds.has(e.id)) continue;
      seenEventIds.add(e.id);
      tlPrepend({ user: e.user, agent: e.agent_name, type: e.type, value: e.value, ts: e.ts });
    }
    if (seenEventIds.size > 200) {
      // Keep the dedupe set bounded; old ids will never come back from
      // /api/timeline once they fall off the LIMIT 30 window.
      const arr = [...seenEventIds];
      seenEventIds.clear();
      for (const id of arr.slice(-100)) seenEventIds.add(id);
    }
  } catch {
    // Swallow transient failures; next tick retries.
  }
}

setInterval(() => { for (const s of seats.values()) updateDim(s); }, 30000);
setInterval(tick, POLL_MS);
tick();
