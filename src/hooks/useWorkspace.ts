import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../types';
import { DEFAULT_PREFS } from '../types';
import { MOCK_TEAMS } from '../data/mock';

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
  save: (next: Workspace) => void;
}

/**
 * Loads the persisted workspace from the broker (seeding a default on first
 * run), holds it in state, and debounce-persists every change so teams,
 * teammates, renames, working directories, and prefs survive reloads.
 */
export function useWorkspace(): UseWorkspace {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
        setWorkspace(migrate(ws));
      } else {
        const seeded = seedDefault();
        setWorkspace(seeded);
        persist(seeded);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback((next: Workspace) => {
    setWorkspace(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(next), SAVE_DEBOUNCE_MS);
  }, []);

  return { workspace, save };
}
