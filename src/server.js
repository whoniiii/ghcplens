/**
 * GitHub Copilot Lens — Session Monitor Dashboard
 * 
 * Reads ~/.copilot/session-state/ to monitor Copilot CLI sessions in real-time.
 * 
 * Port: 3002
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = 3002;
const COPILOT_DIR = process.env.COPILOT_DIR || path.join(os.homedir(), '.copilot');
let SESSION_STATE_DIR = process.env.COPILOT_SESSION_DIR || path.join(COPILOT_DIR, 'session-state');

// Event types that indicate "waiting for user input"
const WAITING_TOOLS = new Set(['ask_user', 'ask_permission']);
const EVENT_TAIL_BYTES = 32768;
const STALE_THRESHOLD_MS = 60000;

// ── Caching Layer ──────────────────────────────────────────────────────────
// Cache stats by sessionId+fileSize — if file hasn't grown, stats are unchanged.
// Cache full scan result with TTL — prevents redundant scans within same refresh.

const statsCache = new Map();    // sessionId → { fileSize, stats, bgData }
const intentCache = new Map();   // sessionId → { fileSize, intent }
const msgCache = new Map();      // sessionId → { fileSize, summary, lastUserMessage }
const scanResultCache = { data: null, ts: 0 };
const SCAN_CACHE_TTL = 1500;   // 1.5 seconds
const turnsCache = new Map();   // sessionId → { fileSize, turns[] }

// ── Session State Reader ───────────────────────────────────────────────────

function readYaml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (match) result[match[1]] = match[2].trim();
    }
    return result;
  } catch { return null; }
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: { key: value, ... }, body: string }
 * If no frontmatter found, returns { frontmatter: {}, body: content }
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content };
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: content };

  const yamlBlock = content.substring(4, endIdx); // skip opening ---\n
  const body = content.substring(endIdx + 4).trim(); // skip closing ---\n
  const frontmatter = {};
  let currentKey = '';
  let currentValue = '';

  for (const line of yamlBlock.split('\n')) {
    // New key-value pair (not indented continuation)
    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      if (currentKey) frontmatter[currentKey] = currentValue.trim();
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      // Handle YAML multiline indicator (> or |)
      currentValue = (val === '>' || val === '|') ? '' : val;
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      // Continuation line for multiline value
      currentValue += (currentValue ? ' ' : '') + line.trim();
    }
  }
  if (currentKey) frontmatter[currentKey] = currentValue.trim();
  return { frontmatter, body };
}

/**
 * Read project's GitHub Copilot configuration based on session cwd.
 * Reads .github/agents/*.md, .github/skills/*, .github/copilot-instructions.md
 */
function getProjectConfig(sessionId) {
  const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) return null;

  const workspace = readYaml(path.join(sessionDir, 'workspace.yaml'));
  if (!workspace || !workspace.cwd) return null;

  const cwd = workspace.cwd;
  if (!fs.existsSync(cwd)) return { agents: [], skills: [], copilotInstructions: null };

  const resolvedCwd = path.resolve(cwd);

  // Helper: ensure a path is within cwd (path traversal guard)
  const safePath = (target) => {
    const resolved = path.resolve(target);
    return resolved.startsWith(resolvedCwd) ? resolved : null;
  };

  // ── 1. Agents: .github/agents/*.md ──
  const agents = [];
  const agentsDir = safePath(path.join(cwd, '.github', 'agents'));
  if (agentsDir) {
    try {
      const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = safePath(path.join(agentsDir, file));
        if (!filePath) continue;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);
          agents.push({
            name: frontmatter.name || file.replace(/\.md$/, ''),
            description: frontmatter.description || '',
            body: body.substring(0, 2000),
            fileName: file,
          });
        } catch {}
      }
    } catch {}
  }

  // ── 2. Skills: .github/skills/*/ ──
  const skills = [];
  const skillsDir = safePath(path.join(cwd, '.github', 'skills'));
  if (skillsDir) {
    try {
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        const entryPath = safePath(path.join(skillsDir, entry));
        if (!entryPath) continue;
        try {
          if (!fs.statSync(entryPath).isDirectory()) continue;
        } catch { continue; }

        let name = entry;
        let description = '';
        let body = '';

        // Try README.md or SKILL.md for frontmatter
        for (const mdFile of ['README.md', 'SKILL.md']) {
          const mdPath = safePath(path.join(entryPath, mdFile));
          if (!mdPath) continue;
          try {
            const content = fs.readFileSync(mdPath, 'utf-8');
            const { frontmatter, body: mdBody } = parseFrontmatter(content);
            if (frontmatter.name) name = frontmatter.name;
            if (frontmatter.description) description = frontmatter.description;
            body = mdBody || '';
            break; // Use the first file found
          } catch {}
        }

        skills.push({ name, description, body, path: entry });
      }
    } catch {}
  }

  // ── 3. Copilot Instructions: .github/copilot-instructions.md ──
  let copilotInstructions = null;
  const instructionsPath = safePath(path.join(cwd, '.github', 'copilot-instructions.md'));
  if (instructionsPath) {
    try {
      const content = fs.readFileSync(instructionsPath, 'utf-8');
      const lines = content.split('\n').length;
      copilotInstructions = {
        exists: true,
        content: content.substring(0, 5000),
        lines,
      };
    } catch {
      copilotInstructions = { exists: false, content: null, lines: 0 };
    }
  } else {
    copilotInstructions = { exists: false, content: null, lines: 0 };
  }

  return { agents, skills, copilotInstructions };
}

