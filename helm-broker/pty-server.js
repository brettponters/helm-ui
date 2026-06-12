#!/usr/bin/env node
/**
 * Helm PTY Server
 * Spawns a real pseudo-terminal per panel so each Helm panel runs a genuine
 * shell. The browser renders it with xterm.js.
 *
 * Sessions are PERSISTENT: they are keyed by teammate id and survive the
 * websocket (and the whole Helm app) going away. On disconnect the shell keeps
 * running and its output accumulates in a ring buffer; when the panel
 * reconnects it reattaches to the same shell and the recent output is
 * replayed. Closing Helm therefore no longer kills your agents, the app is
 * just a window onto shells owned by this daemon.
 *
 * Protocol:
 *   client -> server : { type: 'input',  data: string }
 *                      { type: 'resize', cols: number, rows: number }
 *                      { type: 'kill' }              explicitly end the session
 *   server -> client : { type: 'output', data: string }
 *                      { type: 'status', claudeActive: boolean }
 *                      { type: 'exit',   code: number, signal?: number }
 *
 * Connection params (query string):
 *   id      stable teammate id, the session key. Connections without an id
 *           get a legacy ephemeral session (dies with the socket).
 *   cwd     working directory for the shell (~ is expanded). If a session
 *           exists for this id but with a different cwd, the old shell is
 *           replaced (changing a team's directory means a fresh shell).
 *   cmd     program to run instead of the login shell (optional)
 *   name    agent name, surfaced to the shell as HELM_AGENT (optional)
 *   team    team id, used so any claude launched inside registers with the
 *           Helm broker under the right team (optional)
 */

import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import os from 'os';
import { execFile } from 'child_process';

const PORT = parseInt(process.env.HELM_PTY_PORT || '7901', 10);
const BROKER_PORT = parseInt(process.env.HELM_BROKER_PORT || process.env.CLAUDE_PEERS_PORT || '7900', 10);
const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';
const HOME = os.homedir();
const CLAUDE_SCAN_MS = 1500;            // how often to check which sessions have a live Claude
const REPLAY_BUFFER_BYTES = 256 * 1024; // recent output kept per session for reattach

// Persistent sessions: key -> { id, name, team, cwd, term, ws, chunks, buflen, claudeActive }
// ws is null while detached (no panel looking at it); the shell runs regardless.
const sessions = new Map();

function sessionSend(s, obj) {
  if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(obj));
}

function bufferOutput(s, data) {
  s.chunks.push(data);
  s.buflen += data.length;
  while (s.buflen > REPLAY_BUFFER_BYTES && s.chunks.length > 1) {
    s.buflen -= s.chunks.shift().length;
  }
}

function endSession(s, why) {
  try { s.term.kill(); } catch { /* already dead */ }
  sessions.delete(s.key);
  console.log(`[helm-pty] session ${s.key} ended (${why}), ${sessions.size} live`);
}

// ─── Claude liveness scan ─────────────────────────────────────────────────────
// One pass over the process table tells every session whether a Claude CLI is
// running under its shell, so the UI can show when Claude Code is active there.

function looksLikeClaude(args) {
  return /(^|\/)claude(\s|$)/.test(args);
}

function scanClaude() {
  if (sessions.size === 0) return;
  execFile('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err) return;
    const kids = new Map();   // ppid -> [pid]
    const argv = new Map();   // pid  -> args
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      argv.set(pid, m[3]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const hasClaude = (root) => {
      const stack = [...(kids.get(root) || [])];
      while (stack.length) {
        const pid = stack.pop();
        if (looksLikeClaude(argv.get(pid) || '')) return true;
        for (const c of kids.get(pid) || []) stack.push(c);
      }
      return false;
    };
    for (const s of sessions.values()) {
      const active = s.term.pid != null && hasClaude(s.term.pid);
      if (active !== s.claudeActive) {
        s.claudeActive = active;
        sessionSend(s, { type: 'status', claudeActive: active });
      }
    }
  });
}

setInterval(scanClaude, CLAUDE_SCAN_MS).unref?.();

// ─── Connection handling ──────────────────────────────────────────────────────

// Browser security: a WebSocket here drives a real shell, so only accept
// connections from the Helm UI. Browsers always send Origin on the WS handshake
// and JS cannot forge it, so a malicious page on another origin is rejected.
// Connections with no Origin (non-browser tooling) are allowed.
const ALLOWED_ORIGINS = (process.env.HELM_ALLOWED_ORIGINS ||
  'http://localhost:5199,http://127.0.0.1:5199').split(',').map(s => s.trim());

