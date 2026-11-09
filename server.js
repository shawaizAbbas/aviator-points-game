'use strict';

/*
 * Aviator-style crash game — FUN POINTS ONLY. No real money anywhere.
 * Server-authoritative rounds: the server generates the crash point,
 * runs the round loop, and settles all bets. Clients just poll /api/state.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const DATA_FILE = path.join(__dirname, 'data.json');

/* Permanent storage (optional): if GITHUB_TOKEN + GIST_ID are set, the whole
 * database is mirrored to a private GitHub Gist, because Render's free disk
 * is wiped on every deploy. The in-memory db stays the source of truth while
 * running; the Gist copy is what survives restarts and redeploys. */
const GIST_ID = process.env.GIST_ID || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_API_BASE = process.env.GIST_API_BASE || 'https://api.github.com';
const CLOUD = !!(GIST_ID && GITHUB_TOKEN);

/* ---------------- persistence (JSON file, atomic writes) ---------------- */

let db = { players: [], nextId: 1, sessions: {} };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.players) && typeof parsed.nextId === 'number') {
        if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
        db = parsed;
      }
    }
  } catch (err) {
    console.error('Could not read data.json, starting fresh:', err.message);
  }
}

function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  scheduleCloudSync();
}

/* ---------------- cloud mirror (GitHub Gist) ---------------- */

let cloudTimer = null;
let cloudBusy = false;
let cloudDirty = false;

function scheduleCloudSync() {
  if (!CLOUD) return;
  cloudDirty = true;
  if (cloudTimer) return;
  cloudTimer = setTimeout(syncCloudNow, 1500);
}

async function syncCloudNow() {
  cloudTimer = null;
  if (!CLOUD || cloudBusy || !cloudDirty) return;
  cloudBusy = true;
  cloudDirty = false;
  try {
    const res = await fetch(GIST_API_BASE + '/gists/' + GIST_ID, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'aviator-points-game',
      },
      body: JSON.stringify({ files: { 'data.json': { content: JSON.stringify(db) } } }),
    });
    if (!res.ok) throw new Error('gist PATCH status ' + res.status);
  } catch (err) {
    console.error('Cloud sync failed (will retry on next change):', err.message);
    cloudDirty = true;
  } finally {
    cloudBusy = false;
    if (cloudDirty) scheduleCloudSync();
  }
}

async function loadFromCloud() {
  const res = await fetch(GIST_API_BASE + '/gists/' + GIST_ID, {
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'aviator-points-game',
    },
  });
  if (!res.ok) throw new Error('gist GET status ' + res.status);
  const gist = await res.json();
  const file = gist.files && gist.files['data.json'];
  if (!file || !file.content) return false;
  const parsed = JSON.parse(file.content);
  if (parsed && Array.isArray(parsed.players) && typeof parsed.nextId === 'number') {
    if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
    db = parsed;
    return true;
  }
  return false;
}

async function initDb() {
  if (CLOUD) {
    try {
      const ok = await loadFromCloud();
      console.log(ok ? 'Loaded database from cloud storage (Gist).' : 'Cloud storage empty — starting fresh.');
      if (ok) return;
    } catch (err) {
      console.error('Cloud load failed, falling back to local file:', err.message);
    }
  }
  loadDb();
}

function findPlayer(id) {
  return db.players.find((p) => p.id === Number(id));
}

/* ---------------- player passwords & sessions ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function setPlayerPassword(player, password) {
  player.passSalt = crypto.randomBytes(16).toString('hex');
  player.passHash = hashPassword(password, player.passSalt);
}

function checkPassword(player, password) {
  if (!player || !player.passHash || !player.passSalt) return false;
  const h = hashPassword(password, player.passSalt);
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(player.passHash, 'hex'));
  } catch (err) {
    return false;
  }
}

function createSession(playerId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { p: playerId, t: Date.now() };
  saveDb();
  return token;
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // sessions expire after 7 days

function sessionPlayerId(value) {
  if (typeof value === 'number') return value; // legacy shape
  if (value && typeof value === 'object') {
    if (Date.now() - (value.t || 0) > SESSION_MAX_AGE_MS) return null; // expired
    return value.p;
  }
  return null;
}

// The logged-in player for a request, from the X-Session header (or body.session).
function authPlayer(req) {
  const token = req.headers['x-session'] || (req.body && req.body.session);
  if (!token || typeof token !== 'string') return null;
  if (!(token in db.sessions)) return null;
  const pid = sessionPlayerId(db.sessions[token]);
  if (!pid) {
    delete db.sessions[token];
    saveDb();
    return null;
  }
  return findPlayer(pid) || null;
}

function dropSessionsFor(playerId) {
  Object.keys(db.sessions).forEach((t) => {
    if (sessionPlayerId(db.sessions[t]) === playerId) delete db.sessions[t];
  });
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, points: p.points };
}

/* ---------------- game engine ---------------- */

