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

  // Apply commands an agent issued via MCP (rename its own panel). Applied via
  // a functional update against the freshest workspace so a poll firing
  // mid-edit can't clobber a concurrent change.
  useUiCommands(cmds => {
    const renames = cmds.filter(c => c.type === 'rename' && c.team && c.teammate && c.name);
    if (!renames.length) return;
    save(prev => ({
      ...prev,
      teams: prev.teams.map(t => {
        const forTeam = renames.filter(c => c.team === t.id);
        if (!forTeam.length) return t;
        return {
          ...t,
          teammates: t.teammates.map(m => {
            const hit = forTeam.find(c => c.teammate === m.name);
            return hit ? { ...m, name: hit.name! } : m;
          }),
        };
      }),
    }));
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
    save(prev => ({ ...prev, activeTeamId: id }));
  }

  function addTeam() {
    const id = `team-${crypto.randomUUID().slice(0, 8)}`;
    save(prev => ({
      ...prev,
      teams: [...prev.teams, { id, name: `TEAM ${prev.teams.length + 1}`, teammates: [] }],
      activeTeamId: id,
    }));
  }

  function renameTeam(id: string, name: string) {
    save(prev => ({ ...prev, teams: prev.teams.map(t => (t.id === id ? { ...t, name } : t)) }));
  }

  // Drag-to-reorder tabs. The teams array order IS the tab order, so this
  // persists through the workspace like everything else. The hidden helm team
  // keeps its array position; we only move the dragged team around the target.
  function reorderTeam(dragId: string, targetId: string, before: boolean) {
    if (dragId === targetId) return;
    save(prev => {
      const arr = [...prev.teams];
      const fromIdx = arr.findIndex(t => t.id === dragId);
      if (fromIdx < 0) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      const targetIdx = arr.findIndex(t => t.id === targetId);
      if (targetIdx < 0) return prev;
      arr.splice(before ? targetIdx : targetIdx + 1, 0, moved);
      return { ...prev, teams: arr };
    });
  }

  function deleteTeam(id: string) {
    save(prev => {
      if (prev.teams.length <= 1) return prev; // always keep at least one team
      const remaining = prev.teams.filter(t => t.id !== id);
      const activeTeamId = prev.activeTeamId === id ? remaining[0].id : prev.activeTeamId;
      return { ...prev, teams: remaining, activeTeamId };
    });
  }

  // The HELM wordmark opens the orchestrator's own team, created on first
  // visit with "the-helm" pre-cast as the orchestrator (role + opus). It can
  // grow helpers like any team, but never appears as a tab.
  //
  // Every visit HEALS the team: if the orchestrator panel was removed or
  // re-added bare (no role, no model, no admiral home), it gets repaired -
  // the Helm must never sit in a panel that doesn't know it's the Helm.
  function openHelm() {
    const freshOrchestrator = () => ({
      id: `teammate-${crypto.randomUUID().slice(0, 8)}`,
      name: 'the-helm',
      command: 'claude',
      cwd: '~/.helm/admiral',
      status: 'running' as const,
      systemPrompt: HELM_ORCHESTRATOR_PROMPT,
      model: 'opus',
    });

    save(prev => {
      const existing = prev.teams.find(t => t.id === HELM_TEAM_ID);
      if (!existing) {
        const helmTeam: Team = { id: HELM_TEAM_ID, name: 'THE HELM', teammates: [freshOrchestrator()] };
        return { ...prev, teams: [...prev.teams, helmTeam], activeTeamId: HELM_TEAM_ID };
      }
      const teammates = existing.teammates.length === 0
        ? [freshOrchestrator()]
        : existing.teammates.map((m, i) => (i === 0
          ? {
              ...m,
              systemPrompt: m.systemPrompt?.trim() ? m.systemPrompt : HELM_ORCHESTRATOR_PROMPT,
              model: m.model || 'opus',
              cwd: !m.cwd || m.cwd === '~/' ? '~/.helm/admiral' : m.cwd,
            }
          : m));
      const healed: Team = { ...existing, teammates };
      return {
        ...prev,
        teams: prev.teams.map(t => (t.id === HELM_TEAM_ID ? healed : t)),
        activeTeamId: HELM_TEAM_ID,
      };
    });
  }

  function updateTeam(updated: Team) {
    save(prev => ({ ...prev, teams: prev.teams.map(t => (t.id === updated.id ? updated : t)) }));
  }

  function updatePrefs(patch: Partial<Prefs>) {
    save(prev => ({ ...prev, prefs: { ...prev.prefs, ...patch } }));
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
          onReorderTeam={reorderTeam}
          onOpenHelm={openHelm}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* All teams stay mounted; only the active one is shown (the rest are
            display:none). Switching tabs must NOT unmount a team, unmounting
            tears down its terminals' websockets and disrupts the live session.
            Hiding keeps every shell connected and rendered, so switching is
            instant and seamless. (Sessions are also daemon-backed, so they
            survive a full app restart on top of this.) */}
        {teams.map((team: Workspace['teams'][number]) => (
          <div
            key={team.id}
            className="team-mount"
            style={{ display: team.id === activeTeamId ? 'contents' : 'none' }}
          >
            <TeamWorkspace
              team={team}
              peers={peers}
              onUpdateTeam={updateTeam}
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
