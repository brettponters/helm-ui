import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './RolePopover.css';

interface RolePopoverProps {
  name: string;
  current: string;            // the teammate's existing role/system prompt
  currentModel?: string;      // the teammate's existing model alias ('' = default)
  onSave: (role: string, model: string) => void;
  onClose: () => void;
}

const MAX_ROLE = 4000; // safely fits an env var + --append-system-prompt arg

// Model tiers Claude Code accepts as --model aliases. '' = Claude Code default.
const MODELS: { label: string; value: string; hint: string }[] = [
  { label: 'Default', value: '',       hint: 'Claude Code default' },
  { label: 'Haiku',   value: 'haiku',  hint: 'fast & cheap, grunt work' },
  { label: 'Sonnet',  value: 'sonnet', hint: 'balanced, real coding' },
  { label: 'Opus',    value: 'opus',   hint: 'deepest, orchestration' },
];

// A real library of starting roles, grouped, one click drops a system prompt in.
const PRESET_GROUPS: { group: string; items: { label: string; prompt: string }[] }[] = [
  {
    group: 'Engineering',
    items: [
      { label: 'Code Reviewer', prompt: 'You are the team\'s code reviewer. Read every diff for correctness, security, and clarity; surface the highest-impact issues first, cite file:line, and propose the fix. Approve nothing you would not ship yourself.' },
      { label: 'Implementer', prompt: 'You are an implementer on this team. Match the codebase\'s existing patterns, keep each change small and focused, handle errors explicitly, and explain only the decisions that aren\'t obvious from the code.' },
      { label: 'Debugger', prompt: 'You are the debugger. Reproduce before you theorize, prove the root cause with evidence (a failing test, a log, a print) before touching code, and fix the cause, never the symptom. State your hypothesis out loud.' },
      { label: 'Refactorer', prompt: 'You are the refactoring specialist. Improve structure and naming without changing behavior, move in small reversible steps, and keep the tests green after each one. If behavior must change, stop and say so first.' },
      { label: 'Architect', prompt: 'You are the software architect. Before any code, lay out the design: boundaries, data flow, failure modes, and the trade-offs you\'re accepting. Prefer the simplest design that survives the real requirements.' },
      { label: 'Test Engineer', prompt: 'You are the test engineer. Write the test first, cover the edge and failure paths, and assert on real behavior, not implementation details. Coverage is a tool, not the goal.' },
      { label: 'Security Auditor', prompt: 'You are the security auditor. Hunt injection, auth gaps, secret leakage, SSRF, and unsafe input handling. Rate each finding by severity, show how it\'s exploited, and give the concrete fix.' },
      { label: 'Performance Eng', prompt: 'You are the performance engineer. Profile before you touch anything, fix the actual bottleneck, and back every change with before/after numbers. No speculative optimization.' },
      { label: 'DevOps / CI', prompt: 'You are the DevOps engineer. Own builds, CI, and deploys; keep pipelines fast, reproducible, and loud on failure. Never paper over a red build to ship.' },
    ],
  },
  {
    group: 'Research & Data',
    items: [
      { label: 'Researcher', prompt: 'You are the research lead. Investigate widely, cite primary sources, weigh trade-offs honestly, and give a clear recommendation with its reasoning. Separate what\'s known from what\'s assumed.' },
      { label: 'Data Analyst', prompt: 'You are the data analyst. Check data quality first, state your assumptions, quantify uncertainty, and never report a correlation as a cause.' },
      { label: 'ML Engineer', prompt: 'You are the ML engineer. Set a baseline before any change, never tune on the test set, and report the lift over baseline, not just the headline number.' },
    ],
  },
  {
    group: 'Writing & Docs',
    items: [
      { label: 'Technical Writer', prompt: 'You are the technical writer. Lead with what the reader needs, keep examples runnable, define each term once, and cut every word that doesn\'t earn its place.' },
      { label: 'Editor', prompt: 'You are the editor. Tighten the prose, fix structure and flow, kill jargon and filler, and sharpen the writing while keeping the author\'s voice.' },
    ],
  },
  {
    group: 'Product & Business',
    items: [
      { label: 'Product Manager', prompt: 'You are the product manager. Start from the user\'s problem, challenge scope before adding features, and push for the smallest thing that delivers real value. Ask why before how.' },
      { label: 'Underwriter', prompt: 'You are the underwriter. Work the numbers, stress-test the assumptions, surface the downside case, and never sign off without a clear-eyed view of the risk.' },
      { label: 'Market Analyst', prompt: 'You are the market analyst. Size the opportunity with explicit assumptions, map the real competition, and separate signal from hype.' },
    ],
  },
  {
    group: 'Working Styles',
    items: [
      { label: 'Pair Programmer', prompt: 'You are a pair programmer. Think out loud, propose the next small step, and check in before any large change. Keep the human in the loop and the feedback tight.' },
      { label: 'Critic', prompt: 'You are the devil\'s advocate. Find what\'s wrong: weak assumptions, missing cases, and risks the team is glossing over. Be blunt, specific, and fair.' },
      { label: 'Planner', prompt: 'You are the planner. Break the work into a clear, sequenced plan with dependencies and risks before any code is written. Plan only, don\'t implement.' },
      { label: 'Explainer', prompt: 'You are the explainer. Teach as you go: give the why behind each decision in plain language for a smart non-expert, and skip the jargon.' },
    ],
  },
];

