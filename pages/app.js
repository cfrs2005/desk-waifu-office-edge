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
const userGroups = new Map(); // user -> { el, seatsEl }

function seatId(s) { return `${s.user}::${s.agent}::${s.instance}`; }

function ensureUserGroup(user) {
  let g = userGroups.get(user);
  if (g) return g;
  const el = document.createElement('section');
  el.className = 'user-group';
  el.innerHTML = `<h2>@${user}</h2><div class="seats"></div>`;
  room.appendChild(el);
  g = { el, seatsEl: el.querySelector('.seats') };
  userGroups.set(user, g);
  return g;
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

  const avatar = seat.el.querySelector('.avatar');
  avatar.classList.remove('pulse');
  void avatar.offsetWidth; // restart CSS animation
  avatar.classList.add('pulse');

  updateDim(seat);
}

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

function updateDim(seat) {
  const stale = seat.state === 'sleep' && (Date.now() - (seat.lastSeen || 0) > SLEEP_DIM_MS);
  seat.el.classList.toggle('dim', !!stale);
}

function upsertSeat(s) {
  const id = seatId(s);
  let seat = seats.get(id);
  if (!seat) {
    seat = { ...s };
    const g = ensureUserGroup(seat.user);
    seat.el = makeSeatEl(seat);
    g.seatsEl.appendChild(seat.el);
    seats.set(id, seat);
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
  // Drop the user group if it's empty so the room view doesn't keep ghost
  // headers for users whose only instance went away.
  const user = seat.user;
  const group = userGroups.get(user);
  if (group && !group.seatsEl.children.length) {
    group.el.remove();
    userGroups.delete(user);
  }
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
    const newState = row.state || 'idle_blink';
    if (newState !== seat.state) {
      seat.state = newState;
      applyState(seat);
    } else if (!seat._initial) {
      // First touch on a known seat: render whatever state we got.
      applyState(seat);
      seat._initial = true;
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
  // Cull seats that disappeared from /api/room (older instance replaced
  // by a new one, or agent process simply stopped emitting).
  for (const id of [...seats.keys()]) {
    if (!present.has(id)) removeSeat(id);
  }
}

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
