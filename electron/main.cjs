'use strict';
/**
 * Helm desktop shell.
 *
 * Runs Helm's own backend (broker + PTY server) as child processes and shows
 * the UI in a native window. In development it points at the Vite dev server;
 * when packaged it serves the built app from a tiny local static server. Either
 * way the UI is served from http://localhost:5199, so the broker/PTY origin
 * checks pass unchanged and the renderer stays a sandboxed web context.
 */

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UI_PORT = 5199;
const UI_URL = `http://localhost:${UI_PORT}`;
const BROKER_HEALTH = 'http://127.0.0.1:7900/health';
const ROOT = path.join(__dirname, '..');

const children = [];

function spawnNode(scriptRelPath, label, args = []) {
  // Packaged: run the scripts under Electron's own Node (ELECTRON_RUN_AS_NODE)
  //   so the app needs no system Node; native deps are rebuilt to Electron's ABI.
  // Dev: use system Node, where node-pty's prebuilt binary already matches.
  const env = { ...process.env };
  let bin = 'node';
  if (app.isPackaged) {
    bin = process.execPath;
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  const child = spawn(bin, [path.join(ROOT, scriptRelPath), ...args], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  child.on('error', err => console.error(`[helm-app] failed to start ${label}:`, err.message));
  children.push(child);
  return child;
}

// Minimal static server for the packaged build (no extra dependency).
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

function startStaticServer(dir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback to index.html
        fs.readFile(path.join(dir, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(idx);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  server.listen(UI_PORT, '127.0.0.1');
  return server;
}

function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, res => { res.destroy(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Helm',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links in the system browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(UI_URL);
  return win;
}

async function boot() {
  // Show the Helm crown in the Dock (the packaged build uses the .icns; this
  // makes it appear in dev too, and is harmless when packaged).
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(ROOT, 'build', 'icon-512.png')); } catch { /* ignore */ }
  }

  spawnNode('helm-broker/broker.js', 'broker');
  spawnNode('helm-broker/pty-server.js', 'pty');

  if (app.isPackaged) {
    startStaticServer(path.join(ROOT, 'dist'));
  } else {
    spawnNode('node_modules/vite/bin/vite.js', 'vite', ['--port', String(UI_PORT), '--strictPort']); // dev server
  }

  try {
    await waitFor(BROKER_HEALTH);
    await waitFor(UI_URL);
  } catch (err) {
    console.error('[helm-app]', err.message);
  }
  createWindow();
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  app.quit();
});

app.on('before-quit', () => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
});
