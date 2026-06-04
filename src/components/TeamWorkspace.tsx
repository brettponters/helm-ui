import { useRef, useState } from 'react';
import type { Team, Teammate, LayoutMode } from '../types';
import type { Peer } from '../hooks/usePeers';
import { matchPeerToTeammate } from '../hooks/usePeers';
import { useGridLayout } from '../hooks/useGridLayout';
import { TerminalPanel } from './TerminalPanel';
import { PreviewDrawer } from './PreviewDrawer';
import './TeamWorkspace.css';

interface TeamWorkspaceProps {
  team: Team;
  peers: Peer[];
  onUpdateTeam: (team: Team) => void;
}

const ADD_LEFT = '__add_left__';
const ADD_RIGHT = '__add_right__';
const MIN_CENTER = 0.25;
const MAX_CENTER = 0.8;

type Placement = Record<string, React.CSSProperties>;

function sideOf(t: Teammate, i: number): 'left' | 'right' {
  return t.side ?? (i % 2 === 0 ? 'left' : 'right');
}

// Lead mode: the lead spans the center column; every other teammate sits in its
// assigned side column, with a "new teammate" button at the bottom of each side.
// Children stay in array order so React never reparents a panel, so the running
// shells survive a layout switch.
function leadPlacement(teammates: Teammate[], leadId: string): { placement: Placement; rows: number } {
  const nonLead = teammates.filter(t => t.id !== leadId);
  const left: string[] = [];
  const right: string[] = [];
  nonLead.forEach((t, i) => (sideOf(t, i) === 'left' ? left : right).push(t.id));

  const placement: Placement = {};
  left.forEach((id, k) => { placement[id] = { gridColumn: 1, gridRow: k + 1 }; });
  right.forEach((id, k) => { placement[id] = { gridColumn: 3, gridRow: k + 1 }; });
  placement[ADD_LEFT] = { gridColumn: 1, gridRow: left.length + 1 };
  placement[ADD_RIGHT] = { gridColumn: 3, gridRow: right.length + 1 };

  const rows = Math.max(left.length, right.length) + 1; // +1 row for the add buttons
  placement[leadId] = { gridColumn: 2, gridRow: `1 / span ${rows}` };
  return { placement, rows };
}

