# Changelog

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
