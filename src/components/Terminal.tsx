import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../types';
import { usePrefs } from '../context/PrefsContext';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';

const PTY_HOST = '127.0.0.1:7901';

interface TerminalProps {
  cwd: string;
  command?: string;
  name?: string;
  team?: string;
  /** Stable teammate id, the persistent session key on the PTY daemon.
      With an id, the shell survives unmounts and app restarts (reattach +
      replay); without one the session dies with the socket. */
  id?: string;
  /** Called when a Claude process starts/stops in this panel's shell. */
  onClaudeActive?: (active: boolean) => void;
  /** Bumped by the parent to force a fresh shell (e.g. after a panel restart). */
  sessionKey?: string | number;
}

export interface TerminalHandle {
  /** Type a command into the live shell (as if the user typed it). */
  runCommand: (cmd: string) => void;
  /** Explicitly end the persistent session (shell dies). Used on remove. */
  kill: () => void;
}

// Shared ANSI palette (muted, terminal-native). Foreground/cursor/selection are
// layered on per theme so the phosphor color changes without touching the rest.
const ANSI_BASE = {
  background:    '#070707',
  cursorAccent:  '#070707',
  black:   '#0a0a0a',
  red:     '#b85c5c',
  green:   '#9aa67d',
  yellow:  '#c9b87d',
  blue:    '#7d97b8',
  magenta: '#a98bb0',
  cyan:    '#7db5b5',
  white:   '#cccccc',
  brightBlack:   '#555555',
  brightRed:     '#d08080',
  brightGreen:   '#b8c49a',
  brightYellow:  '#e0d0a0',
  brightBlue:    '#a0b5d0',
  brightMagenta: '#c0a8c8',
  brightCyan:    '#a0d0d0',
  brightWhite:   '#ffffff',
};

function themeFor(name: ThemeName): ITheme {
  if (name === 'amber') {
    return { ...ANSI_BASE, foreground: '#ffb000', cursor: '#ffc233', selectionBackground: 'rgba(255,176,0,0.22)' };
  }
  if (name === 'green') {
    return { ...ANSI_BASE, foreground: '#33ff66', cursor: '#66ff99', selectionBackground: 'rgba(51,255,102,0.20)' };
  }
  return { ...ANSI_BASE, foreground: '#e4e4e4', cursor: '#ffffff', selectionBackground: 'rgba(255,255,255,0.18)' };
}

const SEARCH_DECORATIONS = {
  matchOverviewRuler:        '#ffffff',
  activeMatchColorOverviewRuler: '#ffffff',
  matchBackground:           'rgba(255,255,255,0.18)',
  activeMatchBackground:     'rgba(255,255,255,0.45)',
};

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { cwd, command, name, team, id, onClaudeActive, sessionKey },
  ref,
) {
  const prefs = usePrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const onClaudeActiveRef = useRef(onClaudeActive);
  onClaudeActiveRef.current = onClaudeActive;

  const hostRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Let the panel type a command into the live shell (e.g. on Save → run it)
  // or explicitly end the persistent session (remove teammate).
  useImperativeHandle(ref, () => ({
    runCommand: (cmd: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data: /[\r\n]$/.test(cmd) ? cmd : cmd + '\r' }));
    },
    kill: () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'kill' }));
    },
  }), []);

  const [findOpen, setFindOpen] = useState(false);
  const [findValue, setFindValue] = useState('');
  const findInputRef = useRef<HTMLInputElement>(null);

  // Mirror findOpen into a ref so the once-bound xterm key handler reads latest.
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;

  // name/team are read once at spawn time for env injection; intentionally NOT
  // in the dep array so renaming a teammate doesn't kill its running shell.
  const spawnMeta = useRef({ name, team });
  spawnMeta.current = { name, team };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const p = prefsRef.current;
    const term = new XTerm({
      theme: themeFor(p.theme),
      fontFamily: "'JetBrains Mono', 'Menlo', 'SF Mono', monospace",
      fontSize: p.fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: p.cursorBlink,
      cursorStyle: p.cursorStyle,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    fit.fit();
    termRef.current = term;
    searchRef.current = search;
    fitRef.current = fit;

    // Intercept Cmd+F to open the in-terminal find box instead of the browser's.
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type === 'keydown' && (ev.metaKey || ev.ctrlKey) && ev.key === 'f') {
        ev.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
        return false;
      }
      if (ev.type === 'keydown' && ev.key === 'Escape' && findOpenRef.current) {
        setFindOpen(false);
        return false;
      }
      return true;
    });

    const params = new URLSearchParams({ cwd });
    if (id)                   params.set('id', id);
    if (command)              params.set('cmd', command);
    if (spawnMeta.current.name) params.set('name', spawnMeta.current.name);
    if (spawnMeta.current.team) params.set('team', spawnMeta.current.team);

    const ws = new WebSocket(`ws://${PTY_HOST}/?${params.toString()}`);
    wsRef.current = ws;
    let alive = true;

    ws.onopen = () => {
      fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = ev => {
      let msg: { type: string; data?: string; code?: number };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'output' && msg.data != null) {
        term.write(msg.data);
      } else if (msg.type === 'status') {
        onClaudeActiveRef.current?.(!!(msg as { claudeActive?: boolean }).claudeActive);
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[2m[process exited${msg.code != null ? ` (${msg.code})` : ''}]\x1b[0m\r\n`);
      }
    };

    ws.onclose = () => { if (alive) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n'); };
    ws.onerror = () => { term.write('\r\n\x1b[31mhelm: cannot reach PTY server on :7901\x1b[0m\r\n'); };

    const onInput = term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Refit on container resize (grid rebalances when teammates are added/removed).
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch { /* host detached */ }
    });
    ro.observe(host);

    return () => {
      alive = false;
      ro.disconnect();
      onInput.dispose();
      try { ws.close(); } catch { /* already closing */ }
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command, sessionKey, id]);

  // Live-apply theme/font/cursor changes to the running terminal, no restart,
  // so the shell session is preserved while the look updates.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = prefs.fontSize;
    term.options.cursorStyle = prefs.cursorStyle;
    term.options.cursorBlink = prefs.cursorBlink;
    term.options.theme = themeFor(prefs.theme);
    try {
      fitRef.current?.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch { /* host detached */ }
  }, [prefs.fontSize, prefs.cursorStyle, prefs.cursorBlink, prefs.theme]);

  function runSearch(value: string, dir: 'next' | 'prev') {
    const search = searchRef.current;
    if (!search || !value) return;
    const opts = { decorations: SEARCH_DECORATIONS };
    if (dir === 'next') search.findNext(value, opts);
    else search.findPrevious(value, opts);
  }

  function closeFind() {
    setFindOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }

  return (
    <div className="xterm-host" ref={hostRef}>
      {findOpen && (
        <div className="term-find" onClick={e => e.stopPropagation()}>
          <input
            ref={findInputRef}
            className="term-find-input"
            placeholder="find…"
            value={findValue}
            onChange={e => {
              setFindValue(e.target.value);
              runSearch(e.target.value, 'next');
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') runSearch(findValue, e.shiftKey ? 'prev' : 'next');
              else if (e.key === 'Escape') closeFind();
            }}
          />
          <button className="term-find-btn" title="Previous (⇧⏎)" onClick={() => runSearch(findValue, 'prev')}>↑</button>
          <button className="term-find-btn" title="Next (⏎)" onClick={() => runSearch(findValue, 'next')}>↓</button>
          <button className="term-find-btn" title="Close (Esc)" onClick={closeFind}>✕</button>
        </div>
      )}
    </div>
  );
});
