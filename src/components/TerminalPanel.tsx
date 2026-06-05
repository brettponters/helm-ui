import { useRef, useState } from 'react';
import type { Teammate } from '../types';
import type { Peer } from '../hooks/usePeers';
import { Eye, X, Drama } from 'lucide-react';
import { Terminal, type TerminalHandle } from './Terminal';
import { DirectoryPicker } from './DirectoryPicker';
import { RolePopover } from './RolePopover';
import { CrownMark } from './CrownMark';
import './TerminalPanel.css';

// Frame the role so Claude fully adopts it as an identity, not just a style hint.
// A bare role appended to Claude Code's large base prompt gets diluted (Claude
// keeps calling itself "Claude Code"); this wrapper makes the role take over how
// it presents itself, verified to flip self-identification.
function frameRole(role: string): string {
  return `You are a specialist teammate on this team. Fully take on the following role and stay in character, including how you introduce and identify yourself when asked who you are. Your role: ${role}`;
}

// The visible command Save runs: `claude helm` (full Helm teammate, chat + live
// push) with the framed role + model. `claude helm` loads a development channel,
// which makes Claude pause once on a "confirm" prompt; saveRole auto-presses Enter
// to clear it. (`claude helm` already adds --dangerously-skip-permissions.)
const DEV_CHANNEL_CONFIRM_MS = 2000; // wait for the channel prompt, then press Enter

function buildRunCommand(role: string, model: string): string {
  const esc = (s: string) => s.replace(/\s*\n+\s*/g, ' ').replace(/'/g, "'\\''");
  let cmd = 'claude helm';
  if (role.trim()) cmd += ` --append-system-prompt '${esc(frameRole(role.trim()))}'`;
  if (model) cmd += ` --model ${model}`;
  return cmd;
}

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
  onSetRole: (role: string, model: string) => void;
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
  onActivate, onSetLead, onRename, onSetCwd, onSetRole, onOpenPreview, onRemove,
}: TerminalPanelProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(teammate.name);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [claudeActive, setClaudeActive] = useState(false);
  const [launching, setLaunching] = useState(false);
  const termRef = useRef<TerminalHandle>(null);

  const hasRole = !!teammate.systemPrompt?.trim();
  // Setup is only available when Claude isn't running here. `launching` bridges
  // the ~1.5s until the scanner confirms the Claude we just started, so you can't
  // Save a second one in that gap.
  const canSetUp = !claudeActive && !launching;

  function commitName() {
    const v = nameValue.trim();
    if (v && v !== teammate.name) onRename(v);
    setEditingName(false);
  }

  // Save the role/model, then, if Claude isn't already running here, start it
  // with the system prompt injected. The auto-run is tied to this explicit Save.
  function saveRole(role: string, model: string) {
    onSetRole(role, model);
    setRoleOpen(false);
    if (canSetUp && (role.trim() || model)) {
      termRef.current?.runCommand(buildRunCommand(role, model));
      // `claude helm` pauses on a dev-channel "confirm" prompt; press Enter for it.
      window.setTimeout(() => termRef.current?.runCommand(''), DEV_CHANNEL_CONFIRM_MS);
      setLaunching(true);
      window.setTimeout(() => setLaunching(false), 4000);
    }
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
          {/* Set up a teammate's role only before Claude is running here. Once
              Claude is live (or just launched) the mask hides, you don't re-cast
              a running session or Save a second one over it. */}
          {canSetUp && (
            <button
              className={`panel-btn ${hasRole ? 'panel-btn--on' : ''}`}
              onClick={e => { e.stopPropagation(); setRoleOpen(true); }}
              title={hasRole ? `Role set, click to edit:\n${teammate.systemPrompt}` : 'Set up this teammate (role + model)'}
            >
              <Drama size={15} strokeWidth={1.75} />
            </button>
          )}
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
        ref={termRef}
        cwd={teammate.cwd}
        command={teammate.command && teammate.command !== 'claude' ? teammate.command : undefined}
        name={teammate.name}
        team={teamId}
        onClaudeActive={setClaudeActive}
      />

      {pickerOpen && (
        <DirectoryPicker
          current={teammate.cwd}
          onPick={p => { onSetCwd(p); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {roleOpen && (
        <RolePopover
          name={teammate.name}
          current={teammate.systemPrompt ?? ''}
          currentModel={teammate.model ?? ''}
          onSave={saveRole}
          onClose={() => setRoleOpen(false)}
        />
      )}
    </div>
  );
}
