import { useEffect, useState } from 'react';
import type { Team, Prefs, Workspace } from './types';
import { HELM_TEAM_ID, HELM_ORCHESTRATOR_PROMPT } from './types';
import { TopBar } from './components/TopBar';
import { TeamWorkspace } from './components/TeamWorkspace';
import { SettingsPanel } from './components/SettingsPanel';
import { PrefsContext } from './context/PrefsContext';
import { usePeers } from './hooks/usePeers';
import { useWorkspace } from './hooks/useWorkspace';
import { useUiCommands } from './hooks/useUiCommands';
import './styles/global.css';
import './App.css';

export default function App() {
  const { workspace, save } = useWorkspace();
  const { peers, connected } = usePeers();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Apply commands an agent issued via MCP (rename its own panel).
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

  // Drag-to-reorder tabs. The teams array order IS the tab order, so this
  // persists through the workspace like everything else. The hidden helm team
  // keeps its array position; we only move the dragged team around the target.
  function reorderTeam(dragId: string, targetId: string, before: boolean) {
    if (dragId === targetId) return;
    const arr = [...teams];
    const fromIdx = arr.findIndex(t => t.id === dragId);
    if (fromIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    const targetIdx = arr.findIndex(t => t.id === targetId);
    if (targetIdx < 0) return;
    arr.splice(before ? targetIdx : targetIdx + 1, 0, moved);
    save({ ...workspace!, teams: arr });
  }

  // Flip a team between operations (VERA-internal) and client (sealed
  // sandbox). The broker reads this from the workspace and enforces it.
  function toggleTeamKind(id: string) {
    save({
      ...workspace!,
      teams: teams.map(t => (t.id === id
        ? { ...t, kind: t.kind === 'client' ? 'ops' as const : 'client' as const }
        : t)),
    });
  }

  function deleteTeam(id: string) {
    if (teams.length <= 1) return; // always keep at least one team
    const remaining = teams.filter(t => t.id !== id);
    const activeId = activeTeamId === id ? remaining[0].id : activeTeamId;
    save({ ...workspace!, teams: remaining, activeTeamId: activeId });
  }

  // The HELM wordmark opens the orchestrator's own team, created on first
  // visit with "the-helm" pre-cast as the orchestrator (role + opus). It can
  // grow helpers like any team, but never appears as a tab.
  function openHelm() {
    const existing = teams.find(t => t.id === HELM_TEAM_ID);
    if (existing) {
      save({ ...workspace!, activeTeamId: HELM_TEAM_ID });
      return;
    }
    const helmTeam: Team = {
      id: HELM_TEAM_ID,
      name: 'THE HELM',
      teammates: [{
        id: `teammate-${crypto.randomUUID().slice(0, 8)}`,
        name: 'the-helm',
        command: 'claude',
        cwd: '~/.helm/admiral',
        status: 'running',
        systemPrompt: HELM_ORCHESTRATOR_PROMPT,
        model: 'opus',
      }],
    };
    save({ ...workspace!, teams: [...teams, helmTeam], activeTeamId: HELM_TEAM_ID });
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
          teams={teams.filter(t => t.id !== HELM_TEAM_ID)}
          activeTeamId={activeTeamId}
          brokerConnected={connected}
          activeCount={peers.filter(p => p.team_id === activeTeamId).length}
          helmActive={activeTeamId === HELM_TEAM_ID}
          onSelectTeam={setActiveTeam}
          onAddTeam={addTeam}
          onRenameTeam={renameTeam}
          onDeleteTeam={deleteTeam}
          onToggleTeamKind={toggleTeamKind}
          onReorderTeam={reorderTeam}
          onOpenHelm={openHelm}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Only the active team is mounted. Shells live in the PTY daemon and
            survive unmounting (and app restarts), switching teams reattaches
            and replays recent output, so hidden teams cost no renderer memory. */}
        {teams.filter((team: Workspace['teams'][number]) => team.id === activeTeamId).map(team => (
          <TeamWorkspace
            key={team.id}
            team={team}
            peers={peers}
            onUpdateTeam={updateTeam}
          />
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
