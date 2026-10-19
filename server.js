'use strict';
/**
 * AgriDrone Analytics — backend
 * Zero dependencies (Node >= 18). Stores everything in one JSON file.
 *
 *   node server.js
 *
 * Env: PORT, DATA_DIR, OWNER_PIN (initial 4-digit owner PIN), CORS_ORIGIN, TRUST_PROXY=1
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_USERS = 20000;
const CROPS = ['wheat', 'cotton', 'rice', 'maize', 'sugarcane', 'other'];
const DEFAULT_SETTINGS = { name: '', lang: 'en', good: 80, fair: 60 };

/* ---------------------------------------------------------------- storage */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { owner: null, settings: { ...DEFAULT_SETTINGS }, users: {}, deleted: [] };
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { ...db, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
} catch (e) {
  if (e.code !== 'ENOENT') {
    const bak = DB_FILE + '.corrupt-' + Date.now();
    try { fs.copyFileSync(DB_FILE, bak); } catch (_) {}
    console.error('db.json unreadable, backed up to', bak, '-', e.message);
  }
}
const gone = new Set(db.deleted);

let timer = null;
function save() { if (!timer) timer = setTimeout(flush, 300); }
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  db.deleted = [...gone].slice(-50000);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch (_) {} process.exit(0); });

/* ----------------------------------------------------------------- crypto */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);
function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.owner = { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
  save();
}
function checkPin(pin) {
  if (!db.owner) return false;
  const a = crypto.scryptSync(pin, db.owner.salt, 32);
  const b = Buffer.from(db.owner.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (!db.owner && validPin(process.env.OWNER_PIN || '')) { setPin(process.env.OWNER_PIN); console.log('Owner PIN set from OWNER_PIN'); }

const sessions = new Map(); // owner token -> expiry
function newOwnerToken() {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + 12 * 3600e3);
  return t;
}
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
function isOwner(req) {
  const t = bearer(req), e = sessions.get(t);
  if (!e) return false;
  if (e < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function userTokenOk(req, u) {
  const t = bearer(req);
  if (!t) return false;
  const a = Buffer.from(sha(t)), b = Buffer.from(u.tok);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ----------------------------------------------------------- rate limiting */
const buckets = new Map();
function hit(key, max, win) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + win }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
const locked = (key, max) => { const b = buckets.get(key); return !!b && b.reset > Date.now() && b.n >= max; };
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); }, 60000).unref();