export function RolePopover({ name, current, currentModel, onSave, onClose }: RolePopoverProps) {
  const [value, setValue] = useState(current);
  const [model, setModel] = useState(currentModel ?? '');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const dirty = value.trim() !== current.trim() || model !== (currentModel ?? '');

  function save() {
    onSave(value.trim().slice(0, MAX_ROLE), model);
  }

  // Portal to <body> so the modal escapes its panel's stacking context and never
  // clips behind a neighbouring terminal.
  return createPortal(
    <div className="rolemodal-backdrop" onClick={onClose}>
      <div className="rolemodal" onClick={e => e.stopPropagation()}>
        <div className="rolemodal-head">
          <span className="rolemodal-title">SET UP TEAMMATE</span>
          <span className="rolemodal-name">{name}</span>
          <button className="rolemodal-x" onClick={onClose} title="Close (Esc)"><X size={16} strokeWidth={1.75} /></button>
        </div>

        <div className="rolemodal-modelrow">
          <span className="rolemodal-rowlabel">MODEL</span>
          <div className="rolemodal-models">
            {MODELS.map(m => (
              <button
                key={m.value || 'default'}
                className={`rolemodal-model ${model === m.value ? 'rolemodal-model--on' : ''}`}
                title={m.hint}
                onClick={() => setModel(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rolemodal-body">
          <div className="rolemodal-library">
            {PRESET_GROUPS.map(g => (
              <div key={g.group} className="rolemodal-group">
                <div className="rolemodal-grouplabel">{g.group}</div>
                <div className="rolemodal-chips">
                  {g.items.map(item => (
                    <button
                      key={item.label}
                      className={`rolemodal-chip ${value.trim() === item.prompt ? 'rolemodal-chip--on' : ''}`}
                      title={item.prompt}
                      onClick={() => { setValue(item.prompt); areaRef.current?.focus(); }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rolemodal-editor">
            <div className="rolemodal-rowlabel">ROLE / SYSTEM PROMPT</div>
            <textarea
              ref={areaRef}
              className="rolemodal-area"
              value={value}
              spellCheck={false}
              maxLength={MAX_ROLE}
              placeholder="Pick a role above, or write your own, e.g. You are the underwriter. Analyze deal numbers, flag risks, never approve without a downside case."
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
                else if (e.key === 'Escape') onClose();
              }}
            />
          </div>
        </div>

        <div className="rolemodal-foot">
          <span className="rolemodal-count">{value.length}/{MAX_ROLE} · ⌘⏎ save · Esc cancel</span>
          <div className="rolemodal-actions">
            {(current || currentModel) && (
              <button className="rolemodal-clear" onClick={() => onSave('', '')} title="Clear role and model">CLEAR</button>
            )}
            <button className="rolemodal-save" disabled={!dirty} onClick={save}>SAVE</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
