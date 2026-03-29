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
  const result = await startServer(0);
  serverInstance = result.server;
  serverPort = result.port;
  return serverPort;
}

function getWebviewContent(extensionPath, port) {
  const htmlPath = path.join(extensionPath, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  // Inject API base URL for fetch calls
  const injection = `<script>window.GHCP_LENS_PORT=${port};window.GHCP_LENS_VSCODE=true;</script>`;
  html = html.replace('<head>', `<head>\n${injection}`);

  // Add CSP that allows localhost connections and inline scripts/styles
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src http://localhost:${port}; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">`;
  html = html.replace('<head>', `<head>\n${csp}`);

  return html;
}

function activate(context) {
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
        '🤖 Copilot Lens',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'public'))]
        }
      );

      panel.webview.html = getWebviewContent(context.extensionPath, port);

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
          const uri = vscode.Uri.file(message.folder);
          vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }
      }, undefined, context.subscriptions);

      panel.onDidDispose(() => {
        panel = null;
        themeDisposable.dispose();
      }, undefined, context.subscriptions);

    } catch (err) {
      vscode.window.showErrorMessage(`Copilot Lens: Failed to start — ${err.message}`);
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