function verifyClient(info) {
  const origin = info.origin;
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function expandHome(p) {
  if (!p) return HOME;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return HOME + p.slice(1);
  return p;
}

function parseParams(url) {
  const q = new URL(url, 'http://localhost').searchParams;
  return {
    id:   q.get('id') || '',
    cwd:  expandHome(q.get('cwd') || HOME),
    cmd:  q.get('cmd') || '',
    name: q.get('name') || '',
    team: q.get('team') || '',
  };
}

function spawnShell({ cwd, cmd, name, team }) {
  // A panel is a clean, real terminal. If Helm itself was launched from inside
  // a Claude Code session, the daemon inherited CLAUDECODE / CLAUDE_CODE_* -
  // strip them so a `claude` typed in a panel doesn't think it's nested.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }

  // Identify this panel to Helm's own messaging layer (helm-teammates). Helm uses
  // HELM_BROKER_PORT, deliberately NOT CLAUDE_PEERS_PORT, so a separately
  // installed claude-peers network stays completely independent and unaffected.
  env.HELM_BROKER_PORT = String(BROKER_PORT);
  env.HELM_TEAMMATE    = name;
  env.HELM_TEAM        = team;
  env.TERM             = 'xterm-256color';

  // Spawn a login shell by default. If a command is supplied, run it through
  // the shell with -lc so PATH and rc files are honored.
  const args = cmd ? ['-lc', cmd] : ['-l'];
  return pty.spawn(DEFAULT_SHELL, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env,
  });
}

function createSession(key, params) {
  const term = spawnShell(params);
  const s = {
    key,
    id: params.id,
    name: params.name,
    team: params.team,
    cwd: params.cwd,
    term,
    ws: null,
    chunks: [],
    buflen: 0,
    claudeActive: false,
  };
  sessions.set(key, s);

  term.onData(data => {
    bufferOutput(s, data);
    sessionSend(s, { type: 'output', data });
  });

  term.onExit(({ exitCode, signal }) => {
    sessionSend(s, { type: 'exit', code: exitCode, signal });
    if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.close();
    sessions.delete(s.key);
    console.log(`[helm-pty] session ${s.key} shell exited (${exitCode}), ${sessions.size} live`);
  });

  return s;
}

// The "listening" log must come from the listening event, not module level -
// binding is async, and logging early lets a fast client connect into nothing.
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1', verifyClient }, () => {
  console.log(`[helm-pty] listening on ws://127.0.0.1:${PORT} (shell: ${DEFAULT_SHELL}, broker: ${BROKER_PORT}, persistent sessions)`);
});

wss.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // Another pty daemon already owns the shells, defer to it. This is what
    // lets the app relaunch and find its sessions still alive.
    console.log(`[helm-pty] port ${PORT} already in use, deferring to the running daemon`);
    process.exit(0);
  }
  console.error(`[helm-pty] ${err.message}`);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  const params = parseParams(req.url);
  // Sessions are keyed by teammate id; no id means a throwaway connection.
  const key = params.id ? `${params.team || 'default'}/${params.id}` : `ephemeral/${Math.random().toString(36).slice(2)}`;

  let s = sessions.get(key);

  // The team moved to a different directory: that means a fresh shell there,
  // matching the UI behavior that a cwd change restarts the panel.
  if (s && s.cwd !== params.cwd) {
    endSession(s, 'cwd changed');
    s = undefined;
  }

  if (s) {
    // Reattach: one panel per session, a newer window wins the connection.
    if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.close();
    s.ws = ws;
    if (s.buflen > 0) ws.send(JSON.stringify({ type: 'output', data: s.chunks.join('') }));
    ws.send(JSON.stringify({ type: 'status', claudeActive: s.claudeActive }));
    console.log(`[helm-pty] reattached ${key}`);
  } else {
    try {
      s = createSession(key, params);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mhelm: failed to start shell: ${String(err)}\x1b[0m\r\n` }));
      ws.close();
      return;
    }
    s.ws = ws;
  }

  const session = s;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      try { session.term.resize(msg.cols, msg.rows); } catch { /* terminal already gone */ }
    } else if (msg.type === 'kill') {
      // Explicit removal from the UI, the only client-driven way a shell dies.
      endSession(session, 'killed by client');
      try { ws.close(); } catch { /* already closing */ }
    }
  });

  ws.on('close', () => {
    if (session.ws === ws) session.ws = null;
    // Persistent sessions detach and keep running; only id-less ephemeral
    // connections die with their socket (legacy / browser-tab behavior).
    if (!session.id && sessions.has(session.key)) {
      endSession(session, 'ephemeral disconnect');
    }
  });
});

// The daemon owns live shells: SIGTERM/SIGINT end it (and them) deliberately,
// e.g. on logout or an explicit stop, but never just because a window closed.
process.on('SIGTERM', () => { wss.close(); process.exit(0); });
process.on('SIGINT',  () => { wss.close(); process.exit(0); });
