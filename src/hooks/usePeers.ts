import { useState, useEffect } from 'react';

const BROKER = 'http://127.0.0.1:7900';
const POLL_MS = 2000;

export interface Peer {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  team_id: string;
  agent_name: string | null;
  last_seen: string;
}

export interface PeersState {
  peers: Peer[];
  byTeam: Record<string, Peer[]>;
  connected: boolean;
}

export function usePeers(): PeersState {
  const [state, setState] = useState<PeersState>({ peers: [], byTeam: {}, connected: false });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${BROKER}/peers`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok || cancelled) return;
        const data: { peers: Peer[] } = await res.json();

        const byTeam: Record<string, Peer[]> = {};
        for (const p of data.peers) {
          if (!byTeam[p.team_id]) byTeam[p.team_id] = [];
          byTeam[p.team_id].push(p);
        }

        if (!cancelled) setState({ peers: data.peers, byTeam, connected: true });
      } catch {
        if (!cancelled) setState(s => ({ ...s, connected: false }));
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return state;
}

/**
 * Match a live peer to a teammate panel. Prefers exact identity (same team +
 * agent name, set by helm-teammates) so multiple panels sharing a directory each
 * map to their own session; falls back to working-directory matching for peers
 * that registered without a name.
 */
export function matchPeerToTeammate(
  peers: Peer[],
  teammate: { name: string; cwd: string },
  teamId: string,
): Peer | null {
  const byIdentity = peers.find(
    p => p.team_id === teamId && p.agent_name === teammate.name,
  );
  if (byIdentity) return byIdentity;

  const norm = teammate.cwd.replace('~', '');
  return peers.find(p => p.cwd.endsWith(norm) || p.cwd === teammate.cwd) ?? null;
}