function readRecentEvents(sessionDir, count = 30) {
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  try {
    const stat = fs.statSync(eventsFile);
    const fd = fs.openSync(eventsFile, 'r');
    const readFrom = Math.max(0, stat.size - EVENT_TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(stat.size, EVENT_TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);

    let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    if (readFrom > 0 && lines.length > 0) lines = lines.slice(1);

    const events = [];
    for (const line of lines.slice(-count)) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch { return []; }
}

/**
 * Reads the full events.jsonl ONCE and returns combined stats + bgTask data.
 * Results are cached by file size — if the file hasn't grown, reuse cache.
 */
function getFullFileData(sessionDir, sessionId) {
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  let fileSize = 0;
  try { fileSize = fs.statSync(eventsFile).size; } catch {
    return { stats: { turnCount: 0, toolCalls: 0, subagentRuns: 0 }, bgTasks: 0, bgTaskList: [] };
  }

  const cached = statsCache.get(sessionId);
  if (cached && cached.fileSize === fileSize) return cached.data;

  // Single pass through the file for ALL counts
  let turnCount = 0, toolCalls = 0, subagentRuns = 0, outputTokens = 0;
  const started = new Map();

  try {
    const content = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      if (line.includes('"assistant.turn_end"')) turnCount++;
      if (line.includes('"tool.execution_start"')) toolCalls++;
      if (line.includes('"assistant.message"')) {
        try {
          const evt = JSON.parse(line);
          const tokens = (evt.data || {}).outputTokens;
          if (typeof tokens === 'number') outputTokens += tokens;
        } catch {}
      }
      if (line.includes('"subagent.started"')) {
        subagentRuns++;
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const tcid = d.toolCallId || '';
          if (tcid) started.set(tcid, { name: d.agentDisplayName || d.agentName || '', desc: d.agentDescription || '' });
        } catch {}
      } else if (line.includes('"subagent.completed"') || line.includes('"subagent.failed"')) {
        try {
          const evt = JSON.parse(line);
          started.delete((evt.data || {}).toolCallId || '');
        } catch {}
      }
    }
  } catch {}

  const bgTaskList = [];
  for (const [, v] of started) bgTaskList.push(v);

  const data = {
    stats: { turnCount, toolCalls, subagentRuns, outputTokens },
    bgTasks: started.size,
    bgTaskList,
  };

  statsCache.set(sessionId, { fileSize, data });
  return data;
}

function getSessionState(sessionDir, sessionId) {
  const events = readRecentEvents(sessionDir, 30);
  if (!events.length) return { state: 'unknown', waitingContext: '', bgTasks: 0, bgTaskList: [] };

  const { bgTasks, bgTaskList } = getFullFileData(sessionDir, sessionId);

  // Track pending tool calls from tail events
  const pendingTools = new Map();
  for (const ev of events) {
    const t = ev.type || '';
    const d = ev.data || {};
    if (t === 'tool.execution_start') {
      const tcid = d.toolCallId || '';
      if (tcid) pendingTools.set(tcid, d);
    } else if (t === 'tool.execution_complete') {
      pendingTools.delete((d.toolCallId || ''));
    }
  }

  let hasPendingWork = false;
  for (const [, data] of pendingTools) {
    const tool = data.toolName || '';
    if (WAITING_TOOLS.has(tool)) {
      const args = data.arguments || {};
      let ctx = args.question || '';
      if (args.choices && args.choices.length) ctx += ' [' + args.choices.slice(0, 4).join(' / ') + ']';
      return { state: 'waiting', waitingContext: ctx, bgTasks, bgTaskList };
    }
    if (tool !== 'report_intent') hasPendingWork = true;
  }

  if (hasPendingWork) {
    const lastTs = events[events.length - 1].timestamp || '';
    if (lastTs) {
      const age = Date.now() - new Date(lastTs).getTime();
      if (age > STALE_THRESHOLD_MS) {
        return { state: 'waiting', waitingContext: 'Session likely waiting for input', bgTasks, bgTaskList };
      }
    }
    return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  }

  const last = events[events.length - 1];
  const etype = last.type || '';

  if (etype === 'assistant.turn_end') {
    // If turn ended very recently (<10s), keep as working to avoid flickering
    const lastTs = last.timestamp || '';
    if (lastTs) {
      const age = Date.now() - new Date(lastTs).getTime();
      if (age < 5000) return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
    }
    return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  }
  if (etype === 'tool.execution_start') {
    const tool = (last.data || {}).toolName || '';
    if (WAITING_TOOLS.has(tool)) {
      const args = (last.data || {}).arguments || {};
      return { state: 'waiting', waitingContext: args.question || '', bgTasks, bgTaskList };
    }
    return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  }
  if (etype === 'user.message') return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'assistant.turn_start' || etype === 'assistant.message') return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.task_complete') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'tool.execution_complete') return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.compaction' || etype === 'session.mode_changed') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.resume' || etype === 'session.start') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.warning' || etype === 'session.info' || etype === 'session.shutdown') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'subagent.completed' || etype === 'system.notification') return { state: 'working', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'hook.start' || etype === 'hook.end') return { state: 'working', waitingContext: '', bgTasks, bgTaskList };

  return { state: 'unknown', waitingContext: '', bgTasks, bgTaskList };
}

function getSessionIntent(sessionDir) {
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  try {
    const stat = fs.statSync(eventsFile);
    const sessionId = path.basename(sessionDir);

    // Cache hit — file hasn't grown, intent unchanged
    const cached = intentCache.get(sessionId);
    if (cached && cached.fileSize === stat.size) return cached.intent;

    // Read 512KB tail to find last report_intent (large sessions have huge events)
    const tailBytes = 524288;
    const fd = fs.openSync(eventsFile, 'r');
    const readFrom = Math.max(0, stat.size - tailBytes);
    const buf = Buffer.alloc(Math.min(stat.size, tailBytes));
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);

    let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    if (readFrom > 0 && lines.length > 0) lines = lines.slice(1);

    let intent = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'tool.execution_start' && (ev.data || {}).toolName === 'report_intent') {
          intent = ((ev.data || {}).arguments || {}).intent || '';
          break;
        }
      } catch {}
    }

    intentCache.set(sessionId, { fileSize: stat.size, intent });
    return intent;
  } catch {}
  return '';
}

