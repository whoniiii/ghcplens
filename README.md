# 🔭 GitHub Copilot Lens

> A lightweight web dashboard for real-time monitoring of GitHub Copilot CLI sessions.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Tests](https://img.shields.io/badge/Tests-92%20passed-brightgreen)

<!-- 📸 Screenshot placeholder — coming soon -->
<!-- ![Dashboard Screenshot](docs/screenshots/dashboard.png) -->

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 📡 **Real-time Session Monitoring** | Track session states live — working, asking, idle, or terminated |
| 📊 **Session Details** | View turn counts, tool usage, token consumption, checkpoints, and modified files |
| 🤖 **Multi-Agent Analysis** | Inspect sub-agent lists, statuses, prompts, and results |
| 🌍 **4 Languages** | Korean, English, Japanese, Chinese |
| 🎨 **4 Themes** | Light, Gray, Dark, Black |
| 🚀 **VSCode Integration** | Resume sessions in VSCode / Insiders with one click |
| 📋 **Copy Session Info** | Copy session paths and IDs to clipboard |
| 📁 **Folder Grouping** | Organize sessions by project folder |

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (pure — no frameworks)
- **Frontend**: Single HTML SPA (vanilla JS)
- **Port**: `3002`
- **Data Source**: `~/.copilot/session-state/` (`events.jsonl`, `workspace.yaml`, etc.)
- **Test**: Vitest

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher

### Installation

```bash
git clone https://github.com/your-username/ghcpstudio.git
cd ghcpstudio
npm install
```

### Run

```bash
node src/server.js
```

Open your browser and navigate to **http://localhost:3002** 🎉

---

## 📁 Project Structure

```
ghcpstudio/
├── public/                # Static files (HTML)
│   ├── index.html         # Main dashboard SPA
│   └── logs.html          # Log viewer
├── src/                   # Server source
│   └── server.js          # Node.js HTTP server
├── __tests__/             # Tests
│   └── server.test.js     # Server unit & integration tests
├── package.json
├── vitest.config.js
└── README.md
```

---

## 🧪 Testing

Run the full test suite with [Vitest](https://vitest.dev/):

```bash
npm test
```

> ✅ **92 tests** covering server routes, session parsing, multi-agent analysis, and more.

---

## 📸 Screenshots

> 🖼️ *Screenshots will be added soon.*

<!-- Uncomment and update paths when screenshots are ready:
### Dashboard
![Dashboard](docs/screenshots/dashboard.png)

### Session Detail
![Session Detail](docs/screenshots/session-detail.png)

### Multi-Agent View
![Multi-Agent](docs/screenshots/multi-agent.png)
-->

---

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/awesome-feature`)
3. **Commit** your changes (`git commit -m 'Add awesome feature'`)
4. **Push** to the branch (`git push origin feature/awesome-feature`)
5. **Open** a Pull Request

Please make sure all tests pass before submitting:

```bash
npm test
```

---

## 📄 License

This project is licensed under the **MIT License**.

```
MIT License

Copyright (c) 2025 GitHub Copilot Lens Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<p align="center">
  Made with ❤️ for the GitHub Copilot community
</p>
