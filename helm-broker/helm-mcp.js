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
    instructions: `You are a teammate in a Helm workspace. Other Claude Code teammates on your team can see you and message you.

IMPORTANT: When you receive a <channel source="helm-teammates" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply with send_message, then resume. Treat it like a teammate tapping you on the shoulder.

Read from_id, from_name, and from_summary to understand who sent it. Reply by calling send_message with their from_id.

Tools:
- list_teammates: See the other teammates on your team (id, name, cwd, summary)
- send_message: Message one teammate by name or id
- message_team: Message EVERY teammate on your team at once (broadcast). Use this to brief or delegate to the whole team, don't message them one by one.
- set_summary: Set a 1-2 sentence summary of what you're working on (shown in Helm and to teammates)
- check_messages: Manually check for new messages
- rename_me: Rename your own panel in the Helm UI
- preview_file: Show the user a specific file in Helm's preview (e.g. an output you produced or the file you want them to look at)

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
    name: 'preview_file',
    description: "Show the user a specific file in Helm's preview pane (it renders code, PDFs, images, and CSVs, and updates live as you edit). Use it to surface something worth looking at, an output you produced or the file you're working on, not for every file you touch.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path of the file to preview (relative to your working directory, or absolute)' },
      },
      required: ['file'],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
        // never has to copy cryptic ids.
        const target = String(args.to_id || '').trim();
        let toId = target;
        const peers = await brokerFetch('/list-peers', { team_id: TEAM });
        if (!peers.some(p => p.id === target)) {
          const byName = peers.filter(p => (p.agent_name || '').toLowerCase() === target.toLowerCase());
          if (byName.length === 1) toId = byName[0].id;
          else if (byName.length === 0) return text(`No teammate "${target}" on team "${TEAM}". Use list_teammates to see names/ids, or message_team to reach everyone.`, true);
          else return text(`More than one teammate is named "${target}". Use their id from list_teammates.`, true);
        }
        const r = await brokerFetch('/send-message', { from_id: myId, to_id: toId, text: message });
        return r.ok ? text(`Message sent to ${target}.`) : text(`Failed: ${r.error}`, true);
      }
      case 'message_team': {
        const r = await brokerFetch('/broadcast', { from_id: myId, team_id: TEAM, text: args.message });
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
      case 'preview_file': {
        const f = String(args.file || '').trim();
        if (!f) return text('Provide a file path to preview.', true);
        await brokerFetch('/ui-command', { type: 'open-preview', team: TEAM, teammate: myName, file: f });
        return text(`Previewing ${f} in Helm.`);
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