const BET_WINDOW_MS = 6000;   // time to place bets before take-off
const CRASH_PAUSE_MS = 3500;  // pause after a crash before the next round
const GROWTH_RATE = 0.13;     // multiplier = e^(GROWTH_RATE * seconds)
const MAX_CRASH = 500;        // crash point cap — rare moon flights reach 100–500x
const HISTORY_LEN = 15;
const FEED_LEN = 30;

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.05) return 1.0; // ~5% instant bust at 1.00x
  const m = Math.floor((0.94 / (1 - r)) * 100) / 100;
  return Math.min(MAX_CRASH, Math.max(1.0, m));
}

const game = {
  phase: 'betting', // 'betting' | 'flying' | 'crashed'
  roundId: 1,
  phaseEndsAt: Date.now() + BET_WINDOW_MS,
  flightStartedAt: null,
  crashPoint: generateCrashPoint(),
  currentMultiplier: 1.0,
  bets: new Map(), // playerId -> { playerId, name, amount, cashedAt, payout }
  history: [],     // past crash points, newest first
  feed: [],        // recent events, newest first
};

function pushFeed(entry) {
  game.feed.unshift(Object.assign({ ts: Date.now() }, entry));
  if (game.feed.length > FEED_LEN) game.feed.length = FEED_LEN;
}

function startBetting() {
  game.phase = 'betting';
  game.roundId += 1;
  game.bets = new Map();
  game.crashPoint = generateCrashPoint();
  game.currentMultiplier = 1.0;
  game.flightStartedAt = null;
  game.phaseEndsAt = Date.now() + BET_WINDOW_MS;
}

function startFlight() {
  game.phase = 'flying';
  game.flightStartedAt = Date.now();
  game.currentMultiplier = 1.0;
}

function crashFlight() {
  game.phase = 'crashed';
  game.currentMultiplier = game.crashPoint;
  game.history.unshift(game.crashPoint);
  if (game.history.length > HISTORY_LEN) game.history.length = HISTORY_LEN;
  pushFeed({ type: 'crash', crashPoint: game.crashPoint, roundId: game.roundId });
  game.phaseEndsAt = Date.now() + CRASH_PAUSE_MS;
  // Un-cashed bets are simply lost (points were deducted at bet time).
}

setInterval(() => {
  const now = Date.now();
  if (game.phase === 'betting') {
    if (now >= game.phaseEndsAt) startFlight();
  } else if (game.phase === 'flying') {
    const elapsedSec = (now - game.flightStartedAt) / 1000;
    const raw = Math.exp(GROWTH_RATE * elapsedSec);
    if (raw >= game.crashPoint) {
      crashFlight();
    } else {
      game.currentMultiplier = Math.floor(raw * 100) / 100;
    }
  } else if (game.phase === 'crashed') {
    if (now >= game.phaseEndsAt) startBetting();
  }
}, 100);

/* ---------------- app ---------------- */

const app = express();
app.use(express.json());

/* ---------------- security headers ---------------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------------- brute-force throttling ----------------
 * After MAX_FAILS failed tries, the key (IP + target) is blocked for BLOCK_MS.
 * This makes guessing a player password or the 4-digit admin PIN impractical. */
const MAX_FAILS = 5;
const BLOCK_MS = 10 * 60 * 1000;
const failMap = new Map(); // key -> { fails, blockedUntil }

function isBlocked(key) {
  const a = failMap.get(key);
  return !!a && a.blockedUntil > Date.now();
}
function recordFail(key) {
  const a = failMap.get(key) || { fails: 0, blockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    a.blockedUntil = Date.now() + BLOCK_MS;
    a.fails = 0;
  }
  failMap.set(key, a);
}
function recordSuccess(key) {
  failMap.delete(key);
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

function publicState() {
  return {
    phase: game.phase,
    roundId: game.roundId,
    multiplier: game.currentMultiplier,
    flightStartedAt: game.flightStartedAt,
    endsInMs: Math.max(0, game.phaseEndsAt - Date.now()),
    crashPoint: game.phase === 'crashed' ? game.crashPoint : null,
    history: game.history,
    players: db.players.map((p) => ({ id: p.id, name: p.name, points: p.points })),
    bets: Array.from(game.bets.values()),
    feed: game.feed.slice(0, 20),
    serverNow: Date.now(),
  };
}

app.get('/api/state', (req, res) => {
  const s = publicState();
  const me = authPlayer(req);
  s.me = me ? publicPlayer(me) : null;
  res.json(s);
});

/* ---------------- player login ---------------- */

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const key = 'login:' + (req.ip || '') + ':' + cleanName;
  if (isBlocked(key)) {
    return res.status(429).json({ error: 'Too many wrong tries — wait 10 minutes and try again' });
  }
  const player = db.players.find((p) => p.name.toLowerCase() === cleanName);
  const passOk = typeof password === 'string' && password.length <= 128 && checkPassword(player, password);
  if (!player || !passOk) {
    recordFail(key);
    return res.status(401).json({ error: 'Wrong name or password' });
  }
  recordSuccess(key);
  const token = createSession(player.id);
  res.json({ ok: true, token, player: publicPlayer(player) });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session'] || (req.body && req.body.session);
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    saveDb();
  }
  res.json({ ok: true });
});

