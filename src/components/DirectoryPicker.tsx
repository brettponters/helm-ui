import { useEffect, useRef, useState } from 'react';
import './DirectoryPicker.css';

const BROKER = 'http://127.0.0.1:7900';

interface DirEntry {
  name: string;
  path: string;
}

interface DirectoryPickerProps {
  current: string;
  /** Quick-pick roots shown as chips (e.g. ~/AI-Projects subfolders). */
  onPick: (path: string) => void;
  onClose: () => void;
}

async function listDirs(query: string): Promise<{ path: string; dirs: DirEntry[] }> {
  try {
    const res = await fetch(`${BROKER}/ls?path=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { path: query, dirs: [] };
    return await res.json();
  } catch {
    return { path: query, dirs: [] };
  }
}

export function DirectoryPicker({ current, onPick, onClose }: DirectoryPickerProps) {
  const [value, setValue] = useState(current);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load suggestions whenever the typed path changes (debounced lightly).
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      const { dirs } = await listDirs(value || '~');
      if (!cancelled) { setDirs(dirs); setActive(0); }
    }, 80);
    return () => { cancelled = true; clearTimeout(id); };
  }, [value]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function choose(entry: DirEntry) {
    // Step into the directory: refill the input and reload its children.
    setValue(entry.path);
  }

  function commit(p: string) {
    if (p.trim()) onPick(p.trim());
  }

  return (
    <>
      <div className="dirpick-backdrop" onClick={onClose} />
      <div className="dirpick" onClick={e => e.stopPropagation()}>
        <div className="dirpick-head">
          <span className="dirpick-label">WORKING DIRECTORY</span>
          <button className="dirpick-x" onClick={onClose} title="Close">✕</button>
        </div>

        <input
          ref={inputRef}
          className="dirpick-input"
          value={value}
          spellCheck={false}
          placeholder="~/AI-Projects/…"
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, dirs.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
            else if (e.key === 'Tab' && dirs[active]) { e.preventDefault(); choose(dirs[active]); }
            else if (e.key === 'Enter') {
              // Enter on a highlighted suggestion steps in; Enter again commits.
              if (dirs[active] && dirs[active].path !== value) choose(dirs[active]);
              else commit(value);
            }
            else if (e.key === 'Escape') onClose();
          }}
        />

        <div className="dirpick-list">
          {dirs.length === 0 && <div className="dirpick-empty">no subdirectories</div>}
          {dirs.map((d, i) => (
            <button
              key={d.path}
              className={`dirpick-item ${i === active ? 'dirpick-item--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(d)}
            >
              <span className="dirpick-item-icon">▸</span>
              <span className="dirpick-item-name">{d.name}</span>
            </button>
          ))}
        </div>

        <div className="dirpick-foot">
          <span className="dirpick-hint">↑↓ navigate · Tab step in · ⏎ select · Esc cancel</span>
          <button className="dirpick-use" onClick={() => commit(value)}>USE THIS</button>
        </div>
      </div>
    </>
  );
}
