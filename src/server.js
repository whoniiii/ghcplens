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
  if (etype === 'session.compaction' || etype === 'session.mode_changed') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.resume' || etype === 'session.start') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };
  if (etype === 'session.warning' || etype === 'session.info' || etype === 'session.shutdown') return { state: 'idle', waitingContext: '', bgTasks, bgTaskList };

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

    // Verify at least one lock PID is actually alive
    for (const lf of lockFiles) {
      const match = lf.match(/^inuse\.(\d+)\.lock$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      try {
        process.kill(pid, 0); // signal 0 = check if alive, doesn't kill
        return true;
      } catch {}
    }
    return false; // all lock PIDs are dead — stale locks
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
              userMessage: (d.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 500),
              assistantMessage: '',
              directToolCalls: [],
              targetAgent,
              agents: [],
            });
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
            if (iid) {
              const turn = turnMap.get(iid);
              if (turn) {
                const c = d.content || '';
                if (c) turn.assistantMessage = c.substring(0, 500);
              }
              // Map toolRequests toolCallIds → interactionId
              if (Array.isArray(d.toolRequests)) {
                for (const tr of d.toolRequests) {
                  if (tr.toolCallId) tcidToIid.set(tr.toolCallId, iid);
                }
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
            } else if (toolName && tcid) {
              // Direct tool call (not task, not inside agent)
              const iid = tcidToIid.get(tcid);
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
    const turn = turnMap.get(iid);
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
        const cmd = insiders ? 'code-insiders' : 'code';
        const { exec } = require('child_process');
        exec(`${cmd} "${folder}"`, { windowsHide: true }, () => {});
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
  let filePath = pathname === '/' ? '/index.html' : pathname === '/v2' ? '/index-v2.html' : pathname;
  filePath = path.join(__dirname, '..', 'public', filePath);

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
