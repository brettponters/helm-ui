import { useEffect, useState } from 'react';
import type { Team, Prefs, Workspace } from './types';
import { TopBar } from './components/TopBar';
import { TeamWorkspace } from './components/TeamWorkspace';
import { SettingsPanel } from './components/SettingsPanel';
import { PrefsContext } from './context/PrefsContext';
import { usePeers } from './hooks/usePeers';
import { useWorkspace } from './hooks/useWorkspace';
import { useUiCommands } from './hooks/useUiCommands';
import './styles/global.css';
import './App.css';

export interface PreviewRequest { team: string; teammate: string; file: string | null; nonce: number; }

export default function App() {
  const { workspace, save } = useWorkspace();
  const { peers, connected } = usePeers();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);

  // Apply commands an agent issued via MCP (rename itself, open its preview).
  useUiCommands(cmds => {
    if (!workspace) return;
    let next = workspace;
    let changed = false;
    for (const c of cmds) {
      if (c.type === 'rename' && c.team && c.teammate && c.name) {
        next = {
          ...next,
          teams: next.teams.map(t => t.id === c.team
            ? { ...t, teammates: t.teammates.map(m => m.name === c.teammate ? { ...m, name: c.name! } : m) }
            : t),
        };
        changed = true;
      } else if (c.type === 'open-preview' && c.team && c.teammate) {
        next = { ...next, activeTeamId: c.team };
        changed = true;
        setPreviewRequest({ team: c.team, teammate: c.teammate, file: c.file ?? null, nonce: c.id });
      }
    }
    if (changed) save(next);
  });

  // Apply the active theme + glow to the document so all CSS-driven surfaces
  // (panels, top bar, drawers) restyle. Terminals read prefs via context.
  useEffect(() => {
    if (!workspace) return;
    const root = document.documentElement;
    root.dataset.theme = workspace.prefs.theme;
    root.style.setProperty('--term-glow', String(workspace.prefs.glow));
  }, [workspace]);

  if (!workspace) return <div className="app app--loading" />;

  const { teams, activeTeamId, prefs } = workspace;

  function setActiveTeam(id: string) {
    save({ ...workspace!, activeTeamId: id });
  }

  function addTeam() {
    const id = `team-${crypto.randomUUID().slice(0, 8)}`;
    const name = `TEAM ${teams.length + 1}`;
    const newTeam: Team = { id, name, teammates: [] };
    save({ ...workspace!, teams: [...teams, newTeam], activeTeamId: id });
  }

  function renameTeam(id: string, name: string) {
    save({ ...workspace!, teams: teams.map(t => (t.id === id ? { ...t, name } : t)) });
  }

  function deleteTeam(id: string) {
    if (teams.length <= 1) return; // always keep at least one team
    const remaining = teams.filter(t => t.id !== id);
    const activeId = activeTeamId === id ? remaining[0].id : activeTeamId;
    save({ ...workspace!, teams: remaining, activeTeamId: activeId });
  }

  function updateTeam(updated: Team) {
    save({ ...workspace!, teams: teams.map(t => (t.id === updated.id ? updated : t)) });
  }

  function updatePrefs(patch: Partial<Prefs>) {
    save({ ...workspace!, prefs: { ...prefs, ...patch } });
  }

  return (
    <PrefsContext.Provider value={prefs}>
      <div className="app">
        <TopBar
          teams={teams}
          activeTeamId={activeTeamId}
          brokerConnected={connected}
          activeCount={peers.filter(p => p.team_id === activeTeamId).length}
          onSelectTeam={setActiveTeam}
          onAddTeam={addTeam}
          onRenameTeam={renameTeam}
          onDeleteTeam={deleteTeam}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* All teams stay mounted so their shells keep running; only the active
            one is shown. Hiding (not unmounting) preserves every PTY session. */}
        {teams.map((team: Workspace['teams'][number]) => (
          <div
            key={team.id}
            style={{ display: team.id === activeTeamId ? 'contents' : 'none' }}
          >
            <TeamWorkspace
              team={team}
              peers={peers}
              onUpdateTeam={updateTeam}
              previewRequest={previewRequest}
            />
          </div>
        ))}

        {settingsOpen && (
          <SettingsPanel
            prefs={prefs}
            onChange={updatePrefs}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </PrefsContext.Provider>
  );
}
