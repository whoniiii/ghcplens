/**
 * GitHub Copilot Lens — VS Code Extension
 * 
 * Opens a WebView panel that displays the Copilot session monitoring dashboard.
 * Embeds the HTTP server internally so no external server process is needed.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');

let serverInstance = null;
let serverPort = null;
let panel = null;

async function ensureServer() {
  if (serverInstance) return serverPort;

  // Read user-configured session path
  const config = vscode.workspace.getConfiguration('ghcpLens');
  const customPath = config.get('sessionStatePath');
  if (customPath) {
    process.env.COPILOT_SESSION_DIR = customPath;
  }

  const result = await startServer(0);
  serverInstance = result.server;
  serverPort = result.port;
  return serverPort;
}

async function getWebviewContent(extensionPath, port) {
  const htmlPath = path.join(extensionPath, 'public', 'index-v2.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  // Resolve localhost URI for webview access
  const localUri = vscode.Uri.parse(`http://localhost:${port}`);
  const externalUri = await vscode.env.asExternalUri(localUri);
  const apiBase = externalUri.toString().replace(/\/$/, '');

  // Inject API base URL for fetch calls
  const injection = `<script>window.GHCP_LENS_PORT=${port};window.GHCP_LENS_VSCODE=true;window.GHCP_LENS_API_BASE="${apiBase}";</script>`;
  html = html.replace('<head>', `<head>\n${injection}`);

  // Add CSP that allows connections to both localhost and the external URI
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${apiBase} http://localhost:${port} http://localhost:*; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">`;
  html = html.replace('<head>', `<head>\n${csp}`);

  return html;
}

function activate(context) {
  // Register sidebar webview provider
  const sidebarProvider = {
    resolveWebviewView: async (webviewView) => {
      webviewView.webview.options = { enableScripts: true };
      try {
        const port = await ensureServer();
        const localUri = vscode.Uri.parse(`http://localhost:${port}`);
        const externalUri = await vscode.env.asExternalUri(localUri);
        const apiBase = externalUri.toString().replace(/\/$/, '');
        const pkg = require('../package.json');
        const ver = pkg.version;
        const today = new Date().toISOString().slice(0, 10);
        webviewView.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { margin:0; padding:16px; font-family:var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-sideBar-background); display:flex; flex-direction:column; align-items:center; gap:14px; }
  .logo { margin-top:8px; }
  .title { font-size:15px; font-weight:700; letter-spacing:-0.3px; }
  .desc { font-size:12px; color:var(--vscode-descriptionForeground); text-align:center; line-height:1.5; }
  button { width:100%; padding:10px 12px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:5px; cursor:pointer; font-size:13px; font-weight:600; }
  button:hover { background:var(--vscode-button-hoverBackground); }
  hr { width:100%; border:none; border-top:1px solid var(--vscode-panel-border); margin:4px 0; }
  .meta { width:100%; font-size:11px; color:var(--vscode-descriptionForeground); }
  .meta-row { display:flex; justify-content:space-between; padding:3px 0; }
  .meta-label { opacity:0.7; }
  .links { display:flex; gap:12px; justify-content:center; }
  .links a { font-size:11px; color:var(--vscode-textLink-foreground); text-decoration:none; }
  .links a:hover { text-decoration:underline; }
</style></head><body>
  <div class="logo">
    <svg viewBox="0 0 128 128" width="52" height="52"><rect width="128" height="128" rx="24" fill="#2d333b"/><g transform="translate(16,12) scale(6)"><path fill="#e6edf3" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.84c.68.003 1.36.092 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></g><g transform="translate(82,82)"><line x1="13" y1="13" x2="29" y2="29" stroke="#58a6ff" stroke-width="6" stroke-linecap="round"/><circle cx="0" cy="0" r="22" fill="none" stroke="#58a6ff" stroke-width="4"/><circle cx="0" cy="0" r="19" fill="rgba(88,166,255,0.12)"/></g></svg>
  </div>
  <div class="title">GitHub Copilot Lens</div>
  <div class="desc">Real-time monitoring dashboard for GitHub Copilot CLI sessions.<br>Track every turn, tool call, agent chain, and token.</div>
  <button onclick="openDashboard()">Open Dashboard</button>
  <hr>
  <div class="meta">
    <div class="meta-row"><span class="meta-label">Version</span><span>v${ver}</span></div>
    <div class="meta-row"><span class="meta-label">Updated</span><span>${today}</span></div>
    <div class="meta-row"><span class="meta-label">Publisher</span><span>Jeonghoon Lee</span></div>
  </div>
  <hr>
  <div class="links">
    <a href="https://github.com/whoniiii/ghcplens">GitHub</a>
    <a href="https://www.linkedin.com/in/jeonghlee8024">LinkedIn</a>
    <a href="https://github.com/whoniiii/ghcplens/issues">Issues</a>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function openDashboard() { vscode.postMessage({ command: 'openDashboard' }); }
  </script>
</body></html>`;
      webviewView.webview.onDidReceiveMessage(message => {
        if (message.command === 'openDashboard') {
          vscode.commands.executeCommand('ghcpLens.open');
        }
      });
      } catch (err) {
        webviewView.webview.html = `<html><body style="padding:16px;color:red;">Failed to start server: ${err.message}</body></html>`;
      }
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('copilot-lens.welcome', sidebarProvider)
  );

  // Handle sidebar messages
  vscode.commands.registerCommand('ghcpLens._openFromSidebar', () => {
    vscode.commands.executeCommand('ghcpLens.open');
  });

  const disposable = vscode.commands.registerCommand('ghcpLens.open', async () => {
    // Reuse existing panel if open
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }

    try {
      const port = await ensureServer();

      panel = vscode.window.createWebviewPanel(
        'ghcpLens',
        'GitHub Copilot Lens',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'public'))],
          portMapping: [{ webviewPort: port, extensionHostPort: port }]
        }
      );

      panel.webview.html = await getWebviewContent(context.extensionPath, port);

      // Sync VS Code theme with dashboard
      function syncTheme() {
        const kind = vscode.window.activeColorTheme.kind;
        let theme = 'light';
        if (kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrastDark) {
          theme = 'dark';
        }
        panel.webview.postMessage({ type: 'theme-sync', theme });
      }
      syncTheme();
      const themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => syncTheme());

      // Handle messages from WebView
      panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'open-folder') {
          const isInsiders = vscode.env.appName.includes('Insiders');
          const wantInsiders = message.insiders === true;
          if (wantInsiders === isInsiders) {
            // Same VS Code variant — use native API
            const uri = vscode.Uri.file(message.folder);
            vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
          } else {
            // Different variant — launch via CLI
            const cmd = wantInsiders ? 'code-insiders' : 'code';
            require('child_process').execFile(cmd, [message.folder], { shell: true, windowsHide: true }, () => {});
          }
        }
      }, undefined, context.subscriptions);

      panel.onDidDispose(() => {
        panel = null;
        themeDisposable.dispose();
      }, undefined, context.subscriptions);

    } catch (err) {
      vscode.window.showErrorMessage(`GitHub Copilot Lens: Failed to start — ${err.message}`);
    }
  });

  context.subscriptions.push(disposable);
}

function deactivate() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    serverPort = null;
  }
  if (panel) {
    panel.dispose();
    panel = null;
  }
}

module.exports = { activate, deactivate };
