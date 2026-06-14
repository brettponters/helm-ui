import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../types';
import { DEFAULT_PREFS } from '../types';
import { MOCK_TEAMS } from '../data/mock';

type Updater = Workspace | ((prev: Workspace) => Workspace);

const BROKER = 'http://127.0.0.1:7900';
const SAVE_DEBOUNCE_MS = 400;

function seedDefault(): Workspace {
  return {
    version: 1,
    activeTeamId: MOCK_TEAMS[0].id,
    teams: MOCK_TEAMS,
    prefs: DEFAULT_PREFS,
  };
}

// Tolerate older/partial stored shapes by filling in any missing prefs.
function migrate(ws: Workspace): Workspace {
  return { ...ws, prefs: { ...DEFAULT_PREFS, ...(ws.prefs ?? {}) } };
}

async function persist(ws: Workspace): Promise<void> {
  try {
    await fetch(`${BROKER}/workspace`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ws),
    });
  } catch {
    // Broker offline, the in-memory workspace still works for this session.
  }
}

interface UseWorkspace {
  workspace: Workspace | null; // null while loading
  // Accepts a functional updater so every mutation applies against the FRESHEST
  // state, never a captured stale snapshot, otherwise a late save from an old
  // closure (a layout auto-save, a poll) could clobber a concurrent change like
  // a team deletion and resurrect it.
  save: (next: Updater) => void;
}

/**
 * Loads the persisted workspace from the broker (seeding a default on first
 * run), holds it in state, and debounce-persists every change so teams,
 * teammates, renames, working directories, and prefs survive reloads.
 */
export function useWorkspace(): UseWorkspace {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The freshest workspace, updated synchronously inside every state update so
  // the debounced persist always writes the latest merged result rather than
  // whatever snapshot a particular caller happened to capture.
  const latest = useRef<Workspace | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let ws: Workspace | null = null;
      try {
        const res = await fetch(`${BROKER}/workspace`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) ws = (await res.json()).workspace;
      } catch {
        // fall through to seed
      }
      if (cancelled) return;
      if (ws && Array.isArray(ws.teams) && ws.teams.length) {
        const migrated = migrate(ws);
        latest.current = migrated;
        setWorkspace(migrated);
      } else {
        const seeded = seedDefault();
        latest.current = seeded;
        setWorkspace(seeded);
        persist(seeded);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback((next: Updater) => {
    setWorkspace(prev => {
      const base = prev ?? latest.current;
      if (!base) return prev;
      const resolved = typeof next === 'function' ? next(base) : next;
      latest.current = resolved;
      return resolved;
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (latest.current) persist(latest.current); }, SAVE_DEBOUNCE_MS);
  }, []);

  return { workspace, save };
}
