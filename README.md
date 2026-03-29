# GitHub Copilot Lens

**Real-time session monitoring dashboard for GitHub Copilot CLI.**

See what Copilot is doing — every turn, tool call, agent chain, and token — live in your browser or VS Code.

![Dashboard](https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/dashboard.jpeg)

---

## Features

### Session Overview
Browse all Copilot CLI sessions grouped by project folder. See status at a glance — working, asking, idle, or done — with turn counts, token usage, and last message preview.

### Session Timeline
Drill into any session to see the full conversation timeline: user messages, assistant responses, tool calls, and agent dispatches in chronological order.

![Agent Hierarchy](https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/agent-hierarchy.jpeg)

### Multi-Agent Hierarchy
When Copilot spawns sub-agents (PM, backend-developer, tester, etc.), Copilot Lens renders the full call tree with parent-child relationships, per-agent tool badges, and results.

### Tool Call Inspector
Click any tool badge to inspect the exact input and output — powershell commands, file edits, grep searches, API calls — everything Copilot did under the hood.

![Tool Modal](https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/tool-modal.jpeg)

### Statistics
Per-session stats: turns, tools, agents, tokens, checkpoints, and modified files — all in one panel with horizontal bar charts for tool usage distribution.

### More
- **4 Themes** — Light, Day, Medium, Dark
- **4 Languages** — English, Korean (한), Japanese (日), Chinese (中)
- **Configurable Polling** — 1s, 3s, 5s, 10s auto-refresh
- **VS Code Integration** — Open project in VS Code / Insiders with one click
- **Editable Memo** — Tag sessions with custom notes
- **Copy** session ID and path to clipboard

---

## Installation

### VS Code Extension

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JeonghoonLee.ghcp-lens), or:

1. Download the `.vsix` file from [Releases](https://github.com/whoniiii/ghcplens/releases)
2. In VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Open command palette → `Copilot Lens: Open Dashboard`

### Standalone (Browser)

```bash
git clone https://github.com/whoniiii/ghcplens.git
cd ghcplens
npm install
node src/server.js
```

Open **http://localhost:3002**

---

## How It Works

Copilot Lens reads session data from `~/.copilot/session-state/` — the same directory where GitHub Copilot CLI stores its conversation logs (`events.jsonl`, `workspace.yaml`, checkpoints, etc.).

No data is sent anywhere. Everything runs locally.

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Node.js (pure `http` module, no frameworks) |
| Frontend | Single HTML file, vanilla JavaScript, inline CSS |
| Tests | Vitest (92 tests) |
| Port | 3002 (default) |

---

## Testing

```bash
npm test
```

---

## License

MIT

---

<p align="center">
  Built for the GitHub Copilot community
</p>
