import { useEffect, useRef } from 'react';

const BROKER = 'http://127.0.0.1:7900';
const POLL_MS = 1000;

export interface UiCommand {
  id: number;
  type: 'rename';
  team?: string;
  teammate?: string;
  name?: string;
}

/**
 * Polls the broker for commands an agent issued via MCP (rename itself, open its
 * preview…) and hands each new one to `onCommands`. The callback is read through
 * a ref so the poller subscribes once and always runs the latest version.
 */
export function useUiCommands(onCommands: (cmds: UiCommand[]) => void): void {
  const ref = useRef(onCommands);
  ref.current = onCommands;

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`${BROKER}/ui-commands`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok || cancelled) return;
        const data: { commands?: UiCommand[] } = await res.json();
        if (data.commands?.length && !cancelled) ref.current(data.commands);
      } catch {
        // broker not reachable yet, keep polling
      }
    }
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
