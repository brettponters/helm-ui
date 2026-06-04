# Helm

A macOS app for running and orchestrating many **Claude Code** agents at once.
Group agents into **teams**, lay them out automatically (or put a **lead** in the
center with sub-agents on the sides), watch the real files each one is working on
in a built-in **preview**, and let them **message each other live**.

Black-and-white, terminal-native. Open source. Built specifically for Claude Code.

---

## Get the app

**Download** the latest `Helm.app` from the
[Releases page](https://github.com/brettponters/helm-ui/releases/latest), unzip it,
and move it to your Applications folder. On first launch, right-click `Helm.app` →
**Open** (it's ad-hoc signed, not yet notarized, so macOS asks once).

Apple Silicon (arm64) only for now.

**Or build it yourself:**

```bash
git clone https://github.com/brettponters/helm-ui.git
cd helm-ui
npm install
npm run app:dist     # → release/mac-arm64/Helm.app
```

Open Helm and you get a full window of terminal panels, one per Claude Code
agent. Everything runs inside the app; there's no browser tab and no URL to
remember.

---

## Using Helm

Each panel is where a **Claude Code agent** runs, type `claude` (or `claude helm`
to join the team chat, below). Panels are real shells, so you can also run `git`,
tests, or a dev server alongside your agents.

- **Teams**, the tabs across the top. Click `+` to add one, double-click to
  rename, hover and click `✕` to delete (it confirms first).
- **Add an agent**, click **NEW TEAMMATE**. The grid auto-rebalances to the best
  layout for however many you have.
- **Rename an agent**, double-click its name in the panel header.
- **Set the working directory**, click the `⌖` chip in a panel header and pick a
  folder. **This moves the whole team to that directory** (a team works on one
  project).
- **Layout**, move your mouse to the bottom-center and a switcher pops up:
  - **GRID**, auto-balanced grid (default).
  - **LEAD**, one agent fills the center, the rest split left/right. Click the
    **crown** ♔ in any panel header to make it the lead. Drag the dividers to
    resize the lead column.
- **Search a panel**, focus it and press **⌘F**.
- **Preview**, click the **eye** icon in a panel header. A VS Code–style file
  explorer opens for that agent's directory; click any file to view it. The file
  the agent is *currently* working on is auto-selected and followed live. It
  renders each type appropriately: **code** (wrapped, with line numbers),
  **PDF** (rendered), **images**, and **CSV/TSV** (as a table).
- **Settings**, the gear (top-right): theme, font size, CRT glow, cursor.

Everything (teams, agents, names, directories, layout, prefs) is saved to
`~/.helm/workspace.json` and restored on reload.

---

## Live agent-to-agent chat: `claude helm`

Helm ships its own messaging layer so your agents can talk to each other.

### 1. One-time setup

```bash
npm run setup-chat
```

This registers the `helm-teammates` MCP server globally and adds a `claude helm`
command to your shell. Then reload your shell:

```bash
source ~/.zshrc   # or just open a new terminal
```

### 2. Start an agent as a teammate

Click into any Helm panel and type:

```bash
claude helm
```

That's it. That Claude Code session is now a **teammate** on its team. (Plain
`claude` still works as a normal session, `claude helm` is what plugs it into
the team chat.)

### 3. How teammates work

Once running as `claude helm`, each agent can:

| Tool | What it does |
|------|--------------|
| `list_teammates` | See the other agents on its team (name, directory, what they're doing) |
| `send_message`   | Message a teammate, it's pushed into their session instantly |
| `set_summary`    | Set a 1–2 sentence status (shown in the Helm panel header and to teammates) |
| `check_messages` | Pull any messages (normally they arrive automatically) |

Just talk to one of them in plain English, e.g.:

> "List your teammates, then tell teammate-02 to take the underwriting while you
> handle sourcing."

It calls `send_message`, and the other panel's Claude gets it pushed in
immediately, like a coworker tapping it on the shoulder, and replies back.

The **TEAM ACTIVE** indicator (top-right) shows how many agents are live in the
current team.

> ⚠️ **`claude helm` runs with `--dangerously-skip-permissions`.** Teammates act
> without permission prompts, they can run commands, edit files, and make network
> calls in their working directory unattended. That's intentional for a hands-off
> multi-agent workflow, but only point teammates at directories you're comfortable
> letting an agent operate in freely. To keep prompts, remove that flag from the
> `claude()` function in your shell rc (see `scripts/setup-teammates.mjs`).

### Does this conflict with claude-peers?

No. Helm uses its own broker and its own `HELM_BROKER_PORT` / `HELM_TEAM` /
`HELM_TEAMMATE` environment, it never touches `CLAUDE_PEERS_PORT`. If you also run
[claude-peers](https://github.com/louislva/claude-peers-mcp), the two stay fully
independent.

---

## How it fits together

```
┌──────────────────── Helm UI (5199) ─────────────────────┐
│  teams · auto-grid / lead layout · file preview · search │
│  polls the broker → live status + previews in the UI     │
└───────────────┬────────────────────┬─────────────────────┘
                │ ws                  │ http
        ┌───────▼──────┐      ┌───────▼────────┐
        │  pty server  │      │     broker     │
        │   (7901)     │      │     (7900)     │
        │ real shells  │      │ agents · msgs  │
        └───────┬──────┘      │ file previews  │
                │ spawns      └───────▲────────┘
        ┌───────▼─────────┐           │ register / poll / push
        │  panel shell    │           │
        │  $ claude helm ──────────────┘  (helm-teammates MCP)
        └─────────────────┘
```

The `helm-teammates` MCP (`helm-broker/helm-mcp.js`) is a small, self-contained
Node server, it depends only on Node and `@modelcontextprotocol/sdk`, talks to
Helm's broker, and pushes inbound messages via a `claude/channel` notification.

The preview reads files straight off disk (scoped to each agent's directory, with
path-traversal guards), so it shows exactly what the agent changed, no mock data.

Security: the broker and PTY server only accept connections from the Helm UI's
origin, so a random web page can't reach them to spawn shells or read files.

---

## Build a standalone app

```bash
npm run app:dist
```

Produces `release/mac-arm64/Helm.app`, a self-contained app that bundles its own
Node runtime (no system Node required) and is ad-hoc signed so it runs locally on
Apple Silicon. Drag it to `/Applications`.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run app` | Run Helm as a desktop window (recommended) |
| `npm run helm` | Run broker + pty + ui for the browser |
| `npm run setup-chat` | Wire up `claude helm` (one-time) |
| `npm run app:dist` | Package the standalone `Helm.app` |
| `npm run build` | Production web build |
| `npm run broker` / `npm run pty` | Run a single service |

## Requirements

- macOS (Apple Silicon)
- Node 18+
- [Claude Code](https://claude.com/claude-code) installed (for `claude` / `claude helm`)

## License

MIT, see [LICENSE](LICENSE).

## Attribution

The broker and messaging design are adapted from
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) (MIT), retargeted
to a team-scoped, in-memory broker with a desktop UI and live file previews.
