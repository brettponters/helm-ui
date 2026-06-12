export interface Teammate {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: 'running' | 'waiting' | 'done' | 'error';
  activeFile?: string;
  side?: 'left' | 'right';   // which side it sits on in lead mode
  systemPrompt?: string;     // role / system prompt configured for this teammate
  model?: string;            // model alias (haiku|sonnet|opus) configured for this teammate
}

export type LayoutMode = 'grid' | 'lead';

export interface TeamLayout {
  mode: LayoutMode;
  leadId?: string;      // teammate shown large in the center (lead mode)
  centerRatio?: number; // 0..1 width fraction of the center column (lead mode)
}

export interface Team {
  id: string;
  name: string;
  teammates: Teammate[];
  layout?: TeamLayout;  // defaults to grid when absent
  /** 'ops' (VERA-internal, default) or 'client' (sealed sandbox: memory never
      shared in, leads can't reach other clients). Enforced by the broker. */
  kind?: 'ops' | 'client';
}

export interface PreviewState {
  open: boolean;
  teammateId: string | null;
  file: string | null;
}

export type ThemeName = 'white' | 'amber' | 'green';
export type CursorStyle = 'block' | 'bar' | 'underline';

export interface Prefs {
  theme: ThemeName;
  fontSize: number;   // terminal font size in px
  glow: number;       // phosphor glow / scanline intensity, 0..1
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

export interface Workspace {
  version: number;
  activeTeamId: string;
  teams: Team[];
  prefs: Prefs;
}

// The orchestrator team, opened via the HELM wordmark, never shown as a tab.
// Its teammates register with the broker under this id, which is what grants
// them global visibility and memory-curation rights (enforced broker-side).
export const HELM_TEAM_ID = 'helm';

export const HELM_ORCHESTRATOR_PROMPT =
  'the Helm, the orchestrator above every team in this workspace. You see all teams (list_teams), ' +
  'message any teammate or team lead across teams (send_message, message_team with team_id), and you are ' +
  'the sole curator of workspace memory (review_memory_inbox, curate_memory, add_memory, recall_memory). ' +
  'Your home directory holds your charter (CLAUDE.md) and per-team state docs (./state/), read them at ' +
  'the start of every session and keep them current. Orchestrate through team leads, not workers. ' +
  'You do not do object-level work yourself: you direct, connect, and remember.';

export const DEFAULT_PREFS: Prefs = {
  theme: 'white',
  fontSize: 12,
  glow: 0.4,
  cursorStyle: 'block',
  cursorBlink: true,
};