/* ---------------------------------------------------------------- helpers */
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const arr = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, max) : []);
function cleanProfile(b, id) {
  const acres = Number(b.acres);
  return {
    id,
    name: str(b.name, 80),
    phone: str(b.phone, 30),
    city: str(b.city, 80),
    acres: Number.isFinite(acres) ? Math.min(Math.max(acres, 0), 1e6) : 0,
    crop: CROPS.includes(b.crop) ? b.crop : 'wheat',
    created: str(b.created, 10) || new Date().toISOString().slice(0, 10),
    pic: typeof b.pic === 'string' && b.pic.length <= 90000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(b.pic) ? b.pic : undefined,
  };
}
const stripThumbs = (hist) => hist.map(({ th, ...r }) => r);
const corsHeaders = () => ({
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0, over = false;
    const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > MAX_BODY) over = true; else chunks.push(d); });
    req.on('end', () => {
      if (over) return reject(Object.assign(new Error('payload too large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch (_) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const clientIp = (req) => (TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

let idx = { mtime: 0 };
function loadIndex() {
  const st = fs.statSync(INDEX_FILE);
  if (st.mtimeMs !== idx.mtime) {
    const raw = fs.readFileSync(INDEX_FILE);
    idx = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + sha(raw).slice(0, 16) + '"' };
  }
  return idx;
}
function serveIndex(req, res) {
  let f;
  try { f = loadIndex(); } catch (_) { return send(res, 404, { error: 'public/index.html missing' }); }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: f.etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? f.gz : f.raw;
  res.writeHead(200, { ...h, 'Content-Length': body.length, ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ------------------------------------------------------------------ routes */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const M = req.method;
    const ip = clientIp(req);

    if (M === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
    if (p === '/' || p === '/index.html') return serveIndex(req, res);
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    if (p === '/api/health' && M === 'GET') return send(res, 200, { ok: true, time: Date.now(), users: Object.keys(db.users).length });
    if (p === '/api/config' && M === 'GET') return send(res, 200, { ownerSet: !!db.owner, defaultLang: db.settings.lang });

    /* ---- farmers ---- */
    if (p === '/api/users' && M === 'POST') {
      if (!hit('reg:' + ip, 30, 3600e3)) return send(res, 429, { error: 'too many registrations' });
      const b = await readBody(req);
      const id = str(b.id, 40);
      if (!/^[\w-]{6,40}$/.test(id)) return send(res, 400, { error: 'bad id' });
      if (gone.has(id)) return send(res, 410, { error: 'deleted' });
      if (db.users[id]) return send(res, 409, { error: 'exists' });
      const profile = cleanProfile(b, id);
      if (!profile.name) return send(res, 400, { error: 'name required' });
      if (Object.keys(db.users).length >= MAX_USERS) return send(res, 503, { error: 'user limit reached' });
      const token = crypto.randomBytes(24).toString('hex');
      db.users[id] = { profile, tok: sha(token), hist: [], jobs: [], mon: [], updated: Date.now() };
      save();
      return send(res, 201, { id, token });
    }
    let m = p.match(/^\/api\/users\/([\w-]{6,40})(\/data)?$/);
    if (m) {
      const id = m[1], isData = !!m[2];
      if (gone.has(id)) return send(res, 410, { error: 'deleted' });
      const u = db.users[id];
      if (!u) return send(res, 404, { error: 'unknown user' });
      if (!userTokenOk(req, u)) return send(res, 401, { error: 'bad token' });
      if (!isData && M === 'PUT') {
        const b = await readBody(req);
        const pr = cleanProfile({ ...u.profile, ...b }, id);
        if (!pr.name) return send(res, 400, { error: 'name required' });
        pr.created = u.profile.created;
        u.profile = pr; u.updated = Date.now(); save();
        return send(res, 200, { ok: true });
      }
      if (isData && M === 'PUT') {
        const b = await readBody(req);
        u.hist = arr(b.hist, 50); u.jobs = arr(b.jobs, 500); u.mon = arr(b.mon, 2000);
        u.updated = Date.now(); save();
        return send(res, 200, { ok: true, updated: u.updated });
      }
      if (isData && M === 'GET') return send(res, 200, { profile: u.profile, hist: u.hist, jobs: u.jobs, mon: u.mon });
      return send(res, 405, { error: 'method not allowed' });
    }

    /* ---- owner ---- */
    if (p === '/api/owner/login' && M === 'POST') {
      const key = 'fail:' + ip;
      if (locked(key, 5)) return send(res, 429, { error: 'locked' });
      const b = await readBody(req);
      if (!validPin(b.pin)) return send(res, 400, { error: 'PIN must be 4 digits' });
      if (!db.owner) { setPin(b.pin); return send(res, 200, { token: newOwnerToken(), created: true }); }
      if (!checkPin(b.pin)) { hit(key, 5, 5 * 60e3); return send(res, 401, { error: 'wrong PIN' }); }
      buckets.delete(key);
      return send(res, 200, { token: newOwnerToken() });
    }
    if (p.startsWith('/api/owner/')) {
      if (!isOwner(req)) return send(res, 401, { error: 'owner login required' });

      if (p === '/api/owner/summary' && M === 'GET') {
        const users = Object.values(db.users).map((u) => ({ profile: u.profile, hist: stripThumbs(u.hist), jobs: u.jobs, mon: u.mon, updated: u.updated }));
        return send(res, 200, { users, settings: db.settings });
      }
      if (p === '/api/owner/export' && M === 'GET') {
        const users = Object.values(db.users).map((u) => ({ profile: u.profile, hist: stripThumbs(u.hist), jobs: u.jobs, mon: u.mon, updated: u.updated }));
        return send(res, 200, { exported: new Date().toISOString(), settings: db.settings, users });
      }
      if (p === '/api/owner/settings' && M === 'GET') return send(res, 200, db.settings);
      if (p === '/api/owner/settings' && M === 'PUT') {
        const b = await readBody(req);
        const out = { ...db.settings };
        if ('name' in b) out.name = str(b.name, 40);
        if ('lang' in b) { if (!['en', 'ur'].includes(b.lang)) return send(res, 400, { error: 'bad language' }); out.lang = b.lang; }
        const good = Number('good' in b ? b.good : out.good), fair = Number('fair' in b ? b.fair : out.fair);
        if (![good, fair].every((x) => Number.isInteger(x) && x >= 0 && x <= 100) || good <= fair) return send(res, 400, { error: 'thresholds: healthy must be higher than fair (0-100)' });
        out.good = good; out.fair = fair;
        db.settings = out; save();
        return send(res, 200, out);
      }
      if (p === '/api/owner/pin' && M === 'POST') {
        const key = 'fail:' + ip;
        if (locked(key, 5)) return send(res, 429, { error: 'locked' });
        const b = await readBody(req);
        if (!validPin(b.oldPin) || !validPin(b.newPin)) return send(res, 400, { error: 'PINs must be 4 digits' });
        if (!checkPin(b.oldPin)) { hit(key, 5, 5 * 60e3); return send(res, 403, { error: 'wrong current PIN' }); }
        setPin(b.newPin);
        return send(res, 200, { ok: true });
      }
      m = p.match(/^\/api\/owner\/users\/([\w-]{6,40})$/);
      if (m && M === 'DELETE') {
        if (!db.users[m[1]]) return send(res, 404, { error: 'unknown user' });
        delete db.users[m[1]]; gone.add(m[1]); save();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/owner/wipe' && M === 'POST') {
        const b = await readBody(req);
        if (b.confirm !== true) return send(res, 400, { error: 'confirm required' });
        const n = Object.keys(db.users).length;
        for (const id of Object.keys(db.users)) gone.add(id);
        db.users = {}; save();
        return send(res, 200, { ok: true, deleted: n });
      }
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = typeof e.status === 'number' ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'server error' : e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AgriDrone backend on http://localhost:${PORT}  (data: ${DB_FILE})`);
  if (!db.owner) console.log('No owner PIN yet: the first owner login will set it (or start with OWNER_PIN=1234).');
});
