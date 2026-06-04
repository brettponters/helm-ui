#!/usr/bin/env node
/**
 * Helm Broker
 * Team-scoped peer discovery and messaging for AI agents.
 *
 * Forked from claude-peers-mcp (MIT, louislva/claude-peers-mcp)
 * Modified for team isolation, broadcast, and Helm UI integration.
 *
 * Compatible with claude-peers CLAUDE_PEERS_PORT env var.
 * Set HELM_BROKER_PORT or CLAUDE_PEERS_PORT to override default 7900.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = parseInt(process.env.HELM_BROKER_PORT || process.env.CLAUDE_PEERS_PORT || '7900', 10);
const STALE_MS = 45000;
const HEARTBEAT_INTERVAL = 30000;

// Browser security: only the Helm UI may drive the broker from a browser.
// Requests with no Origin header (the MCP servers, curl, other local tooling)
// are allowed; requests from any other browser origin are rejected so a
// malicious page can't enumerate the filesystem or mutate the workspace.
const ALLOWED_ORIGINS = (process.env.HELM_ALLOWED_ORIGINS ||
  'http://localhost:5199,http://127.0.0.1:5199').split(',').map(s => s.trim());

function originAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// Persisted workspace config (teams, teammates, UI prefs). Live PTY sessions are
// recreated from this on load; the config itself is the durable source of truth
// and the surface a future control-MCP mutates.
const HELM_DIR = process.env.HELM_HOME || path.join(os.homedir(), '.helm');
const WORKSPACE_FILE = process.env.HELM_WORKSPACE_FILE || path.join(HELM_DIR, 'workspace.json');

function loadWorkspace() {
  try { return JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); }
  catch { return null; }
}

function saveWorkspace(ws) {
  fs.mkdirSync(path.dirname(WORKSPACE_FILE), { recursive: true });
  const tmp = `${WORKSPACE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ws, null, 2));
  fs.renameSync(tmp, WORKSPACE_FILE); // atomic replace
}

function isValidWorkspace(ws) {
  return !!ws && Array.isArray(ws.teams) &&
    ws.teams.every(t => t && typeof t.id === 'string' && Array.isArray(t.teammates));
}

// ─── Live preview: most-recently-modified source file in a teammate's cwd ─────

const PREVIEW_SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', '.helm', '.next', '.cache',
  '.turbo', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.idea', '.vscode',
]);
// Non-previewable junk we never want to surface as "recent work".
const PREVIEW_SKIP_EXT = new Set([
  '.ico', '.icns', '.zip', '.gz', '.tar', '.lock', '.map', '.node', '.woff', '.woff2',
  '.ttf', '.otf', '.mp4', '.mov', '.mp3', '.wav', '.bin', '.exe', '.dylib', '.so',
  '.class', '.o', '.a',
]);
const PREVIEW_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const PREVIEW_MAX_FILES = 8000;       // bound the scan cost on big trees
const PREVIEW_MAX_BYTES = 256 * 1024; // cap returned text content

function previewKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (PREVIEW_IMAGE_EXT.has(ext)) return 'image';
  return 'text';
}

const FILE_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

const TREE_MAX_FILES = 3000;

// Flat list of browsable files under cwd (the UI builds the tree). Skips heavy
// dirs and junk extensions; each entry carries mtime + kind for sorting/icons.
function listFiles(cwd) {
  const root = expandPreviewHome(cwd);
  const files = [];
  const stack = [root];
  let truncated = false;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (PREVIEW_SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue;
        if (PREVIEW_SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (files.length >= TREE_MAX_FILES) { truncated = true; continue; }
        const full = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        files.push({
          relPath: path.relative(root, full),
          name: e.name,
          kind: previewKind(e.name),
          mtime: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { root, files, truncated };
}

// Content/kind for a specific file the user clicked (text inline; pdf/image via /file).
function fileMeta(cwd, relPath) {
  const root = path.resolve(expandPreviewHome(cwd));
  const full = path.resolve(root, relPath || '');
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  let st;
  try { st = fs.statSync(full); if (!st.isFile()) return null; } catch { return null; }
  const name = path.basename(full);
  const kind = previewKind(name);
  const base = { relPath: path.relative(root, full), name, kind, mtime: new Date(st.mtimeMs).toISOString(), size: st.size };
  if (kind !== 'text') return base;
  try {
    const buf = fs.readFileSync(full);
    const truncated = buf.length > PREVIEW_MAX_BYTES;
    return { ...base, truncated, content: (truncated ? buf.subarray(0, PREVIEW_MAX_BYTES) : buf).toString('utf8') };
  } catch { return null; }
}

// Serve a file's raw bytes so the UI can render it (PDF in an iframe, images in
// <img>). Constrained to within the given cwd, no path traversal outside it.
function serveFile(cwd, relPath, res, cors) {
  const root = path.resolve(expandPreviewHome(cwd));
  const full = path.resolve(root, relPath || '');
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403, cors); res.end(JSON.stringify({ error: 'forbidden_path' })); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, cors); res.end(JSON.stringify({ error: 'not_found' })); return; }
    const ct = FILE_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...cors, 'Content-Type': ct });
    res.end(buf);
  });
}

function expandPreviewHome(p) {
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function findRecentFile(cwd, maxAgeMs) {
  const root = expandPreviewHome(cwd);
  let best = null;
  let scanned = 0;
  const stack = [root];

  while (stack.length && scanned < PREVIEW_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (PREVIEW_SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (++scanned > PREVIEW_MAX_FILES) break;
        if (e.name.startsWith('.')) continue;
        if (PREVIEW_SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const full = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size > 2_000_000) continue; // skip huge files
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
  }

  if (!best) return null;
  // Only surface a file that changed recently, otherwise the preview would show
  // a stale, unrelated file instead of what's actively being worked on.
  const ageMs = Date.now() - best.mtimeMs;
  const relPath = path.relative(root, best.full) || path.basename(best.full);
  if (maxAgeMs && ageMs > maxAgeMs) return { stale: true, relPath, ageMs };

  const name = path.basename(best.full);
  const kind = previewKind(name);
  const base = { relPath, name, kind, mtime: new Date(best.mtimeMs).toISOString(), size: best.size };

  // Text files are returned inline; pdf/image bytes are fetched via /file.
  if (kind !== 'text') return base;

  try {
    const buf = fs.readFileSync(best.full);
    const truncated = buf.length > PREVIEW_MAX_BYTES;
    return { ...base, truncated, content: (truncated ? buf.subarray(0, PREVIEW_MAX_BYTES) : buf).toString('utf8') };
  } catch { return null; }
}

// In-memory stores
const peers = new Map();      // id -> Peer
const messages = [];           // Message[]
let msgCounter = 0;
let workspace = loadWorkspace();

function uid() {
  return crypto.randomBytes(4).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function cleanStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, peer] of peers.entries()) {
    if (new Date(peer.last_seen).getTime() < cutoff && !isAlive(peer.pid)) {
      peers.delete(id);
    }
  }
}

setInterval(cleanStale, HEARTBEAT_INTERVAL);

// ─── Route handlers ──────────────────────────────────────────────────────────

const handlers = {

  'POST /register'(body) {
    const id = uid();
    const ts = now();
    peers.set(id, {
      id,
      pid:          body.pid || 0,
      cwd:          body.cwd || '',
      git_root:     body.git_root || null,
      tty:          body.tty || null,
      summary:      body.summary || '',
      team_id:      body.team_id || 'default',
      agent_name:   body.agent_name || null,
      registered_at: ts,
      last_seen:    ts,
    });
    return { id };
  },

  'POST /heartbeat'(body) {
    const peer = peers.get(body.id);
    if (!peer) return { error: 'not_found' };
    peer.last_seen = now();
    return { ok: true };
  },

  'POST /set-summary'(body) {
    const peer = peers.get(body.id);
    if (!peer) return { error: 'not_found' };
    peer.summary   = body.summary || '';
    peer.last_seen = now();
    return { ok: true };
  },

  'POST /set-team'(body) {
    const peer = peers.get(body.id);
    if (!peer) return { error: 'not_found' };
    peer.team_id   = body.team_id || 'default';
    peer.last_seen = now();
    return { ok: true };
  },

  // List peers, scoped by team_id and/or legacy machine/directory/repo scope.
  // Returns a BARE ARRAY to stay wire-compatible with the stock claude-peers
  // MCP client, which types this response as Peer[] (not { peers }).
  'POST /list-peers'(body) {
    let list = Array.from(peers.values());

    if (body.team_id)    list = list.filter(p => p.team_id === body.team_id);
    if (body.exclude_id) list = list.filter(p => p.id !== body.exclude_id);

    // Legacy claude-peers scope compat
    if (body.scope === 'directory' && body.cwd) {
      list = list.filter(p => p.cwd === body.cwd);
    } else if (body.scope === 'repo' && body.git_root) {
      list = list.filter(p => p.git_root === body.git_root);
    }

    return list;
  },

  // Helm UI endpoint, all peers, CORS-friendly GET
  'GET /peers'() {
    return { peers: Array.from(peers.values()) };
  },

  // Helm UI endpoint, list subdirectories for the working-directory picker.
  // Query: ?path=~/AI-Projects  ->  { path, dirs: [{ name, path }] }
  'GET /ls'(_body, query) {
    const raw = query.get('path') || '~';
    const base = raw === '~' ? os.homedir()
      : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2))
      : raw;

    let dirs = [];
    let resolved = base;
    try {
      const stat = fs.statSync(base);
      // If they typed a partial leaf, list its parent and filter by prefix.
      const dir = stat.isDirectory() ? base : path.dirname(base);
      const prefix = stat.isDirectory() ? '' : path.basename(base).toLowerCase();
      resolved = dir;
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .filter(d => d.name.toLowerCase().startsWith(prefix))
        .slice(0, 50)
        .map(d => ({ name: d.name, path: path.join(dir, d.name) }));
    } catch {
      // Path doesn't exist yet, try its parent so typing still autocompletes.
      try {
        const dir = path.dirname(base);
        const prefix = path.basename(base).toLowerCase();
        resolved = dir;
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .filter(d => d.name.toLowerCase().startsWith(prefix))
          .slice(0, 50)
          .map(d => ({ name: d.name, path: path.join(dir, d.name) }));
      } catch { /* give up, empty list */ }
    }
    return { path: resolved, dirs };
  },

  // Live preview: the real file a teammate most recently changed in its cwd.
  // Query: ?cwd=~/AI-Projects/VERA  ->  { file: { relPath, content, mtime, ... } | null }
  'GET /preview'(_body, query) {
    const cwd = query.get('cwd') || '';
    if (!cwd) return { file: null, error: 'no_cwd' };
    // Default: only show files touched in the last 10 minutes (override with ?within=ms).
    const within = parseInt(query.get('within') || '600000', 10);
    return { file: findRecentFile(cwd, within) };
  },

  // Browsable file list for the preview explorer.
  'GET /tree'(_body, query) {
    const cwd = query.get('cwd') || '';
    if (!cwd) return { files: [], error: 'no_cwd' };
    return listFiles(cwd);
  },

  // Content/kind for a specific file the user clicked in the explorer.
  'GET /filemeta'(_body, query) {
    const cwd = query.get('cwd') || '';
    const p = query.get('path') || '';
    if (!cwd || !p) return { file: null, error: 'bad_request' };
    return { file: fileMeta(cwd, p) };
  },

  // Helm UI endpoint, peers grouped by team
  'GET /teams'() {
    const map = {};
    for (const peer of peers.values()) {
      const tid = peer.team_id;
      if (!map[tid]) map[tid] = { id: tid, peers: [] };
      map[tid].peers.push(peer);
    }
    return { teams: Object.values(map) };
  },

  'POST /send-message'(body) {
    const msg = {
      id:       ++msgCounter,
      from_id:  body.from_id,
      to_id:    body.to_id,
      team_id:  null,
      text:     body.text,
      sent_at:  now(),
      delivered: false,
    };
    messages.push(msg);
    return { ok: true, id: msg.id };
  },

  // Broadcast to all peers in a team
  'POST /broadcast'(body) {
    const teamPeers = Array.from(peers.values())
      .filter(p => p.team_id === body.team_id && p.id !== body.from_id);
    const ts = now();
    for (const peer of teamPeers) {
      messages.push({
        id:       ++msgCounter,
        from_id:  body.from_id,
        to_id:    peer.id,
        team_id:  body.team_id,
        text:     body.text,
        sent_at:  ts,
        delivered: false,
      });
    }
    return { ok: true, sent_to: teamPeers.length };
  },

  'POST /poll-messages'(body) {
    const pending = messages.filter(m => m.to_id === body.id && !m.delivered);
    for (const m of pending) m.delivered = true;
    return { messages: pending };
  },

  'POST /unregister'(body) {
    peers.delete(body.id);
    return { ok: true };
  },

  // Persisted workspace config for the UI (and, later, the control-MCP).
  'GET /workspace'() {
    return { workspace };
  },

  'PUT /workspace'(body) {
    if (!isValidWorkspace(body)) return { error: 'invalid_workspace' };
    workspace = body;
    try { saveWorkspace(workspace); }
    catch (err) { return { error: `persist_failed: ${String(err)}` }; }
    return { ok: true };
  },

  'GET /health'() {
    return { ok: true, peer_count: peers.size, uptime: Math.round(process.uptime()) };
  },
};

// ─── HTTP server ─────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
    'Vary':                         'Origin',
  };
  // Reflect only an allowed browser origin, never a blanket '*'.
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  // Reject browser requests from any origin that isn't the Helm UI.
  if (!originAllowed(origin)) {
    res.writeHead(403, cors);
    res.end(JSON.stringify({ error: 'forbidden_origin' }));
    return;
  }

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // Raw file bytes (PDF / image) for the preview, served outside the JSON layer.
  if (req.method === 'GET' && url.pathname === '/file') {
    serveFile(url.searchParams.get('cwd') || '', url.searchParams.get('path') || '', res, cors);
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = handlers[key];

  if (!handler) {
    res.writeHead(404, cors);
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const result = handler(parsed, url.searchParams);
      res.writeHead(200, cors);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, cors);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[helm-broker] listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
