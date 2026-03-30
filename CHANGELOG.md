# Changelog

## [Unreleased]

## [1.4.0] - 2026-03-30

### Added
- **README redesign** — Professional layout with badges, screenshot grid, emoji section headers
- **GIF demo** — Animated multi-agent chain demo at the top of README
- **Sidebar screenshot** — VS Code Activity Bar quick start guide

### Fixed
- **Turn pulse bug** — Turns with tool calls (e.g. `task_complete`) no longer pulse indefinitely
- **Auto-scroll on new turns** — Timeline scrolls to bottom when new turns appear during polling

## [1.3.0] - 2026-03-30

### Added
- **Sub-agent real-time updates** — Child agents (PM → ui-developer, backend-developer, tester) appear live in timeline as they spawn, with recursive status tracking
- **Auto-expand parent agent** — Parent agent body automatically opens when sub-agents start
- **Agent model display** — Each agent shows which AI model was used (e.g. `claude-opus-4.6`, `claude-haiku-4.5`)
- **Per-turn total tokens** — Timestamp shows aggregated output tokens (direct + all sub-agents recursively)
- **Turn activity indicator** — Timeline dot pulses blue while processing, turns green on completion
- **Live agent results** — RESULT section and TOOLS badges appear in real-time when agents complete
- **Timeline loading state** — "View Full Timeline" button shows spinner while fetching data
- **Auto-scroll on sub-agent** — Timeline panel scrolls to bottom when new sub-agents appear

### Fixed
- **Polling collapse bug** — Expanded items no longer collapse on poll refresh (uses stable `data-ts` instead of shifting `data-turn-idx`)
- **Turn dot stuck pulsing** — Dot correctly stops when all agents complete (removed always-true session check)
- **Agent result blank display** — Strip leading newlines from result text to prevent empty appearance
- **Agent `data-status` normalization** — `completed` → `done` mapped consistently for CSS selectors

## [1.2.2] - 2026-03-30

### Added
- **Agent pulse animation** — Running agents' icon pulses (scale 20%↔100%) for visual activity indicator

### Fixed
- **Session status false positive** — PID recycling caused completed sessions to show as active (green); now verifies the lock PID is actually a Node.js process

## [1.2.1] - 2026-03-30

### Added
- **Project Config modal** — View agents, skills, and copilot-instructions per session (tabs with expand/collapse cards)
- **Show Connect Screen** command — `Ctrl+Shift+P` → "GitHub Copilot Lens: Show Connect Screen" to re-open initial setup
- **Connect screen error guide** — Structured solution list with per-OS install commands (npm, Homebrew, WinGet) and copy buttons
- **Skill detail view** — Click to expand full README body content for each skill

### Changed
- Project Config modal width increased to 960px for better readability
- Connect screen modal width increased to 560px
- Professional design — removed emoji overuse, replaced with text initials (PM, BE, UI, TE, IN, RM)
- Install command corrected: `@github/copilot` (was incorrect legacy package name)

### Fixed
- `renderTimeline is not defined` error — unclosed comment block in keydown listener
- Modal height stabilized — fixed at 75vh to prevent resize on tab switch
- Tool badge duplication in polling updates — removed redundant agent tool breakdown

## [1.2.0] - 2026-03-30

### Added
- **VS Code Sidebar** — Activity bar icon with version info, quick "Open Dashboard" button
- **Timeline turn matching** — Timestamp-based override for interleaved messages (fixes wrong turn attribution)
- **VS Code Insiders detection** — Correctly opens matching VS Code variant

### Changed
- Unified naming to "GitHub Copilot Lens" across all UI surfaces
- README rewritten for VS Code Marketplace

### Fixed
- "Open in VSCode" button on Windows — added `shell: true` for `.cmd` executables
- NUL file causing Marketplace validation failure — added to `.vscodeignore`
- Timeline tools/responses attaching to wrong turn when messages are sent mid-response

## [1.1.0] - 2026-03-30

### Added
- **Activity Bar icon** — GitHub + magnifying glass icon in VS Code sidebar with "Open Dashboard" button
- **Tool Call Inspector** — Click any tool badge to view exact input/output (powershell, view, edit, grep, etc.)
- **Agent Hierarchy Tree** — Visual tree connectors showing parent→child agent relationships
- **Security hardening** — Path traversal guard, command injection fix (exec → execFile), CORS preflight handling

### Changed
- New extension icon — GitHub Octocat + magnifying glass design
- Favicon and header logo updated to match new icon
- Language buttons now show native labels: **en**, **한**, **日**, **中**
- Default settings: Dark theme, English, 1s polling
- README rewritten for Marketplace with 3 screenshots
- VS Code webview uses `asExternalUri` for reliable localhost connection

### Fixed
- Webview "Server connection failed" error in VS Code (CSP + portMapping + asExternalUri)
- OPTIONS preflight handling for PUT requests
- Session state detection for `tool.execution_complete`, `subagent.completed`, `hook.start/end`
- Assistant message truncation — now keeps longest content across events
- Error messages internationalized (removed hardcoded Korean strings)

## [1.0.0] - 2026-03-29

### Initial Release
- Real-time session monitoring dashboard
- Session list with folder grouping
- Session detail panel with statistics
- Session timeline with turn-by-turn view
- Multi-agent panel
- 4 themes (Light, Day, Medium, Dark)
- 4 languages (English, Korean, Japanese, Chinese)
- Configurable polling (1s, 3s, 5s, 10s)
- VS Code / Insiders integration
- Editable memo field
- Copy session ID and path
