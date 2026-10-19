'use strict';
// Smoke test: starts the server on a temp dir and exercises every endpoint.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agri-'));
const B = `http://127.0.0.1:${PORT}`;

async function call(method, p, { tok, body } = {}) {
  const r = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { s: r.status, j };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 30; i++) { try { await call('GET', '/api/health'); break; } catch (_) { await wait(100); } }
    let r;

    r = await call('GET', '/api/config'); assert.equal(r.j.ownerSet, false);

    // farmers
    r = await call('POST', '/api/users', { body: { id: '1700000000001', name: 'Ali', phone: '0300', city: 'Multan', acres: 12, crop: 'cotton' } });
    assert.equal(r.s, 201); const tokA = r.j.token;
    r = await call('POST', '/api/users', { body: { id: '1700000000001', name: 'Dup' } }); assert.equal(r.s, 409);
    r = await call('POST', '/api/users', { body: { id: '1700000000002', name: 'Bashir', acres: 5, crop: 'wheat' } });
    const tokB = r.j.token; assert.equal(r.s, 201);
    r = await call('POST', '/api/users', { body: { id: 'x', name: 'bad' } }); assert.equal(r.s, 400);

    const data = { hist: [{ id: 1, crop: 'cotton', dis: 0, th: 'data:image/jpeg;base64,AAAA' }, { id: 2, crop: 'cotton', dis: -1 }], jobs: [{ id: 5, t: 'spray', f: 'F1', a: 3, d: '2026-10-20', k: false }], mon: [{ id: 9, c: 'seed', f: 'F1', a: 5000, d: '2026-10-01' }] };
    r = await call('PUT', '/api/users/1700000000001/data', { tok: tokA, body: data }); assert.equal(r.s, 200);
    r = await call('PUT', '/api/users/1700000000001/data', { tok: tokB, body: data }); assert.equal(r.s, 401);
    r = await call('PUT', '/api/users/1700000000001', { tok: tokA, body: { name: 'Ali Khan', acres: 15 } }); assert.equal(r.s, 200);
    r = await call('GET', '/api/users/1700000000001/data', { tok: tokA }); assert.equal(r.j.profile.name, 'Ali Khan'); assert.equal(r.j.hist.length, 2);
    r = await call('GET', '/api/users/1700000000099/data', { tok: tokA }); assert.equal(r.s, 404);

    // owner
    r = await call('GET', '/api/owner/summary'); assert.equal(r.s, 401);
    r = await call('POST', '/api/owner/login', { body: { pin: 'abc' } }); assert.equal(r.s, 400);
    r = await call('POST', '/api/owner/login', { body: { pin: '4321' } }); assert.equal(r.s, 200); assert.ok(r.j.created);
    r = await call('POST', '/api/owner/login', { body: { pin: '1111' } }); assert.equal(r.s, 401);
    r = await call('POST', '/api/owner/login', { body: { pin: '4321' } }); assert.equal(r.s, 200);
    const o = r.j.token;

    r = await call('GET', '/api/owner/summary', { tok: o });
    assert.equal(r.j.users.length, 2);
    const ali = r.j.users.find((u) => u.profile.id === '1700000000001');
    assert.equal(ali.profile.acres, 15); assert.ok(!('th' in ali.hist[0]), 'thumbnails stripped');

    r = await call('PUT', '/api/owner/settings', { tok: o, body: { name: 'Safia', lang: 'ur', good: 85, fair: 55 } }); assert.equal(r.s, 200);
    r = await call('PUT', '/api/owner/settings', { tok: o, body: { good: 40, fair: 50 } }); assert.equal(r.s, 400);
    r = await call('GET', '/api/config'); assert.equal(r.j.defaultLang, 'ur'); assert.equal(r.j.ownerSet, true);

    r = await call('POST', '/api/owner/pin', { tok: o, body: { oldPin: '0000', newPin: '9999' } }); assert.equal(r.s, 403);
    r = await call('POST', '/api/owner/pin', { tok: o, body: { oldPin: '4321', newPin: '9999' } }); assert.equal(r.s, 200);
    r = await call('POST', '/api/owner/login', { body: { pin: '4321' } }); assert.equal(r.s, 401);
    r = await call('POST', '/api/owner/login', { body: { pin: '9999' } }); assert.equal(r.s, 200);

    r = await call('GET', '/api/owner/export', { tok: o }); assert.equal(r.j.users.length, 2);

    r = await call('DELETE', '/api/owner/users/1700000000002', { tok: o }); assert.equal(r.s, 200);
    r = await call('PUT', '/api/users/1700000000002/data', { tok: tokB, body: data }); assert.equal(r.s, 410);
    r = await call('POST', '/api/users', { body: { id: '1700000000002', name: 'Back' } }); assert.equal(r.s, 410);

    r = await call('POST', '/api/owner/wipe', { tok: o, body: {} }); assert.equal(r.s, 400);
    r = await call('POST', '/api/owner/wipe', { tok: o, body: { confirm: true } }); assert.equal(r.j.deleted, 1);

    // lockout after 5 wrong PINs
    for (let i = 0; i < 5; i++) await call('POST', '/api/owner/login', { body: { pin: '0001' } });
    r = await call('POST', '/api/owner/login', { body: { pin: '9999' } }); assert.equal(r.s, 429);

    // persistence across restart
    srv.kill('SIGTERM'); await wait(500);
    const db = JSON.parse(fs.readFileSync(path.join(DIR, 'db.json'), 'utf8'));
    assert.ok(db.owner && db.owner.hash && !JSON.stringify(db).includes('9999'), 'PIN stored hashed');
    assert.equal(db.settings.name, 'Safia');

    console.log('\nAll backend tests passed.');
  } catch (e) {
    console.error('\nTEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(DIR, { recursive: true, force: true });
  }
})();
