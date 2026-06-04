import { useEffect } from 'react';
import type { Prefs, ThemeName, CursorStyle } from '../types';
import './SettingsPanel.css';

interface SettingsPanelProps {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
  onClose: () => void;
}

const THEMES: { id: ThemeName; label: string; swatch: string }[] = [
  { id: 'white', label: 'WHITE', swatch: '#d8d8d8' },
  { id: 'amber', label: 'AMBER', swatch: '#ffb000' },
  { id: 'green', label: 'GREEN', swatch: '#33ff66' },
];

const CURSORS: { id: CursorStyle; label: string }[] = [
  { id: 'block', label: '█' },
  { id: 'bar', label: '▏' },
  { id: 'underline', label: '_' },
];

export function SettingsPanel({ prefs, onChange, onClose }: SettingsPanelProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <aside className="settings" role="dialog" aria-label="Settings">
        <header className="settings-head">
          <span className="settings-title">SETTINGS</span>
          <button className="settings-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <div className="settings-body">
          <section className="settings-row">
            <label className="settings-label">THEME</label>
            <div className="settings-themes">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  className={`theme-chip ${prefs.theme === t.id ? 'theme-chip--on' : ''}`}
                  onClick={() => onChange({ theme: t.id })}
                >
                  <span className="theme-dot" style={{ background: t.swatch }} />
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-row">
            <label className="settings-label">FONT SIZE</label>
            <div className="settings-control">
              <input
                type="range" min={9} max={20} step={1}
                value={prefs.fontSize}
                onChange={e => onChange({ fontSize: Number(e.target.value) })}
              />
              <span className="settings-value">{prefs.fontSize}px</span>
            </div>
          </section>

          <section className="settings-row">
            <label className="settings-label">CRT GLOW</label>
            <div className="settings-control">
              <input
                type="range" min={0} max={1} step={0.05}
                value={prefs.glow}
                onChange={e => onChange({ glow: Number(e.target.value) })}
              />
              <span className="settings-value">{Math.round(prefs.glow * 100)}%</span>
            </div>
          </section>

          <section className="settings-row">
            <label className="settings-label">CURSOR</label>
            <div className="settings-cursor">
              {CURSORS.map(c => (
                <button
                  key={c.id}
                  className={`cursor-chip ${prefs.cursorStyle === c.id ? 'cursor-chip--on' : ''}`}
                  onClick={() => onChange({ cursorStyle: c.id })}
                  title={c.id}
                >
                  {c.label}
                </button>
              ))}
              <button
                className={`cursor-chip ${prefs.cursorBlink ? 'cursor-chip--on' : ''}`}
                onClick={() => onChange({ cursorBlink: !prefs.cursorBlink })}
                title="Blink"
              >
                BLINK
              </button>
            </div>
          </section>
        </div>

        <footer className="settings-foot">
          <span className="settings-hint">changes save automatically</span>
        </footer>
      </aside>
    </>
  );
}
