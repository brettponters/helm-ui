import { useState } from 'react';
import { Settings, Plus } from 'lucide-react';
import { CrownMark } from './CrownMark';
import type { Team } from '../types';
import './TopBar.css';

interface TopBarProps {
  teams: Team[];
  activeTeamId: string;
  brokerConnected: boolean;
  activeCount: number;
  helmActive: boolean;
  onSelectTeam: (id: string) => void;
  onAddTeam: () => void;
  onRenameTeam: (id: string, name: string) => void;
  onDeleteTeam: (id: string) => void;
  onToggleTeamKind: (id: string) => void;
  onReorderTeam: (dragId: string, targetId: string, before: boolean) => void;
  onOpenHelm: () => void;
  onOpenSettings: () => void;
}

export function TopBar({
  teams, activeTeamId, brokerConnected, activeCount, helmActive,
  onSelectTeam, onAddTeam, onRenameTeam, onDeleteTeam, onToggleTeamKind, onReorderTeam, onOpenHelm, onOpenSettings,
}: TopBarProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Drag-to-reorder: which tab is being dragged, and where it would land.
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);

  function endDrag() {
    setDragId(null);
    setDrop(null);
  }

  function startEdit(team: Team, e: React.MouseEvent) {
    e.stopPropagation();
    setEditing(team.id);
    setEditValue(team.name);
  }

  function commitEdit(id: string) {
    if (editValue.trim()) onRenameTeam(id, editValue.trim().toUpperCase());
    setEditing(null);
  }

  function confirmDelete(id: string) {
    onDeleteTeam(id);
    setConfirmId(null);
  }

  return (
    <header className="topbar">
      <button
        className={`topbar-logo ${helmActive ? 'topbar-logo--active' : ''}`}
        title="The Helm, the orchestrator above every team"
        onClick={onOpenHelm}
      >
        <span className="logo-mark"><CrownMark size={18} animate /></span>
        <span className="logo-text">HELM</span>
      </button>

      <nav className="topbar-tabs">
        {teams.map(team => (
          <div
            key={team.id}
            role="button"
            tabIndex={0}
            className={[
              'tab',
              team.id === activeTeamId ? 'tab--active' : '',
              dragId === team.id ? 'tab--dragging' : '',
              drop?.id === team.id ? (drop.before ? 'tab--drop-before' : 'tab--drop-after') : '',
            ].filter(Boolean).join(' ')}
            draggable={editing !== team.id && confirmId !== team.id}
            onDragStart={e => {
              setDragId(team.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', team.id); // required by some engines to start a drag
            }}
            onDragOver={e => {
              if (!dragId || dragId === team.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              const before = e.clientX < r.left + r.width / 2;
              if (drop?.id !== team.id || drop.before !== before) setDrop({ id: team.id, before });
            }}
            onDragLeave={() => { if (drop?.id === team.id) setDrop(null); }}
            onDrop={e => {
              e.preventDefault();
              if (dragId && dragId !== team.id && drop?.id === team.id) {
                onReorderTeam(dragId, team.id, drop.before);
              }
              endDrag();
            }}
            onDragEnd={endDrag}
            onClick={() => onSelectTeam(team.id)}
            onDoubleClick={e => startEdit(team, e)}
          >
            {editing === team.id ? (
              <input
                className="tab-input"
                value={editValue}
                autoFocus
                onChange={e => setEditValue(e.target.value.toUpperCase())}
                onBlur={() => commitEdit(team.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitEdit(team.id);
                  if (e.key === 'Escape') setEditing(null);
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : confirmId === team.id ? (
              <span className="tab-confirm" onClick={e => e.stopPropagation()}>
                <span className="tab-confirm-label">delete?</span>
                <span className="tab-confirm-yes" title="Confirm delete" onClick={() => confirmDelete(team.id)}>✓</span>
                <span className="tab-confirm-no" title="Cancel" onClick={() => setConfirmId(null)}>✕</span>
              </span>
            ) : (
              <>
                <span className="tab-name">{team.name}</span>
                <span className="tab-count">{team.teammates.length}</span>
                <span
                  className={`tab-kind ${team.kind === 'client' ? 'tab-kind--client' : ''}`}
                  title={team.kind === 'client'
                    ? 'CLIENT team, sealed sandbox: no shared memory in, no contact with other clients. Click to make it an operations team.'
                    : 'Operations team (VERA-internal). Click to mark as a CLIENT team (sealed sandbox).'}
                  onClick={e => { e.stopPropagation(); onToggleTeamKind(team.id); }}
                >
                  {team.kind === 'client' ? 'CLIENT' : 'OPS'}
                </span>
                {teams.length > 1 && (
                  <span
                    className="tab-del"
                    title="Delete team"
                    onClick={e => { e.stopPropagation(); setConfirmId(team.id); }}
                  >
                    ✕
                  </span>
                )}
              </>
            )}
          </div>
        ))}

        <button className="tab-add" onClick={onAddTeam} title="New team">
          <Plus size={16} strokeWidth={1.75} />
        </button>
      </nav>

      <div className="topbar-actions">
        <div
          className="broker-status"
          title={
            !brokerConnected ? 'Helm broker offline'
              : activeCount > 0 ? `${activeCount} live teammate${activeCount > 1 ? 's' : ''} in this team`
              : 'No teammates running yet, type `claude helm` in a panel'
          }
        >
          <span className={`broker-dot ${brokerConnected && activeCount > 0 ? 'broker-dot--on' : 'broker-dot--off'}`} />
          <span className="broker-label">
            {!brokerConnected ? 'OFFLINE' : activeCount > 0 ? `${activeCount} ACTIVE` : 'IDLE'}
          </span>
        </div>
        <button className="action-btn" title="Settings" onClick={onOpenSettings}>
          <Settings size={19} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
