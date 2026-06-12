#!/usr/bin/env node
/**
 * Integration tests for the persistent PTY daemon. Spawns the real server on a
 * test port and drives it with real websockets and real shells.
 * Run: node --test helm-broker/pty-server.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import WebSocket from 'ws';

const PORT = 7955;
const HERE = path.dirname(fileURLToPath(import.meta.url));

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(HERE, 'pty-server.js')], {
    env: { ...process.env, HELM_PTY_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pty server did not boot')), 8000);
    server.stdout.on('data', d => {
      if (String(d).includes('listening')) { clearTimeout(t); resolve(); }
    });
  });
});

after(() => {
  try { server.kill('SIGTERM'); } catch { /* already gone */ }
});

// Connect a panel: returns { ws, output(), waitFor(substr), send(obj), close() }.
function connect(id, cwd = '/tmp') {
  const params = new URLSearchParams({ id, cwd, team: 'test-team', name: id });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?${params}`);
  let buf = '';
  const waiters = [];
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'output') {
      buf += msg.data;
      for (const w of [...waiters]) {
        if (buf.includes(w.substr)) { w.resolve(buf); waiters.splice(waiters.indexOf(w), 1); }
      }
    }
  });
  return {
    ws,
    opened: new Promise(r => ws.on('open', r)),
    output: () => buf,
    waitFor: (substr, ms = 15000) => new Promise((resolve, reject) => {
      if (buf.includes(substr)) return resolve(buf);
      const w = { substr, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timed out waiting for "${substr}" in:\n${buf.slice(-500)}`)), ms);
    }),
    send: obj => ws.send(JSON.stringify(obj)),
    close: () => new Promise(r => { ws.on('close', r); ws.close(); }),
  };
}

test('session survives disconnect: reattach replays output, shell still live', async () => {
  const a = await (async () => { const c = connect('tm-survive'); await c.opened; return c; })();
  a.send({ type: 'input', data: 'echo MARKER_ALPHA\r' });
  await a.waitFor('MARKER_ALPHA');
  await a.close();

  // Simulate the app coming back: same teammate id, fresh socket.
  const b = connect('tm-survive');
  await b.opened;
  await b.waitFor('MARKER_ALPHA'); // replayed from the ring buffer
  b.send({ type: 'input', data: 'echo MARKER_BETA\r' });
  await b.waitFor('MARKER_BETA');  // the SAME shell answered, it never died
  b.send({ type: 'kill' });
  await b.close();
});

test('kill actually ends the session: reconnect gets a fresh shell', async () => {
  const a = connect('tm-kill');
  await a.opened;
  a.send({ type: 'input', data: 'echo MARKER_DOOMED\r' });
  await a.waitFor('MARKER_DOOMED');
  a.send({ type: 'kill' });
  await a.close();

  const b = connect('tm-kill');
  await b.opened;
  b.send({ type: 'input', data: 'echo MARKER_FRESH\r' });
  await b.waitFor('MARKER_FRESH');
  assert.ok(!b.output().includes('MARKER_DOOMED'), 'old shell output must not replay after kill');
  b.send({ type: 'kill' });
  await b.close();
});

test('cwd change replaces the shell instead of reattaching', async () => {
  const a = connect('tm-move', '/tmp');
  await a.opened;
  a.send({ type: 'input', data: 'echo MARKER_OLDDIR\r' });
  await a.waitFor('MARKER_OLDDIR');
  await a.close();

  const b = connect('tm-move', process.env.HOME || '/');
  await b.opened;
  b.send({ type: 'input', data: 'pwd\r' });
  await b.waitFor(process.env.HOME || '/');
  assert.ok(!b.output().includes('MARKER_OLDDIR'), 'moved team must get a fresh shell');
  b.send({ type: 'kill' });
  await b.close();
});