export function TeamWorkspace({ team, peers, onUpdateTeam }: TeamWorkspaceProps) {
  const [activeId, setActiveId] = useState<string | null>(team.teammates[0]?.id ?? null);
  const [preview, setPreview] = useState<{ open: boolean; teammateId: string | null; cwd: string | null; name: string }>({
    open: false, teammateId: null, cwd: null, name: '',
  });
  const [centerRatio, setCenterRatio] = useState(team.layout?.centerRatio ?? 0.5);
  const ratioRef = useRef(centerRatio);
  ratioRef.current = centerRatio;
  const wsRef = useRef<HTMLDivElement>(null);

  const mode: LayoutMode = team.layout?.mode ?? 'grid';
  const leadId = team.layout?.leadId && team.teammates.some(t => t.id === team.layout!.leadId)
    ? team.layout.leadId
    : team.teammates[0]?.id;
  const isLeadMode = mode === 'lead' && !!leadId && team.teammates.length > 0;

  const { cols, rows: gridRows } = useGridLayout(team.teammates.length + 1);

  function patchLayout(patch: Partial<NonNullable<Team['layout']>>) {
    const base = team.layout ?? { mode: 'grid' as LayoutMode };
    onUpdateTeam({ ...team, layout: { ...base, ...patch } });
  }

  function setMode(next: LayoutMode) {
    patchLayout({ mode: next, leadId: next === 'lead' ? leadId : team.layout?.leadId });
  }

  function addTeammate(side?: 'left' | 'right') {
    const id = `teammate-${crypto.randomUUID().slice(0, 8)}`;
    const newTeammate: Teammate = {
      id,
      name: `teammate-${String(team.teammates.length + 1).padStart(2, '0')}`,
      command: 'claude',
      cwd: '~/',
      status: 'running',
      activeFile: undefined,
      ...(side ? { side } : {}),
    };
    onUpdateTeam({ ...team, teammates: [...team.teammates, newTeammate] });
    setActiveId(id);
  }

  function removeTeammate(id: string) {
    const teammates = team.teammates.filter(t => t.id !== id);
    onUpdateTeam({ ...team, teammates });
    if (activeId === id) setActiveId(teammates[0]?.id ?? null);
    if (preview.teammateId === id) setPreview({ open: false, teammateId: null, cwd: null, name: '' });
  }

  // A team works in one project: setting a directory moves the whole team there.
  function setTeamCwd(cwd: string) {
    onUpdateTeam({ ...team, teammates: team.teammates.map(t => ({ ...t, cwd })) });
  }

  function updateTeammate(id: string, patch: Partial<Teammate>) {
    onUpdateTeam({
      ...team,
      teammates: team.teammates.map(t => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  function setLead(id: string) {
    const cleared = team.layout?.leadId === id;
    patchLayout({ leadId: cleared ? undefined : id, mode: cleared ? mode : 'lead' });
  }

  function openPreview(teammate: Teammate) {
    // Show the real file this teammate is working on, derived live from its cwd.
    setPreview({ open: true, teammateId: teammate.id, cwd: teammate.cwd, name: teammate.name });
  }

  // ── Resize the center column by dragging a divider ─────────────────────────
  function startResize(which: 'left' | 'right', e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = wsRef.current;
    if (!el) return;

    function onMove(ev: PointerEvent) {
      const rect = el!.getBoundingClientRect();
      const frac = (ev.clientX - rect.left) / rect.width;
      const ratio = which === 'left' ? 1 - 2 * frac : 2 * frac - 1;
      const clamped = Math.min(MAX_CENTER, Math.max(MIN_CENTER, ratio));
      ratioRef.current = clamped;
      setCenterRatio(clamped);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      patchLayout({ centerRatio: ratioRef.current }); // persist final size once
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ── Grid template + per-child placement ────────────────────────────────────
  const sidePct = ((1 - centerRatio) / 2) * 100;
  const centerPct = centerRatio * 100;
  const { placement, rows: leadRows } = isLeadMode
    ? leadPlacement(team.teammates, leadId!)
    : { placement: {} as Placement, rows: 1 };

  const gridStyle: React.CSSProperties = isLeadMode
    ? { gridTemplateColumns: `${sidePct}% ${centerPct}% ${sidePct}%`, gridTemplateRows: `repeat(${leadRows}, 1fr)` }
    : { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${gridRows}, 1fr)` };

  return (
    <div className="workspace" ref={wsRef}>
      <div className="workspace-grid" style={gridStyle}>
        {team.teammates.map((teammate, i) => (
          <div key={teammate.id} className="panel-slot" style={isLeadMode ? placement[teammate.id] : undefined}>
            <TerminalPanel
              teammate={teammate}
              index={i}
              peer={matchPeerToTeammate(peers, teammate, team.id)}
              teamId={team.id}
              isActive={activeId === teammate.id}
              isLead={isLeadMode && leadId === teammate.id}
              onActivate={() => setActiveId(teammate.id)}
              onSetLead={() => setLead(teammate.id)}
              onRename={name => updateTeammate(teammate.id, { name })}
              onSetCwd={cwd => setTeamCwd(cwd)}
              onOpenPreview={() => openPreview(teammate)}
              onRemove={() => removeTeammate(teammate.id)}
            />
          </div>
        ))}

        {isLeadMode ? (
          <>
            <button className="add-panel" style={placement[ADD_LEFT]} onClick={() => addTeammate('left')}>
              <span className="add-panel-icon">+</span>
              <span className="add-panel-label">NEW TEAMMATE</span>
            </button>
            <button className="add-panel" style={placement[ADD_RIGHT]} onClick={() => addTeammate('right')}>
              <span className="add-panel-icon">+</span>
              <span className="add-panel-label">NEW TEAMMATE</span>
            </button>
          </>
        ) : (
          <button className="add-panel" onClick={() => addTeammate()}>
            <span className="add-panel-icon">+</span>
            <span className="add-panel-label">NEW TEAMMATE</span>
          </button>
        )}

        {isLeadMode && (
          <>
            <div
              className="lead-resizer"
              style={{ left: `${sidePct}%` }}
              onPointerDown={e => startResize('left', e)}
              title="Drag to resize the lead"
            />
            <div
              className="lead-resizer"
              style={{ left: `${sidePct + centerPct}%` }}
              onPointerDown={e => startResize('right', e)}
              title="Drag to resize the lead"
            />
          </>
        )}
      </div>

      <div className="layout-dock">
        <div className="layout-switch">
          <button
            className={`layout-btn ${mode === 'grid' ? 'layout-btn--on' : ''}`}
            onClick={() => setMode('grid')}
            title="Auto grid"
          >
            ▦ GRID
          </button>
          <button
            className={`layout-btn ${mode === 'lead' ? 'layout-btn--on' : ''}`}
            onClick={() => setMode('lead')}
            title="Lead in the center, sub-agents on the sides"
          >
            ♔ LEAD
          </button>
        </div>
        <div className="layout-hint" aria-hidden="true">
          <span className="layout-hint-bar" />
          <span className="layout-hint-label">{mode === 'lead' ? '♔ LEAD' : '▦ GRID'}</span>
        </div>
      </div>

      <PreviewDrawer
        open={preview.open}
        cwd={preview.cwd}
        teammateName={preview.name}
        onClose={() => setPreview(p => ({ ...p, open: false }))}
      />
    </div>
  );
}