function isSessionActive(sessionDir) {
  try {
    const files = fs.readdirSync(sessionDir);
    const lockFiles = files.filter(f => f.startsWith('inuse.') && f.endsWith('.lock'));
    if (!lockFiles.length) return false;

    // Verify at least one lock PID is actually a copilot/node process
    for (const lf of lockFiles) {
      const match = lf.match(/^inuse\.(\d+)\.lock$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      try {
        process.kill(pid, 0); // signal 0 = check if alive, doesn't kill
        // Verify it's actually a node/copilot process (not a recycled PID)
        if (process.platform === 'win32') {
          try {
            const result = require('child_process').execSync(
              `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
              { encoding: 'utf-8', timeout: 3000 }
            );
            const lower = result.toLowerCase();
            if (!lower.includes('node') && !lower.includes('copilot')) continue;
          } catch { continue; }
        }
        return true;
      } catch {}
    }
    return false; // all lock PIDs are dead or not copilot
  } catch { return false; }
}

function scanSessions() {
  // Return cached result if within TTL
  const now = Date.now();
  if (scanResultCache.data && (now - scanResultCache.ts) < SCAN_CACHE_TTL) {
    return scanResultCache.data;
  }

  if (!fs.existsSync(SESSION_STATE_DIR)) return [];

  const sessions = [];
  const entries = fs.readdirSync(SESSION_STATE_DIR);

  for (const entry of entries) {
    const sessionDir = path.join(SESSION_STATE_DIR, entry);
    try { if (!fs.statSync(sessionDir).isDirectory()) continue; } catch { continue; }

    const workspace = readYaml(path.join(sessionDir, 'workspace.yaml'));
    if (!workspace) continue;

    // Mark ghost sessions (lock file exists but no events.jsonl — never started)
    const eventsExists = fs.existsSync(path.join(sessionDir, 'events.jsonl'));
    const isEmpty = !eventsExists && !workspace.summary;

    const active = isSessionActive(sessionDir) && eventsExists;
    const state = active
      ? getSessionState(sessionDir, entry)
      : { state: 'completed', waitingContext: '', bgTasks: 0, bgTaskList: [] };
    const intent = getSessionIntent(sessionDir);
    const { stats } = getFullFileData(sessionDir, entry);

    // Read checkpoints (directory listing only, no file content)
    const cpDir = path.join(sessionDir, 'checkpoints');
    let checkpoints = [];
    try {
      checkpoints = fs.readdirSync(cpDir)
        .filter(f => f.endsWith('.md') && f !== 'index.md')
        .sort()
        .map(f => {
          const name = f.replace('.md', '');
          const parts = name.split('-');
          const num = parseInt(parts[0], 10);
          const title = parts.slice(1).join(' ');
          return { number: num, title, file: f };
        });
    } catch {}

    // Summary + last user message (cached by file size)
    let summary = workspace.summary || '';
    let lastUserMessage = '';
    {
      const eventsFile = path.join(sessionDir, 'events.jsonl');
      try {
        const stat = fs.statSync(eventsFile);
        const cached = msgCache.get(entry);
        if (cached && cached.fileSize === stat.size) {
          if (!summary) summary = cached.summary;
          lastUserMessage = cached.lastUserMessage;
        } else {
          const extractUserMessages = (buf, skipFirst) => {
            let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
            if (skipFirst && lines.length > 0) lines = lines.slice(1);
            let first = '', last = '';
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'user.message') {
                  let msg = (ev.data || {}).content || '';
                  // Strip leading XML tags like <current_datetime>...</current_datetime>
                  msg = msg.replace(/^(<[^>]+>.*?<\/[^>]+>\s*)+/s, '').trim();
                  if (msg) {
                    if (!first) first = msg.substring(0, 120);
                    last = msg.substring(0, 120);
                  }
                }
              } catch {}
            }
            return { first, last };
          };

          const fd = fs.openSync(eventsFile, 'r');
          // Read tail (512KB) for recent messages
          const tailBytes = 524288;
          const readFrom = Math.max(0, stat.size - tailBytes);
          const tailBuf = Buffer.alloc(Math.min(stat.size, tailBytes));
          fs.readSync(fd, tailBuf, 0, tailBuf.length, readFrom);
          const tailResult = extractUserMessages(tailBuf, readFrom > 0);

          // If tail found messages, use them
          let firstMsg = tailResult.first;
          lastUserMessage = tailResult.last;

          // If tail missed messages (small session or messages only at start), read head too
          if (!firstMsg && readFrom > 0) {
            const headBytes = Math.min(stat.size, 262144); // 256KB head
            const headBuf = Buffer.alloc(headBytes);
            fs.readSync(fd, headBuf, 0, headBytes, 0);
            const headResult = extractUserMessages(headBuf, false);
            firstMsg = headResult.first;
            if (!lastUserMessage) lastUserMessage = headResult.last;
          }

          fs.closeSync(fd);
          if (!summary) summary = firstMsg;
          msgCache.set(entry, { fileSize: stat.size, summary: firstMsg, lastUserMessage });
        }
      } catch {}
    }
    if (!summary) summary = '(빈 세션)';

    // For active sessions, use last event timestamp (workspace.yaml updated_at is stale)
    let updatedAt = workspace.updated_at || '';
    if (active) {
      const recentEvts = readRecentEvents(sessionDir, 5);
      if (recentEvts.length) {
        const lastTs = recentEvts[recentEvts.length - 1].timestamp || '';
        if (lastTs) {
          // Convert event timestamp to ISO format
          const d = new Date(lastTs);
          if (!isNaN(d.getTime())) updatedAt = d.toISOString();
        }
      }
    }

    // Read lens-meta.json (our custom metadata, not touched by Copilot)
    let lensMeta = {};
    try { lensMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'lens-meta.json'), 'utf-8')); } catch {}

    sessions.push({
      id: entry,
      cwd: workspace.cwd || '',
      repository: workspace.repository || '',
      branch: workspace.branch || '',
      summary,
      lastUserMessage,
      isEmpty,
      createdAt: workspace.created_at || '',
      updatedAt,
      isActive: active,
      state: state.state,
      waitingContext: state.waitingContext,
      bgTasks: state.bgTasks || 0,
      bgTaskList: state.bgTaskList || [],
      intent,
      turnCount: stats.turnCount,
      toolCalls: stats.toolCalls,
      subagentRuns: stats.subagentRuns,
      outputTokens: stats.outputTokens,
      checkpoints,
      description: lensMeta.description || '',
    });
  }

  sessions.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  scanResultCache.data = sessions;
  scanResultCache.ts = Date.now();
  return sessions;
}

function getSessionDetail(sessionId) {
  const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) return null;

  const workspace = readYaml(path.join(sessionDir, 'workspace.yaml'));
  const active = isSessionActive(sessionDir);
  const state = active
    ? getSessionState(sessionDir, sessionId)
    : { state: 'completed', waitingContext: '', bgTasks: 0, bgTaskList: [] };
  const intent = getSessionIntent(sessionDir);
  const { stats, bgTasks, bgTaskList } = getFullFileData(sessionDir, sessionId);

  // Recent user messages
  const turns = [];
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  const toolCounter = {};
  const recentEvents = [];
  const filesModified = new Set();

  try {
    const content = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      if (line.includes('"user.message"')) {
        try {
          const evt = JSON.parse(line);
          let msg = (evt.data || {}).content || '';
          msg = msg.replace(/^(<[^>]+>.*?<\/[^>]+>\s*)+/s, '').trim();
          if (msg) turns.push({ type: 'user', content: msg.substring(0, 500), timestamp: evt.timestamp });
        } catch {}
      }

      // Count tool usage
      if (line.includes('"tool.execution_start"')) {
        try {
          const evt = JSON.parse(line);
          const tool = (evt.data || {}).toolName || '';
          if (tool) toolCounter[tool] = (toolCounter[tool] || 0) + 1;
        } catch {}
      }

      // Track files modified (edit/create tools)
      if (line.includes('"tool.execution_start"') && (line.includes('"edit"') || line.includes('"create"'))) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          if (d.toolName === 'edit' || d.toolName === 'create') {
            const p = (d.arguments || {}).path || '';
            if (p) filesModified.add(p);
          }
        } catch {}
      }

      // Collect recent notable events (last pass — we'll slice later)
      if (line.includes('"session.task_complete"') || line.includes('"subagent.started"') || 
          line.includes('"subagent.completed"') || line.includes('"session.compaction"') ||
          line.includes('"session.mode_changed"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          recentEvents.push({
            type: evt.type,
            timestamp: evt.timestamp,
            summary: d.summary || d.agentDisplayName || d.agentName || d.mode || ''
          });
        } catch {}
      }
    }
  } catch {}

  // Checkpoints with content
  const cpDir = path.join(sessionDir, 'checkpoints');
  let checkpoints = [];
  try {
    checkpoints = fs.readdirSync(cpDir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .sort()
      .map(f => {
        const name = f.replace('.md', '');
        const parts = name.split('-');
        const num = parseInt(parts[0], 10);
        const title = parts.slice(1).join(' ');
        let content = '';
        try { content = fs.readFileSync(path.join(cpDir, f), 'utf-8').substring(0, 2000); } catch {}
        return { number: num, title, content };
      });
  } catch {}

  // Plan.md
  let planContent = '';
  try { planContent = fs.readFileSync(path.join(sessionDir, 'plan.md'), 'utf-8').substring(0, 3000); } catch {}

  // Top tools
  const topTools = Object.entries(toolCounter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  // Read lens-meta.json (our custom metadata, not touched by Copilot)
  let lensMeta = {};
  try { lensMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'lens-meta.json'), 'utf-8')); } catch {}

  return {
    id: sessionId,
    ...(workspace || {}),
    isActive: active,
    state: state.state,
    waitingContext: state.waitingContext,
    bgTasks: bgTasks || state.bgTasks,
    bgTaskList: bgTaskList.length ? bgTaskList : (state.bgTaskList || []),
    intent,
    ...stats,
    recentTurns: [],
    totalTurns: turns.length,
    checkpoints,
    planContent,
    topTools,
    recentEvents: recentEvents.slice(-20),
    filesModified: [...filesModified].slice(-30),
    description: lensMeta.description || '',
  };
}

// ── Time helper ─────────────────────────────────────────────────────────────

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Agent Data Parser ───────────────────────────────────────────────────────
// Single-pass events.jsonl parser for both /agents and /turn-agents endpoints.

function parseAgentData(eventsFile) {
  const agents = [];
  const agentMap = new Map();    // toolCallId → agent object
  const turnMap = new Map();     // interactionId → turn object
  const taskPrompts = new Map(); // toolCallId → prompt (from tool.execution_start where toolName=task)
  const tcidToIid = new Map();   // toolCallId → interactionId (from assistant.message toolRequests)

  try {
    const content = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line) continue;

      // ── subagent.started ──
      if (line.includes('"subagent.started"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const tcid = d.toolCallId || '';
          const info = {
            toolCallId: tcid,
            name: d.agentDisplayName || d.agentName || 'Unknown',
            type: d.agentName || '',
            description: (d.agentDescription || '').substring(0, 200),
            startedAt: evt.timestamp || '',
            completedAt: null,
            status: 'running',
            result: '',
            agentPrompt: '',
            internalToolCalls: 0,
            internalTurns: 0,
            totalOutputTokens: 0,
            toolBreakdown: {},
            finalResult: '',
            interactionId: '',
          };
          agentMap.set(tcid, info);
          agents.push(info);
        } catch {}
        continue;
      }

      // ── subagent.completed / failed ──
      if (line.includes('"subagent.completed"') || line.includes('"subagent.failed"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const tcid = d.toolCallId || '';
          const info = agentMap.get(tcid);
          if (info) {
            info.completedAt = evt.timestamp || '';
            info.status = line.includes('failed') ? 'failed' : 'done';
            info.result = (d.result || d.error || '').substring(0, 1000);
          }
        } catch {}
        continue;
      }

      // ── tool.execution_start ──
      if (line.includes('"tool.execution_start"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const parentId = d.parentToolCallId || '';

          if (parentId) {
            // Internal tool call within an agent
            const agent = agentMap.get(parentId);
            if (agent) {
              agent.internalToolCalls++;
              const toolName = d.toolName || 'unknown';
              agent.toolBreakdown[toolName] = (agent.toolBreakdown[toolName] || 0) + 1;
            }
          } else {
            // Main session — capture agentPrompt from task tool calls
            const toolName = d.toolName || '';
            if (toolName === 'task') {
              const args = d.arguments || {};
              const tcid = d.toolCallId || '';
              if (tcid && args.prompt) {
                taskPrompts.set(tcid, (args.prompt || '').substring(0, 2000));
              }
            }
          }
        } catch {}
        continue;
      }

      // ── assistant.message ──
      if (line.includes('"assistant.message"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const parentId = d.parentToolCallId || '';

          if (parentId) {
            const agent = agentMap.get(parentId);
            if (agent) {
              agent.internalTurns++;
              const tokens = d.outputTokens;
              if (typeof tokens === 'number') agent.totalOutputTokens += tokens;
              const c = d.content || '';
              if (c) agent.finalResult = c.substring(0, 2000);
            }
          } else {
            // Main session assistant.message — map toolCallIds to interactionId
            const iid = d.interactionId || '';
            if (iid && Array.isArray(d.toolRequests)) {
              for (const tr of d.toolRequests) {
                if (tr.toolCallId) tcidToIid.set(tr.toolCallId, iid);
              }
            }
          }
        } catch {}
        continue;
      }

      // ── user.message ──
      if (line.includes('"user.message"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const iid = d.interactionId || '';
          if (iid) {
            let msg = (d.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 200);
            // Detect /agent target from transformedContent
            let targetAgent = null;
            const tc = d.transformedContent || '';
            if (tc.includes('<agent_instructions>')) {
              const m = tc.match(/<agent_instructions>\s*#\s*(\S+)/);
              if (m) targetAgent = m[1].toLowerCase();
            }
            turnMap.set(iid, {
              interactionId: iid,
              userMessage: msg,
              timestamp: evt.timestamp || '',
              targetAgent,
              agents: [],
            });
          }
        } catch {}
        continue;
      }
    }
  } catch {}

  // Post-pass: apply taskPrompts and interactionIds to agents
  for (const agent of agents) {
    const prompt = taskPrompts.get(agent.toolCallId);
    if (prompt) agent.agentPrompt = prompt;
    // Link agent to interactionId via tcidToIid (assistant.message toolRequests)
    if (!agent.interactionId) {
      const iid = tcidToIid.get(agent.toolCallId);
      if (iid) agent.interactionId = iid;
    }
  }

  return { agents, agentMap, turnMap };
}

// ── Tool Call Detail Parser ─────────────────────────────────────────────────
// Reads events.jsonl and extracts tool call input/output for the main session.

function getToolCalls(eventsFile, turnIndexFilter, toolNameFilter, iidFilter, parentFilter) {
  const MAX_LEN = 5000;
  const iidToIndex = new Map();
  let turnCounter = 0;
  const tcidToIid = new Map();
  const toolEntries = new Map();
  const toolResults = new Map();
  const userMsgOrder = [];          // [{iid, ts}] for timestamp-based override
  const iidToTs = new Map();        // interactionId → timestamp (for override comparison)

  try {
    const content = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line) continue;

      // ── user.message → build interactionId → turnIndex mapping
      if (line.includes('"user.message"')) {
        try {
          const evt = JSON.parse(line);
          const iid = (evt.data || {}).interactionId || '';
          if (iid && !iidToIndex.has(iid)) {
            iidToIndex.set(iid, turnCounter++);
            const ts = evt.timestamp || '';
            userMsgOrder.push({ iid, ts });
            iidToTs.set(iid, ts);
          }
        } catch {}
        continue;
      }

      // ── assistant.message (main session) → map toolCallIds to interactionId
      if (line.includes('"assistant.message"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          if (d.parentToolCallId) continue; // skip agent-internal
          const iid = d.interactionId || '';
          if (iid && Array.isArray(d.toolRequests)) {
            for (const tr of d.toolRequests) {
              if (tr.toolCallId) tcidToIid.set(tr.toolCallId, iid);
            }
          }
        } catch {}
        continue;
      }

      // ── tool.execution_start → capture toolName, arguments, timestamp
      if (line.includes('"tool.execution_start"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const ptcid = d.parentToolCallId || '';
          // parentFilter: show only agent-internal tools; no parentFilter: show only main-session tools
          if (parentFilter) {
            if (ptcid !== parentFilter) continue;
          } else {
            if (ptcid) continue;
          }
          const tcid = d.toolCallId || '';
          if (tcid && d.toolName) {
            toolEntries.set(tcid, {
              toolName: d.toolName,
              input: d.arguments || {},
              timestamp: evt.timestamp || '',
            });
          }
        } catch {}
        continue;
      }

      // ── tool.execution_complete → capture result
      if (line.includes('"tool.execution_complete"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const ptcid = d.parentToolCallId || '';
          if (parentFilter) {
            if (ptcid !== parentFilter) continue;
          } else {
            if (ptcid) continue;
          }
          const tcid = d.toolCallId || '';
          if (tcid) {
            let result = d.result;
            if (result && typeof result === 'object') {
              result = result.content != null ? String(result.content) : JSON.stringify(result);
            }
            toolResults.set(tcid, result != null ? String(result) : '');
          }
        } catch {}
        continue;
      }
    }
  } catch {}

  // ── Timestamp override helper (same as buildTimeline) ──
  const findTurnByTs = (ts) => {
    if (!ts || userMsgOrder.length === 0) return null;
    let best = null;
    for (const um of userMsgOrder) {
      if (um.ts <= ts) best = um;
      else break;
    }
    return best;
  };

  // ── Build output list with filters ──
  const output = [];
  for (const [tcid, entry] of toolEntries) {
    let iid = tcidToIid.get(tcid) || '';

    // Timestamp override: attribute tool to correct turn (same logic as buildTimeline)
    if (!parentFilter) {
      const evtTs = entry.timestamp || '';
      if (evtTs) {
        const tsTurn = findTurnByTs(evtTs);
        if (tsTurn) {
          const origTurnTs = iid ? (iidToTs.get(iid) || '') : '';
          if (!iid || tsTurn.ts > origTurnTs) {
            iid = tsTurn.iid;
          }
        }
      }
      if (!iid && entry.timestamp) {
        const tsTurn = findTurnByTs(entry.timestamp);
        if (tsTurn) iid = tsTurn.iid;
      }
    }

    const turnIndex = iid ? (iidToIndex.get(iid) ?? -1) : -1;

    // Apply filters
    if (iidFilter && iid !== iidFilter) continue;
    if (turnIndexFilter !== null && turnIndex !== turnIndexFilter) continue;
    if (toolNameFilter && entry.toolName !== toolNameFilter) continue;

    // Truncate input
    let input = entry.input;
    let inputTruncated = false;
    if (typeof input === 'object') {
      const s = JSON.stringify(input);
      if (s.length > MAX_LEN) {
        input = s.substring(0, MAX_LEN);
        inputTruncated = true;
      }
    } else {
      const s = String(input);
      if (s.length > MAX_LEN) {
        input = s.substring(0, MAX_LEN);
        inputTruncated = true;
      }
    }

    // Truncate result
    let result = toolResults.get(tcid) || '';
    let resultTruncated = false;
    if (result.length > MAX_LEN) {
      result = result.substring(0, MAX_LEN);
      resultTruncated = true;
    }

    const item = {
      toolCallId: tcid,
      toolName: entry.toolName,
      input,
      result,
      timestamp: entry.timestamp,
      turnIndex,
    };
    if (inputTruncated || resultTruncated) item.truncated = true;

    output.push(item);
  }

  return output;
}

// Single-pass events.jsonl parser for hierarchical timeline view.

function buildTimeline(eventsFile, limit, page) {
  limit = Math.max(1, Math.min(limit || 50, 500));
  page = Math.max(1, page || 1);

  const turnMap = new Map();        // interactionId → turn object
  const agentMap = new Map();       // toolCallId → agent object
  const tcidToIid = new Map();      // toolCallId → interactionId (from assistant.message toolRequests)
  const taskPrompts = new Map();    // toolCallId → prompt (from tool.execution_start where toolName=task)
  const agentParent = new Map();    // childToolCallId → parentAgentToolCallId
  const directToolMap = new Map();  // interactionId → Map(toolName → count)
  const userMsgOrder = [];          // [{iid, ts}] ordered by time — for timestamp-based fallback
  const toolTimestamps = new Map(); // toolCallId → timestamp

  // Helper: find the correct turn by timestamp (most recent user.message before ts)
  const findTurnByTs = (ts) => {
    if (!ts || userMsgOrder.length === 0) return null;
    let best = null;
    for (const um of userMsgOrder) {
      if (um.ts <= ts) best = um;
      else break;
    }
    return best ? turnMap.get(best.iid) : null;
  };

  try {
    const content = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line) continue;

      // ── user.message ──
      if (line.includes('"user.message"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const iid = d.interactionId || '';
          if (iid) {
            let targetAgent = null;
            const tc = d.transformedContent || '';
            if (tc.includes('<agent_instructions>')) {
              const m = tc.match(/<agent_instructions>\s*#\s*(\S+)/);
              if (m) targetAgent = m[1].toLowerCase();
            }
            turnMap.set(iid, {
              interactionId: iid,
              timestamp: evt.timestamp || '',
              userMessage: (d.content || '').trim().substring(0, 500),
              assistantMessage: '',
              directToolCalls: [],
              targetAgent,
              agents: [],
            });
            userMsgOrder.push({ iid, ts: evt.timestamp || '' });
          }
        } catch {}
        continue;
      }

      // ── assistant.message ──
      if (line.includes('"assistant.message"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const parentId = d.parentToolCallId || '';

          if (!parentId) {
            // Main session assistant response
            const iid = d.interactionId || '';
            const evtTs = evt.timestamp || '';
            let turn = null;
            if (iid) {
              turn = turnMap.get(iid);
            }
            // Timestamp override: if a newer user message exists and this assistant.message
            // is after it, attribute to the newer turn instead
            if (evtTs) {
              const tsTurn = findTurnByTs(evtTs);
              if (tsTurn && (!turn || tsTurn.timestamp > turn.timestamp)) {
                turn = tsTurn;
              }
            }
            // Last resort: most recent turn without an assistant response
            if (!turn && turnMap.size > 0) {
              const turns = Array.from(turnMap.values());
              for (let i = turns.length - 1; i >= 0; i--) {
                if (!turns[i].assistantMessage) { turn = turns[i]; break; }
              }
              if (!turn) turn = turns[turns.length - 1];
            }
            if (turn) {
              const c = d.content || '';
              if (c && c.length > (turn.assistantMessage || '').length) {
                turn.assistantMessage = c.substring(0, 500);
              }
            }
            // Map toolRequests toolCallIds → interactionId
            if (iid && Array.isArray(d.toolRequests)) {
              for (const tr of d.toolRequests) {
                if (tr.toolCallId) tcidToIid.set(tr.toolCallId, iid);
              }
            }
          } else {
            // Agent internal message — count turns/tokens
            const agent = agentMap.get(parentId);
            if (agent) {
              agent.internalTurns++;
              const tokens = d.outputTokens;
              if (typeof tokens === 'number') agent.totalOutputTokens += tokens;
              const c = d.content || '';
              if (c) agent.finalResult = c.substring(0, 1000);
            }
            // Track sub-agent creation from agent's toolRequests
            if (Array.isArray(d.toolRequests)) {
              for (const tr of d.toolRequests) {
                if (tr.toolCallId && tr.toolName === 'task') {
                  agentParent.set(tr.toolCallId, parentId);
                }
              }
            }
          }
        } catch {}
        continue;
      }

      // ── subagent.started ──
      if (line.includes('"subagent.started"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const tcid = d.toolCallId || '';
          if (tcid) {
            agentMap.set(tcid, {
              toolCallId: tcid,
              name: d.agentDisplayName || d.agentName || 'Unknown',
              type: d.agentName || '',
              status: 'running',
              startedAt: evt.timestamp || '',
              completedAt: null,
              duration: 0,
              agentPrompt: '',
              finalResult: '',
              internalToolCalls: 0,
              internalTurns: 0,
              totalOutputTokens: 0,
              toolBreakdown: {},
              children: [],
              _isChild: false,
              interactionId: '',
            });
          }
        } catch {}
        continue;
      }

      // ── subagent.completed / failed ──
      if (line.includes('"subagent.completed"') || line.includes('"subagent.failed"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const tcid = d.toolCallId || '';
          const agent = agentMap.get(tcid);
          if (agent) {
            agent.completedAt = evt.timestamp || '';
            agent.status = line.includes('failed') ? 'failed' : 'done';
            if (d.model) agent.model = d.model;
            if (agent.startedAt && agent.completedAt) {
              agent.duration = Math.round((new Date(agent.completedAt) - new Date(agent.startedAt)) / 1000);
            }
          }
        } catch {}
        continue;
      }

      // ── tool.execution_start ──
      if (line.includes('"tool.execution_start"')) {
        try {
          const evt = JSON.parse(line);
          const d = evt.data || {};
          const parentId = d.parentToolCallId || '';
          const toolName = d.toolName || '';
          const tcid = d.toolCallId || '';

          if (parentId) {
            // Internal tool call within an agent
            const agent = agentMap.get(parentId);
            if (agent) {
              agent.internalToolCalls++;
              if (toolName) agent.toolBreakdown[toolName] = (agent.toolBreakdown[toolName] || 0) + 1;
            }
            // Sub-agent creation: this agent spawns a child via task tool
            if (toolName === 'task' && tcid) {
              agentParent.set(tcid, parentId);
            }
          } else {
            if (toolName === 'task') {
              // Main session task call → save prompt
              const args = d.arguments || {};
              if (tcid && args.prompt) {
                taskPrompts.set(tcid, (args.prompt || '').substring(0, 1000));
              }
            }
            if (toolName && tcid) {
              // Direct tool call — track timestamp for fallback matching
              const evtTs = evt.timestamp || '';
              if (evtTs) toolTimestamps.set(tcid, evtTs);
            }
            if (toolName && toolName !== 'task' && tcid) {
              // Direct tool call (not task, not inside agent)
              let iid = tcidToIid.get(tcid);
              const evtTs = evt.timestamp || toolTimestamps.get(tcid) || '';
              // Timestamp override: if a newer user message exists, attribute tool to it
              if (evtTs) {
                const tsTurn = findTurnByTs(evtTs);
                const iidTurn = iid ? turnMap.get(iid) : null;
                if (tsTurn && (!iidTurn || tsTurn.timestamp > iidTurn.timestamp)) {
                  iid = tsTurn.interactionId;
                }
              }
              if (!iid) {
                const turn = findTurnByTs(evtTs);
                if (turn) iid = turn.interactionId;
              }
              if (iid) {
                if (!directToolMap.has(iid)) directToolMap.set(iid, new Map());
                const counts = directToolMap.get(iid);
                counts.set(toolName, (counts.get(toolName) || 0) + 1);
              }
            }
          }
        } catch {}
        continue;
      }
    }
  } catch {}

  // ── Post-pass ────────────────────────────────────────────────────────────

  // 1. Apply taskPrompts and interactionIds to agents
  for (const [tcid, agent] of agentMap) {
    const prompt = taskPrompts.get(tcid);
    if (prompt) agent.agentPrompt = prompt;
    if (!agent.interactionId) {
      const iid = tcidToIid.get(tcid);
      if (iid) agent.interactionId = iid;
    }
    // Timestamp-based fallback for agent interactionId
    if (!agent.interactionId && agent.startedAt) {
      const turn = findTurnByTs(agent.startedAt);
      if (turn) agent.interactionId = turn.interactionId;
    }
  }

  // 2. Build agent tree via agentParent
  for (const [childTcid, parentTcid] of agentParent) {
    const parent = agentMap.get(parentTcid);
    const child = agentMap.get(childTcid);
    if (parent && child) {
      parent.children.push(child);
      child._isChild = true;
    }
  }

  // 3. Connect top-level agents to turns (skip children)
  for (const agent of agentMap.values()) {
    if (agent._isChild) continue;
    const iid = tcidToIid.get(agent.toolCallId) || agent.interactionId;
    let turn = turnMap.get(iid);
    // Timestamp override: if a newer user message exists, attribute agent to it
    if (agent.startedAt) {
      const tsTurn = findTurnByTs(agent.startedAt);
      if (tsTurn && (!turn || tsTurn.timestamp > turn.timestamp)) {
        turn = tsTurn;
      }
    }
    if (!turn && agent.startedAt) {
      turn = findTurnByTs(agent.startedAt);
    }
    if (turn) turn.agents.push(agent);
  }

  // 4. Apply directToolCalls to turns
  for (const [iid, toolCounts] of directToolMap) {
    const turn = turnMap.get(iid);
    if (turn) {
      for (const [tn, cnt] of toolCounts) {
        turn.directToolCalls.push({ toolName: tn, count: cnt });
      }
    }
  }

  // 5. Sort by timestamp, paginate (page 1 = most recent)
  const sorted = Array.from(turnMap.values())
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const totalTurns = sorted.length;
  const totalPages = Math.ceil(totalTurns / limit) || 1;
  const safePage = Math.min(page, totalPages);
  const endIdx = totalTurns - ((safePage - 1) * limit);
  const startIdx = Math.max(0, endIdx - limit);
  const result = sorted.slice(startIdx, endIdx);

  // 6. Clean internal fields from agent objects
  const cleanAgent = (a) => ({
    toolCallId: a.toolCallId,
    name: a.name,
    type: a.type,
    status: a.status,
    model: a.model || '',
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    duration: a.duration,
    agentPrompt: (a.agentPrompt || '').substring(0, 1000),
    finalResult: (a.finalResult || '').substring(0, 1000),
    internalToolCalls: a.internalToolCalls,
    internalTurns: a.internalTurns,
    totalOutputTokens: a.totalOutputTokens,
    toolBreakdown: a.toolBreakdown,
    children: (a.children || []).map(cleanAgent),
  });

  for (const turn of result) {
    turn.agents = turn.agents.map(cleanAgent);
  }

  return { timeline: result, page: safePage, totalTurns, totalPages };
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API Routes ──

  // GET /api/config — Return current session path and status
  if (pathname === '/api/config' && req.method === 'GET') {
    const exists = fs.existsSync(SESSION_STATE_DIR);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionStatePath: SESSION_STATE_DIR, exists }));
    return;
  }

  // PUT /api/config — Update session state path
  if (pathname === '/api/config' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { sessionStatePath } = JSON.parse(body);
        if (!sessionStatePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionStatePath is required' }));
          return;
        }
        if (!fs.existsSync(sessionStatePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Path does not exist' }));
          return;
        }
        SESSION_STATE_DIR = sessionStatePath;
        // Clear all caches
        statsCache.clear(); intentCache.clear(); msgCache.clear(); turnsCache.clear();
        scanResultCache.data = null; scanResultCache.ts = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionStatePath: SESSION_STATE_DIR }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/launch-vscode — Open folder in VSCode or VSCode Insiders
  if (pathname === '/api/launch-vscode' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { folder, insiders } = JSON.parse(body);
        if (!folder || !fs.existsSync(folder)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid folder' }));
          return;
        }
        const cmd = insiders === true ? 'code-insiders' : 'code';
        const { execFile } = require('child_process');
        execFile(cmd, [folder], { windowsHide: true, shell: true }, () => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // PUT /api/sessions/:id/description — Update session description
  if (pathname.match(/^\/api\/sessions\/[^/]+\/description$/) && req.method === 'PUT') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    if (!fs.existsSync(sessionDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { description } = JSON.parse(body);
        const metaPath = path.join(sessionDir, 'lens-meta.json');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
        meta.description = (description || '').substring(0, 500);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // GET /api/sessions — List all sessions
  if (pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = scanSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/sessions/:id/agents — Enhanced subagent detail list
  if (pathname.match(/^\/api\/sessions\/[^/]+\/agents$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const { agents } = parseAgentData(eventsFile);
    // Build response — strip internal fields
    const agentList = agents.map(a => ({
      toolCallId: a.toolCallId,
      name: a.name,
      type: a.type,
      description: a.description,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      status: a.status,
      result: a.result,
      agentPrompt: a.agentPrompt.substring(0, 2000),
      internalToolCalls: a.internalToolCalls,
      internalTurns: a.internalTurns,
      totalOutputTokens: a.totalOutputTokens,
      toolBreakdown: a.toolBreakdown,
      finalResult: a.finalResult.substring(0, 2000),
    }));
    const summary = {};
    for (const a of agentList) {
      summary[a.name] = (summary[a.name] || 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: agentList, summary, total: agentList.length }));
    return;
  }

  // GET /api/sessions/:id/turns — Paginated conversation turns
  if (pathname.match(/^\/api\/sessions\/[^/]+\/turns$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 15));

    // Use cache if file hasn't changed
    const stat = fs.statSync(eventsFile);
    const cached = turnsCache.get(id);
    let allTurns;
    if (cached && cached.fileSize === stat.size) {
      allTurns = cached.turns;
    } else {
      allTurns = [];
      try {
        const content = fs.readFileSync(eventsFile, 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim() || !line.includes('"user.message"')) continue;
          try {
            const evt = JSON.parse(line);
            let msg = (evt.data || {}).content || '';
            msg = msg.replace(/^(<[^>]+>.*?<\/[^>]+>\s*)+/s, '').trim();
            if (msg) allTurns.push({ type: 'user', content: msg.substring(0, 500), timestamp: evt.timestamp });
          } catch {}
        }
      } catch {}
      turnsCache.set(id, { fileSize: stat.size, turns: allTurns });
    }

    const totalTurns = allTurns.length;
    const totalPages = Math.ceil(totalTurns / pageSize) || 1;
    const safePage = Math.min(page, totalPages);
    // Page 1 = most recent, Page N = oldest
    const endIdx = totalTurns - ((safePage - 1) * pageSize);
    const startIdx = Math.max(0, endIdx - pageSize);
    const pageTurns = allTurns.slice(startIdx, endIdx);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ turns: pageTurns, page: safePage, pageSize, totalTurns, totalPages }));
    return;
  }

  // GET /api/sessions/:id/timeline — Hierarchical timeline view
  if (pathname.match(/^\/api\/sessions\/[^/]+\/timeline$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const page = parseInt(url.searchParams.get('page')) || 1;
    const result = buildTimeline(eventsFile, limit, page);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/sessions/:id/turn-agents — Agents grouped by conversation turn
  if (pathname.match(/^\/api\/sessions\/[^/]+\/turn-agents$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const { agents, turnMap } = parseAgentData(eventsFile);
    // Link agents to turns via interactionId
    for (const agent of agents) {
      if (!agent.interactionId) continue;
      const turn = turnMap.get(agent.interactionId);
      if (!turn) continue;
      const duration = (agent.startedAt && agent.completedAt)
        ? Math.round((new Date(agent.completedAt) - new Date(agent.startedAt)) / 1000)
        : 0;
      turn.agents.push({
        toolCallId: agent.toolCallId,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        duration,
        internalToolCalls: agent.internalToolCalls,
        internalTurns: agent.internalTurns,
        totalOutputTokens: agent.totalOutputTokens,
        toolBreakdown: agent.toolBreakdown,
        agentPrompt: agent.agentPrompt.substring(0, 500),
        finalResult: agent.finalResult.substring(0, 500),
      });
    }
    // Only include turns that have at least one agent
    const turns = [];
    for (const [, turn] of turnMap) {
      if (turn.agents.length > 0) turns.push(turn);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ turns }));
    return;
  }

  // GET /api/sessions/:id/tool-calls — Tool call input/output detail
  if (pathname.match(/^\/api\/sessions\/[^/]+\/tool-calls$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const sessionDir = path.join(SESSION_STATE_DIR, id);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const turnIndexParam = url.searchParams.get('turnIndex');
    const turnIndexFilter = turnIndexParam !== null ? parseInt(turnIndexParam, 10) : null;
    const toolNameFilter = url.searchParams.get('toolName') || '';
    const iidFilter = url.searchParams.get('interactionId') || '';
    const parentFilter = url.searchParams.get('parentToolCallId') || '';
    const toolCalls = getToolCalls(eventsFile, turnIndexFilter, toolNameFilter, iidFilter, parentFilter);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ toolCalls }));
    return;
  }

  // GET /api/sessions/:id/project-config — Project Copilot configuration
  if (pathname.match(/^\/api\/sessions\/[^/]+\/project-config$/) && req.method === 'GET') {
    const id = pathname.split('/')[3];
    const config = getProjectConfig(id);
    if (!config) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
    const id = pathname.slice('/api/sessions/'.length);
    const detail = getSessionDetail(id);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
    return;
  }

  // ── Static Files ──
  const publicDir = path.resolve(__dirname, '..', 'public');
  let filePath = pathname === '/' ? '/index-v2.html' : pathname === '/v1' ? '/index.html' : pathname;
  filePath = path.resolve(publicDir, filePath.replace(/^\//, ''));

  // Path traversal guard
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ── Server Startup ─────────────────────────────────────────────────────────

function startServer(port) {
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(port || 0, () => {
      const actualPort = srv.address().port;
      console.log(`\n  🤖 GitHub Copilot Lens`);
      console.log(`  http://localhost:${actualPort}`);
      console.log(`  Session state: ${SESSION_STATE_DIR}\n`);
      resolve({ server: srv, port: actualPort });
    });
  });
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = { startServer };
