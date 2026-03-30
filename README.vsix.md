<div align="center">

# <img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/icon.png" width="32" alt="Logo"> GitHub Copilot Lens

**See everything Copilot does — in real time.**

A live monitoring dashboard for GitHub Copilot CLI sessions — right inside VS Code.<br>
Watch every turn, tool call, agent chain, and token as they happen.

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/ghcplens_video.gif" width="720" alt="Copilot Lens — Multi-Agent Chain Demo">

</div>

---

## ✨ Why Copilot Lens?

> Ever wonder what Copilot is *actually* doing when it goes quiet for 30 seconds?

| | |
|---|---|
| 🔍 **Full Transparency** | Watch Copilot think, plan, and execute — step by step |
| 🤖 **Multi-Agent Trees** | Visualize nested agent hierarchies unfolding live, up to 6+ levels deep |
| 🛠️ **Tool Inspector** | Click any tool badge to see the exact command, file edit, or API call |
| 📊 **Token Tracking** | Per-turn and per-agent output token counts from the actual LLM API |

---

## 📸 Highlights

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/dashboard.jpeg" width="700" alt="Dashboard">

**Session Dashboard** — Browse all sessions grouped by project. Status at a glance — working, asking, idle, done.

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/agent-hierarchy.jpeg" width="700" alt="Agent Hierarchy">

**Agent Call Trees** — Full parent→child tree with tool badges, model names, token counts, and timing.

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/tool-modal.jpeg" width="700" alt="Tool Inspector">

**Tool Inspector** — Click any badge to drill into exact input/output. Nothing is hidden.

---

## 🚀 Getting Started

1. Click the **GitHub Copilot Lens** icon in the **left sidebar** (Activity Bar)
2. Click **Open Dashboard** — that's it!

<img src="https://raw.githubusercontent.com/whoniiii/ghcplens/master/docs/screenshots/sidebar.png" width="360" alt="Sidebar — Open Dashboard">

Or: `Ctrl+Shift+P` → `GitHub Copilot Lens: Open Dashboard`

---

## 🏗️ Features at a Glance

| Feature | Description |
|---------|-------------|
| 📋 **Live Monitoring** | Real-time session status with auto-refresh (1s–10s) |
| 🕐 **Session Timeline** | Full conversation — messages, tools, agents in order |
| 🌳 **Agent Hierarchy** | Nested multi-agent trees with live pulse animations |
| 🔧 **Tool Inspector** | Click-to-inspect input/output for every tool call |
| 📊 **Token Display** | Per-turn total tokens (direct + all sub-agents) |
| 🤖 **Model Names** | See which AI model each agent used |
| 🎨 **4 Themes** | Light · Day · Medium · Dark |
| 🌐 **4 Languages** | English · 한국어 · 日本語 · 中文 |
| 📝 **Session Memo** | Tag sessions with custom notes |
| 📈 **Statistics** | Turns, tools, agents, tokens, files — per session |

---

## 🔒 Privacy

Reads from `~/.copilot/session-state/` on your local machine only.

**No data is sent anywhere. No telemetry. Everything stays on your computer.**

---

## 📎 Links

- 📦 [GitHub Repository](https://github.com/whoniiii/ghcplens)
- 🐛 [Report Issues](https://github.com/whoniiii/ghcplens/issues)
- 👤 [Author — Jeonghoon Lee](https://www.linkedin.com/in/jeonghlee8024)

---

<div align="center">

**MIT License** · Built for the GitHub Copilot community 🚀

</div>
