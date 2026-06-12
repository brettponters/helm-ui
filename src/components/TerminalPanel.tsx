import { useEffect, useRef, useState } from 'react';
import type { Teammate } from '../types';
import type { Peer } from '../hooks/usePeers';
import { Eye, X, Drama } from 'lucide-react';
import { Terminal, type TerminalHandle } from './Terminal';
import { DirectoryPicker } from './DirectoryPicker';
import { RolePopover } from './RolePopover';
import { CrownMark } from './CrownMark';
import './TerminalPanel.css';

// Every Helm agent launches with the workspace operating doctrine baked in.
// The preset roles carry domain depth; this carries how to actually operate
// here, the tools, the cadence, the chain of command. Without it a role is
// just a personality that doesn't know it lives in a team.
const TEAMMATE_DOCTRINE =
  'You operate inside Helm, a multi-agent workspace, connected to your team through helm-teammates tools. ' +
  'Operating rules: call set_summary the moment you start and again whenever your focus changes, one concrete sentence, it is your status board and your teammates plan around it. ' +
  'When a teammate messages you, respond immediately, then resume your work. ' +
  'Before starting anything non-trivial, recall_memory for prior context, someone may have already solved it or decided against it. ' +
  'When you learn something durable (a decision, a gotcha, a result that outlives this task), add_memory with one self-contained fact. ' +
  'When you are blocked or done, tell your team lead, never go quiet, and never wander outside your assignment.';

const LEAD_DOCTRINE =
  'You are this team\'s LEAD. You own the outcome, not the keystrokes: break work into clear assignments, delegate with send_message (or message_team to brief everyone at once), keep every teammate unblocked, and verify completion instead of assuming it. ' +
  'Compress your team\'s state into crisp reports: when the Helm orchestrator messages you, respond immediately with status, blockers, and what happens next, and use message_helm proactively when something material changes, a milestone, a blocker you cannot clear, a decision above your pay grade. ' +
  'You may message other teams\' LEADS directly by name for cross-team coordination; anything that would change priorities or resources goes through the Helm. ' +
  'Curate knowledge: make sure your team\'s durable learnings land in add_memory, and recall_memory before pointing anyone at a problem that may already be solved. ' +
  'Keep the team thinking bigger, pull people out of rabbit holes, be critical of weak work, decide fast, and own the consequences.';

// The orchestrator's seat gets its own doctrine: it IS the Helm, so the
// worker/lead doctrine (report to your lead, message the Helm) would point
// it at itself. Its global tools are described by the MCP when it connects.
const HELM_DOCTRINE =
  'You sit at the Helm\'s own station. Your helm-teammates tools are global: list_teams shows every team with its lead, send_message reaches any team\'s LEAD (workers are off-limits, direct work through their leads), and you alone curate workspace memory (review_memory_inbox, curate_memory). ' +
  'Operating rules: call set_summary when you start and when your focus changes; respond immediately when a lead messages you; read your charter (CLAUDE.md) and ./state/ docs at session start and keep them current; review the memory inbox regularly, promote what matters, delete what is stale. ' +
  'You orchestrate, you do not do object-level work.';

// Frame the role so Claude fully adopts it as an identity, not just a style hint.
// A bare role appended to Claude Code's large base prompt gets diluted (Claude
// keeps calling itself "Claude Code"); this wrapper makes the role take over how
// it presents itself, verified to flip self-identification.
function frameRole(role: string, position: 'worker' | 'lead', isHelmTeam: boolean): string {
  const doctrine = isHelmTeam
    ? HELM_DOCTRINE
    : position === 'lead' ? `${TEAMMATE_DOCTRINE}\n\n${LEAD_DOCTRINE}` : TEAMMATE_DOCTRINE;
  if (!role.trim()) return doctrine;
  return `You are a specialist teammate on this team. Fully take on the following role and stay in character, including how you introduce and identify yourself when asked who you are. Your role: ${role.trim()}\n\n${doctrine}`;
}

// The visible command Save runs: `claude helm` (full Helm teammate, chat + live
// push) with the framed role + model. `claude helm` loads a development channel,
// which makes Claude pause once on a "confirm" prompt; saveRole auto-presses Enter
// to clear it. (`claude helm` already adds --dangerously-skip-permissions.)
const DEV_CHANNEL_CONFIRM_MS = 2000; // wait for the channel prompt, then press Enter

function buildRunCommand(role: string, model: string, position: 'worker' | 'lead', isHelmTeam: boolean): string {
  const esc = (s: string) => s.replace(/\s*\n+\s*/g, ' ').replace(/'/g, "'\\''");
  let cmd = `claude helm --append-system-prompt '${esc(frameRole(role, position, isHelmTeam))}'`;
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
  onSetRole: (role: string, model: string, position: 'worker' | 'lead') => void;
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
  const isHelmTeam = teamId === 'helm';
  // Setup is only available when Claude isn't running here. `launching` bridges
  // the ~1.5s until the scanner confirms the Claude we just started, so you can't
  // Save a second one in that gap.
  const canSetUp = !claudeActive && !launching;

  // The orchestrator's panel offers its setup unprompted: when the helm team
  // opens and its agent isn't running, pop the role popover (pre-filled,
  // one Save from live) instead of waiting for the user to find the mask.
  // Delayed so a reattach's claudeActive status arrives first.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!isHelmTeam || !hasRole || autoOpened.current) return;
    const t = window.setTimeout(() => {
      if (autoOpened.current) return;
      autoOpened.current = true;
      setRoleOpen(open => open || (!claudeActive && !launching));
    }, 1800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHelmTeam, hasRole, claudeActive, launching]);

  function commitName() {
    const v = nameValue.trim();
    if (v && v !== teammate.name) onRename(v);
    setEditingName(false);
  }

  // Save the role/model/position, then, if Claude isn't already running here,
  // start it with the composed system prompt (role + Helm doctrine, lead
  // doctrine when positioned as lead). The auto-run is tied to this Save.
  function saveRole(role: string, model: string, position: 'worker' | 'lead') {
    onSetRole(role, model, position);
    setRoleOpen(false);
    if (canSetUp) {
      termRef.current?.runCommand(buildRunCommand(role, model, position, isHelmTeam));
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
            onClick={e => {
              e.stopPropagation();
              // End the persistent session too, removal is the one place a
              // shell should actually die rather than detach.
              termRef.current?.kill();
              onRemove();
            }}
            title="Remove teammate"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="panel-scanlines" />

      <Terminal
        ref={termRef}
        id={teammate.id}
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
          currentPosition={teammate.position ?? (isLead ? 'lead' : 'worker')}
          onSave={saveRole}
          onClose={() => setRoleOpen(false)}
        />
      )}
    </div>
  );
}
