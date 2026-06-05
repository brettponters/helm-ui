import { useEffect, useRef, useState } from 'react';
import type { Team, Teammate, LayoutMode } from '../types';
import type { Peer } from '../hooks/usePeers';
import type { PreviewRequest } from '../App';
import { matchPeerToTeammate } from '../hooks/usePeers';
import { useGridLayout } from '../hooks/useGridLayout';
import { TerminalPanel } from './TerminalPanel';
import { PreviewDrawer } from './PreviewDrawer';
import './TeamWorkspace.css';

interface TeamWorkspaceProps {
  team: Team;
  peers: Peer[];
  onUpdateTeam: (team: Team) => void;
  previewRequest?: PreviewRequest | null;
}

const MIN_CENTER = 0.25;
const MAX_CENTER = 0.8;

type Placement = Record<string, React.CSSProperties>;

function sideOf(t: Teammate, i: number): 'left' | 'right' {
  return t.side ?? (i % 2 === 0 ? 'left' : 'right');
}

// Lead mode: the lead spans the center column; every other teammate sits in its
// assigned side column. Children stay in array order so React never reparents a
// panel, so the running shells survive a layout switch.
function leadPlacement(teammates: Teammate[], leadId: string): { placement: Placement; rows: number } {
  const nonLead = teammates.filter(t => t.id !== leadId);
  const left: string[] = [];
  const right: string[] = [];
  nonLead.forEach((t, i) => (sideOf(t, i) === 'left' ? left : right).push(t.id));

  const placement: Placement = {};
  left.forEach((id, k) => { placement[id] = { gridColumn: 1, gridRow: k + 1 }; });
  right.forEach((id, k) => { placement[id] = { gridColumn: 3, gridRow: k + 1 }; });

  const rows = Math.max(left.length, right.length, 1);
  placement[leadId] = { gridColumn: 2, gridRow: `1 / span ${rows}` };
  return { placement, rows };
}

export function TeamWorkspace({ team, peers, onUpdateTeam, previewRequest }: TeamWorkspaceProps) {
  const [activeId, setActiveId] = useState<string | null>(team.teammates[0]?.id ?? null);
  const lastPreviewNonce = useRef<number | null>(null);
  const previewKey = useRef(0);
  const [preview, setPreview] = useState<{ open: boolean; teammateId: string | null; cwd: string | null; name: string; file: string | null; key: number }>({
    open: false, teammateId: null, cwd: null, name: '', file: null, key: 0,
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

  const { cols, rows: gridRows } = useGridLayout(Math.max(1, team.teammates.length));

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
    if (preview.teammateId === id) setPreview({ open: false, teammateId: null, cwd: null, name: '', file: null, key: 0 });
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

  function openPreview(teammate: Teammate, file: string | null = null) {
    previewKey.current += 1;
    setPreview({ open: true, teammateId: teammate.id, cwd: teammate.cwd, name: teammate.name, file, key: previewKey.current });
  }

  // An agent asked (via MCP) to preview a specific file in its panel.
  useEffect(() => {
    if (!previewRequest || previewRequest.team !== team.id) return;
    if (lastPreviewNonce.current === previewRequest.nonce) return;
    lastPreviewNonce.current = previewRequest.nonce;
    const mate = team.teammates.find(t => t.name === previewRequest.teammate);
    if (mate) {
      setActiveId(mate.id);
      openPreview(mate, previewRequest.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRequest, team.id]);

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
              onSetRole={(role, model) => updateTeammate(teammate.id, { systemPrompt: role || undefined, model: model || undefined })}
              onOpenPreview={() => openPreview(teammate)}
              onRemove={() => removeTeammate(teammate.id)}
            />
          </div>
        ))}

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

      {team.teammates.length === 0 ? (
        // Empty team: one clear call to action filling the otherwise blank space.
        <button className="workspace-empty" onClick={() => addTeammate()}>
          <span className="workspace-empty-icon">+</span>
          <span className="workspace-empty-label">ADD YOUR FIRST TEAMMATE</span>
        </button>
      ) : (
        // Otherwise a small, out-of-the-way control so panels keep the real estate.
        <button className="workspace-add" onClick={() => addTeammate()} title="New teammate">
          <span className="workspace-add-icon">+</span>
          <span className="workspace-add-label">TEAMMATE</span>
        </button>
      )}

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
        file={preview.file}
        requestKey={preview.key}
        onClose={() => setPreview(p => ({ ...p, open: false }))}
      />
    </div>
  );
}