app.post('/api/bet', (req, res) => {
  const { amount } = req.body || {};
  const player = authPlayer(req);
  if (!player) return res.status(401).json({ error: 'Please log in first' });
  if (game.phase !== 'betting') return res.status(400).json({ error: 'Betting window is closed' });
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number' });
  }
  if (amount > player.points) return res.status(400).json({ error: 'Not enough points' });
  if (game.bets.has(player.id)) return res.status(400).json({ error: 'Already bet this round' });

  player.points -= amount;
  saveDb();
  const bet = { playerId: player.id, name: player.name, amount, cashedAt: null, payout: null };
  game.bets.set(player.id, bet);
  pushFeed({ type: 'bet', playerId: player.id, name: player.name, amount, roundId: game.roundId });
  res.json({ ok: true, bet, points: player.points });
});

app.post('/api/cashout', (req, res) => {
  const player = authPlayer(req);
  if (!player) return res.status(401).json({ error: 'Please log in first' });
  if (game.phase !== 'flying') return res.status(400).json({ error: 'Plane is not flying' });
  const bet = game.bets.get(player.id);
  if (!bet) return res.status(400).json({ error: 'No active bet this round' });
  if (bet.cashedAt !== null) return res.status(400).json({ error: 'Already cashed out' });

  const mult = game.currentMultiplier;
  const payout = Math.floor(bet.amount * mult);
  bet.cashedAt = mult;
  bet.payout = payout;
  player.points += payout;
  saveDb();
  pushFeed({
    type: 'cashout', playerId: player.id, name: player.name,
    amount: bet.amount, mult, payout, roundId: game.roundId,
  });
  res.json({ ok: true, payout, mult, points: player.points });
});

/* ---------------- admin API (PIN required) ---------------- */

function requirePin(req, res, next) {
  const key = 'pin:' + (req.ip || '');
  if (isBlocked(key)) {
    return res.status(429).json({ error: 'Too many wrong PIN tries — wait 10 minutes' });
  }
  const pin = req.headers['x-admin-pin'] || (req.body && req.body.pin);
  if (pin !== ADMIN_PIN) {
    recordFail(key);
    return res.status(401).json({ error: 'Wrong admin PIN' });
  }
  recordSuccess(key);
  next();
}

app.get('/api/admin/players', requirePin, (req, res) => {
  res.json({
    players: db.players.map((p) => ({
      id: p.id, name: p.name, points: p.points, hasPassword: !!p.passHash,
    })),
  });
});

app.post('/api/admin/players', requirePin, (req, res) => {
  const { name, startingPoints, password } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Name is required' });
  if (cleanName.length > 24) return res.status(400).json({ error: 'Name too long (max 24 chars)' });
  if (db.players.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
    return res.status(400).json({ error: 'That name is already used — pick another' });
  }
  if (typeof password !== 'string' || password.length < 4 || password.length > 64) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const start = startingPoints === undefined ? 1000 : startingPoints;
  if (!Number.isInteger(start) || start < 0) {
    return res.status(400).json({ error: 'Starting points must be a whole number >= 0' });
  }
  const player = { id: db.nextId++, name: cleanName, points: start };
  setPlayerPassword(player, password);
  db.players.push(player);
  saveDb();
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/admin/setpassword', requirePin, (req, res) => {
  const { playerId, password } = req.body || {};
  const player = findPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (typeof password !== 'string' || password.length < 4 || password.length > 64) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  setPlayerPassword(player, password);
  // log the player out everywhere so only the new password works from now on
  dropSessionsFor(player.id);
  saveDb();
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/admin/add', requirePin, (req, res) => {
  const { playerId, amount } = req.body || {};
  const player = findPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number' });
  }
  player.points += amount;
  saveDb();
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/admin/remove', requirePin, (req, res) => {
  const { playerId, amount } = req.body || {};
  const player = findPlayer(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number' });
  }
  player.points = Math.max(0, player.points - amount);
  saveDb();
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/admin/delete', requirePin, (req, res) => {
  const { playerId } = req.body || {};
  const idx = db.players.findIndex((p) => p.id === Number(playerId));
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });
  const [removed] = db.players.splice(idx, 1);
  game.bets.delete(removed.id);
  dropSessionsFor(removed.id);
  saveDb();
  res.json({ ok: true, removed: publicPlayer(removed) });
});

initDb()
  .then(() => {
    saveDb(); // local file exists from the start + mirrors current state to the cloud
    app.listen(PORT, () => {
      console.log(`Aviator points game listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
