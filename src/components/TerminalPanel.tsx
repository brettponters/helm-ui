import { useState } from 'react';
import type { Teammate } from '../types';
import type { Peer } from '../hooks/usePeers';
import { Eye, X } from 'lucide-react';
import { Terminal } from './Terminal';
import { DirectoryPicker } from './DirectoryPicker';
import { CrownMark } from './CrownMark';
import './TerminalPanel.css';

interface TerminalPanelProps {
  teammate: Teammate;
  index: number;
  peer: Peer | null;
  teamId: string;
  isActive: boolean;
  isLead: boolean;
  onActivate: () => void;
  onSetLead: () => void;
  onRename: (name: string) => void;
  onSetCwd: (path: string) => void;
  onOpenPreview: () => void;
  onRemove: () => void;
}

function truncateSummary(s: string, max = 44): string {
  if (!s) return '';
  const first = s.split('.')[0].trim();
  return first.length > max ? first.slice(0, max) + '…' : first;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length <= 2 ? cwd.replace(/\/$/, '') : parts.slice(-2).join('/');
}

const STATUS_GLYPH: Record<Teammate['status'], string> = {
  running: '●',
  waiting: '◐',
  done:    '○',
  error:   '✕',
};

export function TerminalPanel({
  teammate, peer, teamId, isActive, isLead,
  onActivate, onSetLead, onRename, onSetCwd, onOpenPreview, onRemove,
}: TerminalPanelProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(teammate.name);
  const [pickerOpen, setPickerOpen] = useState(false);

  function commitName() {
    const v = nameValue.trim();
    if (v && v !== teammate.name) onRename(v);
    setEditingName(false);
  }

  return (
    <div
      className={`panel ${isActive ? 'panel--active' : ''} ${isLead ? 'panel--lead' : ''} panel--${teammate.status}`}
      onClick={onActivate}
    >
      <div className="panel-header">
        <div className="panel-header-left">
          <span className={`status-glyph status--${teammate.status}`}>
            {STATUS_GLYPH[teammate.status]}
          </span>

          <button
            className={`panel-crown ${isLead ? 'panel-crown--on' : ''}`}
            title={isLead ? 'Team lead (at the helm)' : 'Make team lead'}
            onClick={e => { e.stopPropagation(); onSetLead(); }}
          >
            <CrownMark size={14} animate={isLead} />
          </button>

          {editingName ? (
            <input
              className="panel-name-input"
              value={nameValue}
              autoFocus
              spellCheck={false}
              onClick={e => e.stopPropagation()}
              onChange={e => setNameValue(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') { setNameValue(teammate.name); setEditingName(false); }
              }}
            />
          ) : (
            <span
              className="panel-name"
              title="Double-click to rename"
              onDoubleClick={e => { e.stopPropagation(); setNameValue(teammate.name); setEditingName(true); }}
            >
              {teammate.name}
            </span>
          )}

          <button
            className="panel-cwd"
            title={`Working directory: ${teammate.cwd}\nClick to change`}
            onClick={e => { e.stopPropagation(); setPickerOpen(true); }}
          >
            <span className="panel-cwd-icon">⌖</span>
            {shortCwd(teammate.cwd)}
          </button>

          {peer && (
            <>
              <span className="panel-peer-summary" title={peer.summary}>
                {truncateSummary(peer.summary)}
              </span>
              <span className="panel-peer-dot" title={`peer: ${peer.id}`}>◈</span>
            </>
          )}
        </div>

        <div className="panel-header-right">
          <button
            className="panel-btn"
            onClick={e => { e.stopPropagation(); onOpenPreview(); }}
            title="Preview the file this teammate is working on"
          >
            <Eye size={15} strokeWidth={1.75} />
          </button>
          <button
            className="panel-btn panel-btn--remove"
            onClick={e => { e.stopPropagation(); onRemove(); }}
            title="Remove teammate"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="panel-scanlines" />

      <Terminal
        cwd={teammate.cwd}
        command={teammate.command && teammate.command !== 'claude' ? teammate.command : undefined}
        name={teammate.name}
        team={teamId}
      />

      {pickerOpen && (
        <DirectoryPicker
          current={teammate.cwd}
          onPick={p => { onSetCwd(p); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
