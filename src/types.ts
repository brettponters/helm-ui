export interface Teammate {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: 'running' | 'waiting' | 'done' | 'error';
  activeFile?: string;
  side?: 'left' | 'right'; // which side it sits on in lead mode
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

export const DEFAULT_PREFS: Prefs = {
  theme: 'white',
  fontSize: 12,
  glow: 0.4,
  cursorStyle: 'block',
  cursorBlink: true,
};
