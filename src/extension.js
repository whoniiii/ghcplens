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
const pkg = require('../package.json');

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
        const ver = pkg.version;
        const today = new Date().toISOString().slice(0, 10);
        webviewView.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    <img src="data:image/png;base64,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" width="52" height="52" style="border-radius:8px">
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
      const msgDisposable = webviewView.webview.onDidReceiveMessage(message => {
        if (message.command === 'openDashboard') {
          vscode.commands.executeCommand('ghcpLens.open');
        }
      });
      context.subscriptions.push(msgDisposable);
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

  // Reset command — reopens dashboard showing the connect screen
  context.subscriptions.push(
    vscode.commands.registerCommand('ghcpLens.resetConnect', async () => {
      if (panel) { panel.dispose(); panel = null; }
      const port = await ensureServer();
      panel = vscode.window.createWebviewPanel(
        'ghcpLens', 'GitHub Copilot Lens', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'public'))],
          portMapping: [{ webviewPort: port, extensionHostPort: port }] }
      );
      let html = await getWebviewContent(context.extensionPath, port);
      html = html.replace('window.GHCP_LENS_VSCODE=true;', 'window.GHCP_LENS_VSCODE=true;window.GHCP_LENS_RESET=true;');
      panel.webview.html = html;
      panel.onDidDispose(() => { panel = null; }, undefined, context.subscriptions);
    })
  );
}

function deactivate() {
  if (serverInstance) {
    if (typeof serverInstance.closeAllConnections === 'function') {
      serverInstance.closeAllConnections();
    }
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
