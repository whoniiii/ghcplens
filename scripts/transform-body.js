// Transform index-v2.html body structure for 2-level architecture
const fs = require('fs');

const filePath = 'C:/00-dev/ghcpstudio/public/index-v2.html';
let html = fs.readFileSync(filePath, 'utf8');

// Find markers
const bodyStart = html.indexOf('<body>');
const pathModalStart = html.indexOf('<!-- Path Config Modal -->');

if (bodyStart === -1 || pathModalStart === -1) {
  console.error('Markers not found! bodyStart:', bodyStart, 'pathModalStart:', pathModalStart);
  process.exit(1);
}

const before = html.substring(0, bodyStart);
const after = html.substring(pathModalStart);

const newBody = `<body>
<div class="app">

<!-- ===== Global Bar ===== -->
<div class="global-bar">
  <div class="app-logo">
    <span class="logo-mark"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAACxMAAAsTAQCanBgAAAB1SURBVFhH7daxDYAwDETRMLADI7MWO7ADfYqU4uQLsSwh/pNSpLj4PskOSf6Se3KIHiZ7l5zi0K1y6Fa5rlfl0K1y6Fa5rlfl0K1y6Fa5rlfl0K1y6FY5dCsc7xVpJNekiRySc9JMPJJL8vEPknQ3s3wBdFkbkFPsxlQAAAAASUVORK5CYII=" width="20" height="20" style="border-radius:4px"></span>
    GitHub Copilot Lens
  </div>
  <div class="status-pills" id="statusPills"></div>
  <div class="global-right">
    <div class="lang-selector" style="display:flex;gap:2px">
      <button class="g-btn" data-lang="ko" onclick="setLang('ko')">&#xD55C;</button>
      <button class="g-btn active" data-lang="en" onclick="setLang('en')">en</button>
      <button class="g-btn" data-lang="ja" onclick="setLang('ja')">&#x65E5;</button>
      <button class="g-btn" data-lang="zh" onclick="setLang('zh')">&#x4E2D;</button>
    </div>
    <div class="theme-selector" style="display:flex;gap:2px">
      <button class="g-btn active" onclick="setTheme('light')" data-theme="light">&#x2600;</button>
      <button class="g-btn" onclick="setTheme('gray')" data-theme="gray">&#x25D0;</button>
      <button class="g-btn" onclick="setTheme('dark')" data-theme="dark">&#x1F319;</button>
    </div>
    <div class="poll-ctrl" style="display:flex;gap:2px;align-items:center">
      <span style="font-size:10px;color:var(--text-muted);margin-right:2px;font-weight:500">Poll</span>
      <button class="g-btn active" onclick="setPollInterval(1)">1s</button>
      <button class="g-btn" onclick="setPollInterval(3)">3s</button>
      <button class="g-btn" onclick="setPollInterval(5)">5s</button>
      <button class="g-btn" onclick="setPollInterval(10)">10s</button>
    </div>
  </div>
</div>

<!-- ===== LEVEL 1: Session List ===== -->
<div id="level1View">
  <div class="body">
    <div class="list-panel">
      <div class="list-head">
        <span>Session</span><span>Memo</span><span style="text-align:right">Turns</span><span style="text-align:right">Tokens</span><span style="text-align:right">Recent</span>
      </div>
      <div class="list-scroll" id="sessionListScroll"></div>
    </div>
    <div class="detail-panel" id="detailPanel">
      <div class="dp-header" id="dpHeader" style="display:none"></div>
      <div class="dp-scroll" id="dpScroll">
        <div style="text-align:center;color:var(--text-muted);padding:40px;font-size:12px">Select a session to view details</div>
      </div>
    </div>
  </div>
</div>

<!-- ===== LEVEL 2: Turn Timeline ===== -->
<div id="level2View">
  <div class="top-bar" id="topBar" onclick="toggleTopExpand()">
    <button class="top-back" onclick="event.stopPropagation();switchToList()">&#x2190; Back</button>
    <div class="top-dot" id="topDot"></div>
    <span class="top-name" id="topName"></span>
    <span class="top-ago" id="topAgo"></span>
    <div class="top-pills" id="topPills"></div>
    <svg class="top-chev" id="topChev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
  </div>
  <div class="top-expand" id="topExpand">
    <div class="top-inner" id="topInner"></div>
  </div>
  <div class="main">
    <div class="left">
      <div class="left-head" id="leftHead">
        <span style="flex:1">Turn Timeline</span>
        <span id="turnCount" style="font-size:11px"></span>
      </div>
      <div class="scroll" id="turnScroll"></div>
    </div>
    <div class="right" id="agentDetailPanel">
      <div class="rp-empty" id="rpEmpty">Click an agent bar<br>to inspect details</div>
      <div id="rpContent" style="display:none">
        <div class="rp-toolbar">
          <span style="font-size:12px;font-weight:500" id="rpToolbarTitle">Agent Detail</span>
          <span class="rp-close" onclick="closeAgentDetail()">&#x2715;</span>
        </div>
        <div class="rp-scroll" id="rpScroll"></div>
      </div>
    </div>
  </div>
</div>

</div><!-- end .app -->

<!-- Tool Detail Modal (Level 3) -->
<div class="tool-modal-wrap" id="toolModalWrap" onclick="if(event.target===this)closeToolModal()">
  <div class="tool-modal">
    <div class="tool-modal-head">
      <span id="toolModalTitle"></span>
      <span class="tool-modal-x" onclick="closeToolModal()">&#x2715;</span>
    </div>
    <div id="toolModalBody"></div>
  </div>
</div>

`;

const result = before + newBody + after;
fs.writeFileSync(filePath, result);
console.log('HTML body replaced successfully');
console.log('New file size:', result.length, 'chars');
