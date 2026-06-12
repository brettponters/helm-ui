#!/usr/bin/env node
/**
 * Helm MCP, cross-teammate chat for Claude Code panels in Helm.
 *
 * One instance is spawned per Claude Code session. It connects to the Helm
 * broker, registers the session as a teammate (scoped to its team), exposes
 * messaging tools, and pushes inbound messages into the session immediately
 * via a claude/channel notification.
 *
 * Self-contained: depends only on Node + @modelcontextprotocol/sdk and Helm's
 * own broker. It does NOT use CLAUDE_PEERS_PORT, so it never conflicts with a
 * separately-installed claude-peers network.
 *
 * Enable the live channel:
 *   claude --dangerously-load-development-channels server:helm-teammates
 * (Helm's shell function exposes this as `claude helm`.)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';

const BROKER_PORT = parseInt(process.env.HELM_BROKER_PORT || '7900', 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const TEAM = process.env.HELM_TEAM || '';
const TEAMMATE = process.env.HELM_TEAMMATE || '';
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Only act as a teammate when launched inside a Helm panel (HELM_TEAM is set
// there). Anywhere else this MCP stays dormant so it never pollutes the
// network or interferes with a normal `claude` session.
const ACTIVE = TEAM !== '';

// Sessions on the orchestrator team ("the Helm") get global tools: every team
// is visible, any teammate is reachable, and memory curation is unlocked. The
// broker independently enforces curation rights by checking the actor's team,
// so a non-helm session calling these endpoints directly is still refused.
const IS_HELM = TEAM === 'helm';

let myId = null;
let myName = TEAMMATE; // updated if the agent renames itself

function log(msg) {
  // stdio MCP servers must keep stdout clean for the protocol.
  console.error(`[helm-teammates] ${msg}`);
}

async function brokerFetch(path, body) {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`broker ${path}: ${res.status}`);
  return res.json();
}

async function brokerAlive() {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function gitRoot(cwd) {
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ─── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'helm-teammates', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: IS_HELM
      ? `You are the Helm, the orchestrator above every team in this workspace. You see all teams, you speak ONLY to team leads (chain of command, enforced by the broker), and you are the sole curator of workspace memory.

IMPORTANT: When you receive a <channel source="helm-teammates" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply with send_message, then resume.

Tools:
- list_teams: Every team, its live agents, and who its lead is
- send_message: Message a team's LEAD (marked in list_teams). Messages to workers are refused, direct work through their lead.
- message_team: Broadcast to your own helper team only
- recall_memory / add_memory: Semantic workspace memory (your adds are curated immediately)
- review_memory_inbox: Memories submitted by teammates awaiting your curation
- curate_memory: Promote, update, or delete memories, only you can do this
- set_summary / check_messages / rename_me: As usual

Leads compress their team's state up to you; you set direction, connect teams, and remember. Review the memory inbox regularly; promote what matters, delete what's stale.`
      : `You are a teammate in a Helm workspace. Other Claude Code teammates on your team can see you and message you.

IMPORTANT: When you receive a <channel source="helm-teammates" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply with send_message, then resume. Treat it like a teammate tapping you on the shoulder.

Read from_id, from_name, and from_summary to understand who sent it. Reply by calling send_message with their from_id.

If the Helm (the workspace orchestrator) messages you, reply promptly to its from_id. If you are your team's LEAD you can also message it any time at the name "helm", escalations, reports, questions. Workers cannot reach the Helm directly; they escalate through their lead.

If you are your team's LEAD, you can also message other teams' leads directly by name (lateral coordination, e.g. marketing lead asking legal lead). Workers cannot cross teams; they escalate through their own lead.

Tools:
- list_teammates: See the other teammates on your team (id, name, cwd, summary)
- send_message: Message one teammate by name or id
- message_team: Message EVERY teammate on your team at once (broadcast). Use this to brief or delegate to the whole team, don't message them one by one.
- set_summary: Set a 1-2 sentence summary of what you're working on (shown in Helm and to teammates)
- check_messages: Manually check for new messages
- rename_me: Rename your own panel in the Helm UI
- add_memory: Save a fact or observation to workspace memory (lands in the curation inbox)
- recall_memory: Semantic search over workspace memory, use it when you need context beyond your own session

When you start, call set_summary so your teammates and the Helm UI know what you're doing.`,
  }
);

const TOOLS = [
  {
    name: 'list_teammates',
    description: 'List the other Claude Code teammates on your team. Returns id, name, working directory, and summary.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_message',
    description: 'Send a message to one teammate. It is pushed into their session immediately. To reach the whole team, use message_team instead.',
    inputSchema: {
      type: 'object',
      properties: {
        to_id: { type: 'string', description: "Teammate's name (e.g. \"teammate-02\") or id, from list_teammates" },
        message: { type: 'string', description: 'The message to send' },
      },
      required: ['to_id', 'message'],
    },
  },
  {
    name: 'message_team',
    description: 'Message every teammate on your team at once (broadcast). Each gets it pushed into their session immediately. Use this to brief, coordinate, or delegate to the whole team in one call instead of messaging teammates one at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to all teammates on your team' },
      },
      required: ['message'],
    },
  },
  {
    name: 'set_summary',
    description: 'Set a brief (1-2 sentence) summary of your current work. Shown in the Helm panel header and to teammates.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'A 1-2 sentence summary' } },
      required: ['summary'],
    },
  },
  {
    name: 'check_messages',
    description: 'Manually check for new messages from teammates (normally pushed automatically).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rename_me',
    description: "Rename your own panel in the Helm UI (e.g. to reflect what you're now working on).",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The new name for your panel' } },
      required: ['name'],
    },
  },
  {
    name: 'add_memory',
    description: 'Save a fact, decision, or observation to shared workspace memory. It lands in the curation inbox for the Helm to review (the Helm\'s own adds are curated immediately). Keep it self-contained: one fact per memory.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory, a self-contained fact or observation (max 4000 chars)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for retrieval (e.g. ["palm", "migration"])' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Semantic search over workspace memory. You see your own team\'s memories plus what the Helm has published as shared (client teams see only their own). Use when you need context beyond your own session: past decisions, known quirks, prior work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in natural language' },
        limit: { type: 'number', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
  },
];

// Tools only the orchestrator team gets. The broker re-checks the actor's team
// on every curation call, so this gating is UX, not the security boundary.
const HELM_TOOLS = [
  {
    name: 'list_teams',
    description: 'List every team in the workspace and its live agents (id, name, cwd, summary). Helm-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'review_memory_inbox',
    description: 'List memories submitted by teammates that await curation. Promote the good ones with curate_memory, delete the noise. Helm-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'curate_memory',
    description: 'Curate workspace memory: promote an inbox entry, update text/tags/team of any entry, or delete one. Helm-only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['promote', 'update', 'delete'], description: 'What to do' },
        id: { type: 'string', description: 'Memory id (from review_memory_inbox or recall_memory)' },
        text: { type: 'string', description: 'Replacement text (optional, promote/update)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags (optional)' },
        team: { type: 'string', description: 'A team id to keep this memory in that team\'s sandbox, or "shared" to publish to all operations teams (never visible to client teams). Omit to leave scope unchanged.' },
      },
      required: ['action', 'id'],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: IS_HELM ? [...TOOLS, ...HELM_TOOLS] : TOOLS,
}));

function text(t, isError) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;

  if (!ACTIVE) return text('Not inside a Helm workspace, helm-teammates is dormant. Open this session in a Helm panel to chat with teammates.', true);
  if (!myId && name !== 'list_teammates') return text('Not registered with the Helm broker yet (is the Helm app running?).', true);

  try {
    switch (name) {
      case 'list_teammates': {
        const peers = await brokerFetch('/list-peers', { team_id: TEAM, exclude_id: myId });
        if (!peers.length) return text(`No other teammates on team "${TEAM}" right now.`);
        const lines = peers.map(p => {
          const parts = [`id: ${p.id}`, `name: ${p.agent_name || '(unnamed)'}`, `cwd: ${p.cwd}`];
          if (p.summary) parts.push(`summary: ${p.summary}`);
          return parts.join('\n  ');
        });
        return text(`${peers.length} teammate(s) on team "${TEAM}":\n\n${lines.join('\n\n')}`);
      }
      case 'send_message': {
        const message = args.message;
        // Accept either a peer id or a teammate name, resolve names so the lead
        // never has to copy cryptic ids. The Helm resolves across ALL teams.
        const target = String(args.to_id || '').trim();
        let toId = target;
        const peers = await brokerFetch('/list-peers', IS_HELM ? {} : { team_id: TEAM });
        if (!peers.some(p => p.id === target)) {
          const byName = peers.filter(p => (p.agent_name || '').toLowerCase() === target.toLowerCase());
          if (byName.length === 1) toId = byName[0].id;
          else if (byName.length > 1) return text(`More than one teammate is named "${target}". Use their id from ${IS_HELM ? 'list_teams' : 'list_teammates'}.`, true);
          else if (!IS_HELM && ['helm', 'the-helm'].includes(target.toLowerCase())) {
            // "helm" is the well-known upward address: a team's LEAD can
            // always reach the orchestrator without hunting for its id. (The
            // broker refuses non-leads, so workers still go through their lead.)
            const helmPeers = await brokerFetch('/list-peers', { team_id: 'helm' });
            if (!helmPeers.length) return text('The Helm is not online right now (no agent running in its panel).', true);
            toId = helmPeers[0].id;
          }
          else if (!IS_HELM) {
            // Not on this team, maybe it's another team's LEAD (lateral
            // coordination). Resolve against the lead roster; the broker still
            // refuses unless both sides are leads.
            const { teams } = await fetch(`${BROKER_URL}/teams`).then(res => res.json());
            const lateral = [];
            for (const t of teams || []) {
              if (t.id === TEAM || t.id === 'helm' || !t.lead) continue;
              if (t.lead.toLowerCase() !== target.toLowerCase()) continue;
              const leadPeer = t.peers.find(p => p.agent_name === t.lead);
              if (leadPeer) lateral.push(leadPeer);
            }
            if (lateral.length === 1) toId = lateral[0].id;
            else if (lateral.length > 1) return text(`More than one team has a lead named "${target}". Use their peer id.`, true);
            else return text(`No teammate "${target}" on team "${TEAM}" and no other team's lead by that name. Use list_teammates for your team; team leads can also message other teams' leads by name, or "helm" to reach the orchestrator.`, true);
          }
          else return text(`No teammate "${target}". Use list_teams to see names/ids.`, true);
        }
        const r = await brokerFetch('/send-message', { from_id: myId, to_id: toId, text: message });
        if (r.error === 'helm_messages_leads_only') {
          return text(`Refused: "${target}" is not the lead of team "${r.team}". The Helm messages leads only${r.lead ? `, that team's lead is "${r.lead}"` : ''}; direct the work through them.`, true);
        }
        if (r.error === 'helm_reports_via_lead') {
          return text(`Refused: only your team's lead may message the Helm. Report to your lead${r.lead ? ` ("${r.lead}")` : ''} and let them escalate.`, true);
        }
        if (r.error === 'cross_team_leads_only') {
          return text(`Refused: cross-team messages are lead-to-lead only. ${r.your_lead ? `Escalate through your lead ("${r.your_lead}")` : 'Escalate through your lead'}${r.their_lead ? `, who can reach their lead ("${r.their_lead}")` : ''}.`, true);
        }
        if (r.error === 'client_teams_isolated') {
          return text('Refused: client teams are isolated from each other. If this genuinely needs cross-client coordination, the Helm orchestrator handles it.', true);
        }
        return r.ok ? text(`Message sent to ${target}.`) : text(`Failed: ${r.error}`, true);
      }
      case 'message_team': {
        // Everyone broadcasts only to their own team, for the Helm that means
        // its helper team; it reaches other teams through their leads.
        const r = await brokerFetch('/broadcast', { from_id: myId, team_id: TEAM, text: args.message });
        if (r.error === 'helm_messages_leads_only') {
          return text(`Refused: the Helm reaches a team through its lead${r.lead ? ` ("${r.lead}")` : ''}, not by broadcast.`, true);
        }
        return text(`Broadcast to ${r.sent_to} teammate(s) on team "${TEAM}".`);
      }
      case 'set_summary': {
        await brokerFetch('/set-summary', { id: myId, summary: args.summary });
        return text(`Summary updated: "${args.summary}"`);
      }
      case 'check_messages': {
        const r = await brokerFetch('/poll-messages', { id: myId });
        if (!r.messages.length) return text('No new messages.');
        const lines = r.messages.map(m => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return text(`${r.messages.length} new message(s):\n\n${lines.join('\n\n---\n\n')}`);
      }
      case 'rename_me': {
        const newName = String(args.name || '').trim();
        if (!newName) return text('Provide a non-empty name.', true);
        await brokerFetch('/ui-command', { type: 'rename', team: TEAM, teammate: myName, name: newName });
        await brokerFetch('/set-agent-name', { id: myId, agent_name: newName });
        myName = newName;
        return text(`Renamed your panel to "${newName}".`);
      }
      case 'add_memory': {
        const r = await brokerFetch('/memory/add', { from_id: myId, text: args.text, tags: args.tags });
        if (!r.ok) return text(`Failed: ${r.error}`, true);
        const where = r.status === 'curated' ? 'curated store' : 'curation inbox';
        return text(`Memory saved to the ${where} (id ${r.id}${r.semantic ? '' : ', semantic indexing pending'}).`);
      }
      case 'recall_memory': {
        const r = await brokerFetch('/memory/search', { from_id: myId, query: args.query, k: args.limit || 8 });
        if (r.error) return text(`Failed: ${r.error}`, true);
        if (!r.results.length) return text('No matching memories.');
        const lines = r.results.map(m => {
          const meta = [m.status, ...(m.tags || [])].join(', ');
          const src = m.source?.agent_name ? `, from ${m.source.agent_name}` : '';
          return `[${m.id}] (${meta}, score ${m.score})${src}\n${m.text}`;
        });
        return text(`${r.results.length} memor${r.results.length === 1 ? 'y' : 'ies'} (${r.semantic ? 'semantic' : 'keyword-only'} search):\n\n${lines.join('\n\n')}`);
      }
      case 'list_teams': {
        if (!IS_HELM) return text('list_teams is Helm-only.', true);
        const { teams } = await fetch(`${BROKER_URL}/teams`).then(r => r.json());
        const others = teams.filter(t => t.id !== 'helm');
        if (!others.length) return text('No teams configured yet.');
        const blocks = others.map(t => {
          const liveNames = new Set(t.peers.map(p => p.agent_name));
          const members = t.peers.map(p => {
            const isLead = t.lead && p.agent_name === t.lead;
            return `  ● ${p.agent_name || '(unnamed)'}${isLead ? ' ← LEAD' : ''} [${p.id}] cwd: ${p.cwd}${p.summary ? `\n    ${p.summary}` : ''}`;
          });
          const offline = (t.configured || []).filter(n => !liveNames.has(n));
          if (offline.length) {
            members.push(`  ○ offline: ${offline.map(n => n === t.lead ? `${n} (LEAD)` : n).join(', ')}`);
          }
          const head = `${t.name} [${t.kind}] lead: ${t.lead || 'none set'}, ${t.peers.length} live of ${(t.configured || []).length} configured`;
          if (!members.length) return `${head}\n  (empty team)`;
          return `${head}:\n${members.join('\n')}`;
        });
        return text(`${blocks.join('\n\n')}\n\nYou may message only the LEAD of each team. Offline members exist but aren't running claude helm yet.`);
      }
      case 'review_memory_inbox': {
        if (!IS_HELM) return text('review_memory_inbox is Helm-only.', true);
        const r = await brokerFetch('/memory/inbox', { actor_id: myId });
        if (r.error) return text(`Failed: ${r.error}`, true);
        if (!r.entries.length) return text('Memory inbox is empty.');
        const lines = r.entries.map(e =>
          `[${e.id}] from ${e.source?.agent_name || 'unknown'} (team ${e.source?.team_id || '?'}, ${e.created_at})${e.tags?.length ? ` tags: ${e.tags.join(', ')}` : ''}\n${e.text}`);
        return text(`${r.entries.length} inbox entr${r.entries.length === 1 ? 'y' : 'ies'} awaiting curation:\n\n${lines.join('\n\n')}\n\nUse curate_memory to promote, update, or delete each.`);
      }
      case 'curate_memory': {
        if (!IS_HELM) return text('curate_memory is Helm-only.', true);
        const r = await brokerFetch('/memory/curate', {
          actor_id: myId, action: args.action, id: args.id,
          text: args.text, tags: args.tags, team: args.team,
        });
        if (r.error) return text(`Failed: ${r.error}`, true);
        return text(args.action === 'delete' ? `Memory ${args.id} deleted.` : `Memory ${args.id} ${args.action}d.`);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return text(`Error in ${name}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

// ─── Inbound message push ────────────────────────────────────────────────────

async function pollAndPush() {
  if (!myId) return;
  try {
    const { messages } = await brokerFetch('/poll-messages', { id: myId });
    if (!messages.length) return;

    let teammates = [];
    try { teammates = await brokerFetch('/list-peers', { team_id: TEAM }); } catch { /* best effort */ }

    for (const msg of messages) {
      const sender = teammates.find(p => p.id === msg.from_id);
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text,
          meta: {
            from_id:      msg.from_id,
            from_name:    sender?.agent_name || '',
            from_summary: sender?.summary || '',
            from_cwd:     sender?.cwd || '',
            sent_at:      msg.sent_at,
          },
        },
      });
      log(`pushed message from ${msg.from_id}`);
    }
  } catch (e) {
    log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  // Always connect MCP so the tools exist; only register as a teammate when
  // we're genuinely inside a Helm panel and the broker is reachable.
  if (ACTIVE) {
    if (await brokerAlive()) {
      const cwd = process.cwd();
      const reg = await brokerFetch('/register', {
        pid: process.pid,
        cwd,
        git_root: await gitRoot(cwd),
        tty: null,
        summary: '',
        team_id: TEAM,
        agent_name: TEAMMATE,
      });
      myId = reg.id;
      log(`registered as teammate ${myId} (name=${TEAMMATE || '(unnamed)'}, team=${TEAM})`);

      setInterval(pollAndPush, POLL_INTERVAL_MS);
      setInterval(async () => {
        if (myId) { try { await brokerFetch('/heartbeat', { id: myId }); } catch { /* non-critical */ } }
      }, HEARTBEAT_INTERVAL_MS);
    } else {
      log(`Helm broker not reachable on ${BROKER_URL}, tools will report unavailable until the Helm app is running.`);
    }
  } else {
    log('not inside a Helm panel (HELM_TEAM unset), dormant.');
  }

  await mcp.connect(new StdioServerTransport());
  log('MCP connected');

  const cleanup = async () => {
    if (myId) { try { await brokerFetch('/unregister', { id: myId }); } catch { /* best effort */ } }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(e => { log(`fatal: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
