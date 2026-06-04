#!/usr/bin/env node
/**
 * Helm PTY Server
 * Spawns a real pseudo-terminal per WebSocket connection so each Helm panel
 * runs a genuine shell. The browser renders it with xterm.js.
 *
 * Protocol:
 *   client -> server : { type: 'input',  data: string }
 *                      { type: 'resize', cols: number, rows: number }
 *   server -> client : { type: 'output', data: string }
 *                      { type: 'exit',   code: number, signal?: number }
 *
 * Connection params (query string):
 *   cwd     working directory for the shell (~ is expanded)
 *   cmd     program to run instead of the login shell (optional)
 *   name    agent name, surfaced to the shell as HELM_AGENT (optional)
 *   team    team id, used so any claude launched inside registers with the
 *           Helm broker under the right team (optional)
 */

import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import os from 'os';

const PORT = parseInt(process.env.HELM_PTY_PORT || '7901', 10);
const BROKER_PORT = parseInt(process.env.HELM_BROKER_PORT || process.env.CLAUDE_PEERS_PORT || '7900', 10);
const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';
const HOME = os.homedir();

// Browser security: a WebSocket here spawns a real shell, so only accept
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
    cwd:  expandHome(q.get('cwd') || HOME),
    cmd:  q.get('cmd') || '',
    name: q.get('name') || '',
    team: q.get('team') || '',
  };
}

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1', verifyClient });

wss.on('connection', (ws, req) => {
  const { cwd, cmd, name, team } = parseParams(req.url);

  // A panel is a clean, real terminal. If Helm itself was launched from inside
  // a Claude Code session, the server inherited CLAUDECODE / CLAUDE_CODE_* -
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
  const file = DEFAULT_SHELL;
  const args = cmd ? ['-lc', cmd] : ['-l'];

  let term;
  try {
    term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mhelm: failed to start shell: ${String(err)}\x1b[0m\r\n` }));
    ws.close();
    return;
  }

  const onData = term.onData(data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  const onExit = term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal }));
      ws.close();
    }
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      try { term.resize(msg.cols, msg.rows); } catch { /* terminal already gone */ }
    }
  });

  ws.on('close', () => {
    onData.dispose();
    onExit.dispose();
    try { term.kill(); } catch { /* already dead */ }
  });
});

console.log(`[helm-pty] listening on ws://127.0.0.1:${PORT} (shell: ${DEFAULT_SHELL}, broker: ${BROKER_PORT})`);

process.on('SIGTERM', () => { wss.close(); process.exit(0); });
process.on('SIGINT',  () => { wss.close(); process.exit(0); });
