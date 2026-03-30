# GitHub Copilot Lens

> **See everything Copilot does — in real time.**

Ever wondered what's happening behind the scenes when GitHub Copilot CLI is working? Copilot Lens gives you a live dashboard showing every turn, tool call, agent chain, and token — right inside VS Code.

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/dashboard.jpeg" width="700" alt="Dashboard">

---

## Why Copilot Lens?

🔍 **Full Transparency** — Watch Copilot think, plan, and execute in real time

🤖 **Multi-Agent Visibility** — See the full agent hierarchy live: PM calls backend-developer, backend-developer calls tester — every chain visualized in real-time with model names and token usage

🛠️ **Tool Call Inspector** — Click any tool badge to see exactly what command was run, what file was edited, what was searched

📊 **Session Analytics** — Turns, tokens, tools, agents, checkpoints, modified files — all at a glance

---

## Highlights

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/agent-hierarchy.jpeg" width="700" alt="Agent Hierarchy">

**Agent Call Trees** — When Copilot spawns sub-agents, see the full parent→child tree with tool badges, results, and timing for each agent.

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/tool-modal.jpeg" width="700" alt="Tool Inspector">

**Tool Inspector** — Click any tool badge to drill into the exact input and output. PowerShell commands, file edits, grep searches — nothing is hidden.

---

## Getting Started

1. Click the **GitHub Copilot Lens** icon in the Activity Bar (left sidebar)
2. Click **Open Dashboard**
3. That's it — your sessions load automatically

Or: `Ctrl+Shift+P` → `GitHub Copilot Lens: Open Dashboard`

---

## Features at a Glance

| Feature | |
|---------|--|
| **Live Monitoring** | Real-time session status — working, asking, idle, done |
| **Session Timeline** | Full conversation with user/assistant messages and tool calls |
| **Agent Hierarchy** | Visual tree of multi-agent chains with live results, model names, tokens |
| **Turn Tokens** | Per-turn total output tokens (direct + all sub-agents) |
| **Tool Inspector** | Click-to-inspect input/output for every tool call |
| **4 Themes** | Light, Day, Medium, Dark |
| **4 Languages** | English, 한국어, 日本語, 中文 |
| **Auto-refresh** | 1s, 3s, 5s, or 10s polling intervals |
| **Session Memo** | Tag sessions with custom notes |
| **Statistics** | Turns, tokens, tools, agents, files — per session |

---

## Privacy

Copilot Lens reads from `~/.copilot/session-state/` on your local machine. **No data is sent anywhere.** Everything stays on your computer.

---

## Links

- [GitHub Repository](https://github.com/whoniiii/ghcplens)
- [Report Issues](https://github.com/whoniiii/ghcplens/issues)
- [Author — Jeonghoon Lee](https://www.linkedin.com/in/jeonghlee8024)

---

**MIT License** · Built for the GitHub Copilot community
