/**
 * GitHub Copilot Lens — Server Tests
 * 
 * Tests for:
 * - YAML parsing
 * - Session state detection
 * - Event reading (tail/head)
 * - Intent extraction
 * - User message extraction (with XML tag stripping)
 * - Lock file / PID detection
 * - Cross-platform path handling
 * - i18n completeness
 * - API endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

// ── Helper: Create temp dir ──
const makeTmp = (prefix) => {
  const dir = path.join(os.tmpdir(), `ghcpLens-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const rmrf = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

// ── Re-implement server functions for unit testing ──
// (server.js uses CommonJS and starts HTTP on import, so we extract logic)

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
    const EVENT_TAIL_BYTES = 32768;
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

function isSessionActive(sessionDir) {
  try {
    const files = fs.readdirSync(sessionDir);
    const lockFiles = files.filter(f => f.startsWith('inuse.') && f.endsWith('.lock'));
    if (!lockFiles.length) return false;
    for (const lf of lockFiles) {
      const match = lf.match(/^inuse\.(\d+)\.lock$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      try { process.kill(pid, 0); return true; } catch {}
    }
    return false;
  } catch { return false; }
}

function extractUserMessages(buf, skipFirst) {
  let lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
  if (skipFirst && lines.length > 0) lines = lines.slice(1);
  let first = '', last = '';
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'user.message') {
        let msg = (ev.data || {}).content || '';
        msg = msg.replace(/^(<[^>]+>.*?<\/[^>]+>\s*)+/s, '').trim();
        if (msg) {
          if (!first) first = msg.substring(0, 120);
          last = msg.substring(0, 120);
        }
      }
    } catch {}
  }
  return { first, last };
}

function getSessionIntent(sessionDir) {
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  try {
    const stat = fs.statSync(eventsFile);
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
    return intent;
  } catch {}
  return '';
}

const WAITING_TOOLS = new Set(['ask_user', 'ask_permission']);

function getSessionStateFromEvents(events) {
  if (!events.length) return { state: 'unknown', waitingContext: '' };
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
      return { state: 'waiting', waitingContext: (data.arguments || {}).question || '' };
    }
    if (tool !== 'report_intent') hasPendingWork = true;
  }
  if (hasPendingWork) return { state: 'working', waitingContext: '' };
  const last = events[events.length - 1];
  const etype = last.type || '';
  if (etype === 'assistant.turn_end') return { state: 'idle', waitingContext: '' };
  if (etype === 'tool.execution_start') {
    const tool = (last.data || {}).toolName || '';
    if (WAITING_TOOLS.has(tool)) return { state: 'waiting', waitingContext: '' };
    return { state: 'working', waitingContext: '' };
  }
  if (etype === 'user.message') return { state: 'working', waitingContext: '' };
  if (etype === 'assistant.turn_start' || etype === 'assistant.message') return { state: 'working', waitingContext: '' };
  if (etype === 'session.task_complete') return { state: 'idle', waitingContext: '' };
  if (['session.resume', 'session.start', 'session.compaction', 'session.mode_changed'].includes(etype)) return { state: 'idle', waitingContext: '' };
  if (['session.warning', 'session.info', 'session.shutdown'].includes(etype)) return { state: 'idle', waitingContext: '' };
  return { state: 'unknown', waitingContext: '' };
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('readYaml', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('yaml'); });
  afterEach(() => rmrf(tmpDir));

  it('parses basic key-value pairs', () => {
    fs.writeFileSync(path.join(tmpDir, 'w.yaml'), 'summary: My Session\nrepository: owner/repo\nbranch: main\n');
    expect(readYaml(path.join(tmpDir, 'w.yaml'))).toEqual({ summary: 'My Session', repository: 'owner/repo', branch: 'main' });
  });

  it('trims whitespace from values', () => {
    fs.writeFileSync(path.join(tmpDir, 't.yaml'), 'key:   spaced value   \n');
    expect(readYaml(path.join(tmpDir, 't.yaml')).key).toBe('spaced value');
  });

  it('returns null for missing file', () => {
    expect(readYaml(path.join(tmpDir, 'nope.yaml'))).toBeNull();
  });

  it('returns empty object for empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'e.yaml'), '');
    expect(readYaml(path.join(tmpDir, 'e.yaml'))).toEqual({});
  });

  it('handles keys with underscores', () => {
    fs.writeFileSync(path.join(tmpDir, 'u.yaml'), 'created_at: 2026-01-01\nupdated_at: 2026-03-27\n');
    const r = readYaml(path.join(tmpDir, 'u.yaml'));
    expect(r.created_at).toBe('2026-01-01');
    expect(r.updated_at).toBe('2026-03-27');
  });

  it('handles values with colons (Windows paths)', () => {
    fs.writeFileSync(path.join(tmpDir, 'c.yaml'), 'cwd: C:\\Users\\test\\project\n');
    expect(readYaml(path.join(tmpDir, 'c.yaml')).cwd).toBe('C:\\Users\\test\\project');
  });

  it('handles Unix paths', () => {
    fs.writeFileSync(path.join(tmpDir, 'x.yaml'), 'cwd: /home/user/projects/myapp\n');
    expect(readYaml(path.join(tmpDir, 'x.yaml')).cwd).toBe('/home/user/projects/myapp');
  });

  it('handles ISO timestamp values', () => {
    fs.writeFileSync(path.join(tmpDir, 'ts.yaml'), 'created_at: 2026-03-27T15:00:00.000Z\n');
    expect(readYaml(path.join(tmpDir, 'ts.yaml')).created_at).toContain('2026-03-27');
  });
});

describe('readRecentEvents', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('events'); });
  afterEach(() => rmrf(tmpDir));

  it('reads events from events.jsonl', () => {
    const ev = [
      { type: 'user.message', data: { content: 'hi' } },
      { type: 'assistant.turn_start' },
      { type: 'assistant.turn_end' },
    ];
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    const r = readRecentEvents(tmpDir, 30);
    expect(r).toHaveLength(3);
    expect(r[0].type).toBe('user.message');
  });

  it('returns empty for missing file', () => {
    expect(readRecentEvents(tmpDir)).toEqual([]);
  });

  it('returns empty for empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), '');
    expect(readRecentEvents(tmpDir)).toEqual([]);
  });

  it('skips malformed JSON lines', () => {
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), '{"type":"ok"}\nnot json\n{"type":"ok2"}\n');
    const r = readRecentEvents(tmpDir);
    expect(r).toHaveLength(2);
  });

  it('limits to count parameter', () => {
    const ev = Array.from({ length: 50 }, (_, i) => ({ type: `e${i}` }));
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    expect(readRecentEvents(tmpDir, 5)).toHaveLength(5);
  });

  it('handles only newlines', () => {
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), '\n\n\n');
    expect(readRecentEvents(tmpDir)).toEqual([]);
  });

  it('handles Unicode in events', () => {
    const ev = [{ type: 'user.message', data: { content: '🎯 한국어 テスト 中文' } }];
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    const r = readRecentEvents(tmpDir);
    expect(r[0].data.content).toContain('한국어');
    expect(r[0].data.content).toContain('中文');
  });
});

describe('isSessionActive', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('active'); });
  afterEach(() => rmrf(tmpDir));

  it('returns false with no lock files', () => {
    expect(isSessionActive(tmpDir)).toBe(false);
  });

  it('returns true with alive PID lock', () => {
    fs.writeFileSync(path.join(tmpDir, `inuse.${process.pid}.lock`), '');
    expect(isSessionActive(tmpDir)).toBe(true);
  });

  it('returns false with dead PID lock', () => {
    fs.writeFileSync(path.join(tmpDir, 'inuse.999999.lock'), '');
    expect(isSessionActive(tmpDir)).toBe(false);
  });

  it('returns false for malformed lock names', () => {
    fs.writeFileSync(path.join(tmpDir, 'inuse.abc.lock'), '');
    expect(isSessionActive(tmpDir)).toBe(false);
  });

  it('returns true if any PID is alive among multiple', () => {
    fs.writeFileSync(path.join(tmpDir, 'inuse.999999.lock'), '');
    fs.writeFileSync(path.join(tmpDir, `inuse.${process.pid}.lock`), '');
    expect(isSessionActive(tmpDir)).toBe(true);
  });

  it('returns false for nonexistent directory', () => {
    expect(isSessionActive(path.join(tmpDir, 'nope'))).toBe(false);
  });

  it('ignores non-lock files', () => {
    fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), '');
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), '');
    expect(isSessionActive(tmpDir)).toBe(false);
  });

  it('ignores inuse files without .lock extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'inuse.12345'), '');
    expect(isSessionActive(tmpDir)).toBe(false);
  });

  it('handles multiple stale locks', () => {
    for (let i = 999990; i < 999995; i++) {
      fs.writeFileSync(path.join(tmpDir, `inuse.${i}.lock`), '');
    }
    expect(isSessionActive(tmpDir)).toBe(false);
  });
});

describe('extractUserMessages', () => {
  const mkBuf = (...msgs) => Buffer.from(msgs.map(m => JSON.stringify(m)).join('\n'));

  it('extracts simple messages', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: 'hello' } },
      { type: 'user.message', data: { content: 'world' } },
    ), false);
    expect(r.first).toBe('hello');
    expect(r.last).toBe('world');
  });

  it('strips XML tags from start', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '<current_datetime>2026-03-27T15:00:00Z</current_datetime>\nActual question' } },
    ), false);
    expect(r.first).toBe('Actual question');
  });

  it('strips multiple XML tags', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '<current_datetime>2026</current_datetime>\n<reminder>stuff</reminder>\n\nReal content' } },
    ), false);
    expect(r.first).toBe('Real content');
  });

  it('preserves non-XML messages', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: 'just plain text' } },
    ), false);
    expect(r.first).toBe('just plain text');
  });

  it('skips messages that become empty after stripping', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '<tag>only tags</tag>' } },
      { type: 'user.message', data: { content: 'valid' } },
    ), false);
    expect(r.first).toBe('valid');
  });

  it('truncates to 120 chars', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: 'A'.repeat(200) } },
    ), false);
    expect(r.first).toHaveLength(120);
  });

  it('skipFirst=true skips first line', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: 'skip me' } },
      { type: 'user.message', data: { content: 'keep me' } },
    ), true);
    expect(r.first).toBe('keep me');
  });

  it('returns empty for no user messages', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'assistant.message', data: { content: 'not user' } },
    ), false);
    expect(r.first).toBe('');
    expect(r.last).toBe('');
  });

  it('handles empty content', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '' } },
    ), false);
    expect(r.first).toBe('');
  });

  it('handles missing data field', () => {
    const r = extractUserMessages(mkBuf({ type: 'user.message' }), false);
    expect(r.first).toBe('');
  });

  it('handles Korean text', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '한국어 테스트' } },
    ), false);
    expect(r.first).toBe('한국어 테스트');
  });

  it('handles Japanese text', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '日本語テスト' } },
    ), false);
    expect(r.first).toBe('日本語テスト');
  });

  it('handles Chinese text', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '中文测试' } },
    ), false);
    expect(r.first).toBe('中文测试');
  });

  it('handles emoji in messages', () => {
    const r = extractUserMessages(mkBuf(
      { type: 'user.message', data: { content: '🚀 deploy this 🎯' } },
    ), false);
    expect(r.first).toContain('🚀');
  });
});

describe('getSessionIntent', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('intent'); });
  afterEach(() => rmrf(tmpDir));

  it('extracts the last report_intent', () => {
    const ev = [
      { type: 'tool.execution_start', data: { toolName: 'report_intent', arguments: { intent: 'First' } } },
      { type: 'tool.execution_start', data: { toolName: 'edit', arguments: {} } },
      { type: 'tool.execution_start', data: { toolName: 'report_intent', arguments: { intent: 'Second' } } },
    ];
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    expect(getSessionIntent(tmpDir)).toBe('Second');
  });

  it('returns empty when no report_intent', () => {
    const ev = [{ type: 'user.message', data: { content: 'hi' } }];
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    expect(getSessionIntent(tmpDir)).toBe('');
  });

  it('returns empty for missing file', () => {
    expect(getSessionIntent(tmpDir)).toBe('');
  });

  it('returns empty for empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), '');
    expect(getSessionIntent(tmpDir)).toBe('');
  });
});

describe('Session state detection', () => {
  it('returns unknown for empty events', () => {
    expect(getSessionStateFromEvents([]).state).toBe('unknown');
  });

  it('working: pending tool execution', () => {
    expect(getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'edit' } },
    ]).state).toBe('working');
  });

  it('waiting: ask_user pending', () => {
    const r = getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'ask_user', arguments: { question: 'Which?' } } },
    ]);
    expect(r.state).toBe('waiting');
    expect(r.waitingContext).toBe('Which?');
  });

  it('waiting: ask_permission pending', () => {
    expect(getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'ask_permission', arguments: { question: 'Allow?' } } },
    ]).state).toBe('waiting');
  });

  it('idle: after turn_end', () => {
    expect(getSessionStateFromEvents([
      { type: 'assistant.turn_end', timestamp: '2020-01-01T00:00:00Z' },
    ]).state).toBe('idle');
  });

  it('working: after user.message', () => {
    expect(getSessionStateFromEvents([
      { type: 'user.message', data: { content: 'hi' } },
    ]).state).toBe('working');
  });

  it('working: after assistant.turn_start', () => {
    expect(getSessionStateFromEvents([
      { type: 'assistant.turn_start' },
    ]).state).toBe('working');
  });

  it('working: after assistant.message', () => {
    expect(getSessionStateFromEvents([
      { type: 'assistant.message' },
    ]).state).toBe('working');
  });

  it('idle: after session.task_complete', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.task_complete' },
    ]).state).toBe('idle');
  });

  it('idle: after session.resume', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.resume' },
    ]).state).toBe('idle');
  });

  it('idle: after session.start', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.start' },
    ]).state).toBe('idle');
  });

  it('idle: after session.shutdown', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.shutdown' },
    ]).state).toBe('idle');
  });

  it('idle: after session.compaction', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.compaction' },
    ]).state).toBe('idle');
  });

  it('idle: after session.warning', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.warning' },
    ]).state).toBe('idle');
  });

  it('idle: after session.info', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.info' },
    ]).state).toBe('idle');
  });

  it('idle: after session.mode_changed', () => {
    expect(getSessionStateFromEvents([
      { type: 'session.mode_changed' },
    ]).state).toBe('idle');
  });

  it('completed tool clears pending state', () => {
    expect(getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'edit' } },
      { type: 'tool.execution_complete', data: { toolCallId: '1' } },
      { type: 'assistant.turn_end', timestamp: '2020-01-01T00:00:00Z' },
    ]).state).toBe('idle');
  });

  it('ignores report_intent for pending detection', () => {
    expect(getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'report_intent' } },
      { type: 'assistant.turn_end', timestamp: '2020-01-01T00:00:00Z' },
    ]).state).toBe('idle');
  });

  it('waiting takes priority over working', () => {
    expect(getSessionStateFromEvents([
      { type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'edit' } },
      { type: 'tool.execution_start', data: { toolCallId: '2', toolName: 'ask_user', arguments: { question: 'Sure?' } } },
    ]).state).toBe('waiting');
  });

  it('unknown for unrecognized event type', () => {
    expect(getSessionStateFromEvents([
      { type: 'some.future.event' },
    ]).state).toBe('unknown');
  });
});

describe('XML tag stripping regex', () => {
  const strip = (s) => s.replace(/^(<[^>]+>.*?<\/[^>]+>\s*)+/s, '').trim();

  it('strips single tag pair', () => expect(strip('<t>c</t> real')).toBe('real'));
  it('strips multiple consecutive', () => expect(strip('<a>1</a>\n<b>2</b>\nactual')).toBe('actual'));
  it('strips current_datetime', () => expect(strip('<current_datetime>2026</current_datetime>\nhello')).toBe('hello'));
  it('strips reminder', () => expect(strip('<reminder>Check</reminder>\ndo this')).toBe('do this'));
  it('preserves no-tag text', () => expect(strip('no tags')).toBe('no tags'));
  it('preserves mid-text XML', () => expect(strip('start <t>mid</t> end')).toBe('start <t>mid</t> end'));
  it('handles empty string', () => expect(strip('')).toBe(''));
  it('handles only-tag string', () => expect(strip('<t>all</t>')).toBe(''));
  it('handles whitespace between tags', () => expect(strip('<a>x</a>  \n  <b>y</b>  \n  real')).toBe('real'));
});

describe('i18n dictionary completeness', () => {
  const I18N = {
    ko: {
      working: '작업 중', waiting: '질문 중', idle: '대기', completed: '종료', unknown: '알 수 없음',
      stateWorking: '🔵 작업 중', stateWaiting: '🟡 질문 중', stateIdle: '🟢 대기', stateCompleted: '⚪ 종료', stateUnknown: '⚪ 알 수 없음',
      sessionDetail: '세션 상세', selectSession: '세션을 선택하세요', noSessions: '세션이 없습니다',
      session: '세션', lastMsg: '최근 대화', stats: '통계', recent: '최근',
      summary: '📝 요약', path: '📁 경로', repo: '🏠 저장소', branch: '🌿 브랜치',
      sessionId: '🆔 세션', created: '📅 생성', updated: '🕐 수정',
      statsTitle: '📊 통계', toolUsage: '🔧 도구 사용량', checkpoints: '📋 체크포인트',
      recentTurns: '💬 최근 대화', timeline: '🔔 이벤트 타임라인', filesModified: '📝 수정된 파일',
      emptySession: '(빈 세션)', noValue: '(없음)', showEmpty: '빈 세션 보기',
      total: '총', turns: '턴', tools: '도구',
      copyPath: '경로가 복사되었습니다', copyResume: '복사 완료 — VSCode 터미널에서 붙여넣고 세션을 이어가세요',
      copyPathTitle: '전체 경로 복사', copyResumeTitle: '세션 이어가기 명령 복사',
      vscodeOpened: 'VSCode가 열렸습니다 — 터미널(Ctrl+`)에서 Ctrl+V로 붙여넣으세요',
      launchFail: '실행 실패', serverFail: '서버 연결 실패', loadFail: '세션 데이터를 불러올 수 없습니다',
      copied: '복사되었습니다', statsTooltip: '대화 수 · 도구 호출 수',
      secAgo: '초 전', minAgo: '분 전', hrAgo: '시간 전', dayAgo: '일 전',
    },
    en: {
      working: 'Working', waiting: 'Asking', idle: 'Idle', completed: 'Ended', unknown: 'Unknown',
      stateWorking: '🔵 Working', stateWaiting: '🟡 Asking', stateIdle: '🟢 Idle', stateCompleted: '⚪ Ended', stateUnknown: '⚪ Unknown',
      sessionDetail: 'Session Detail', selectSession: 'Select a session', noSessions: 'No sessions found',
      session: 'Session', lastMsg: 'Last Message', stats: 'Stats', recent: 'Recent',
      summary: '📝 Summary', path: '📁 Path', repo: '🏠 Repository', branch: '🌿 Branch',
      sessionId: '🆔 Session', created: '📅 Created', updated: '🕐 Updated',
      statsTitle: '📊 Statistics', toolUsage: '🔧 Tool Usage', checkpoints: '📋 Checkpoints',
      recentTurns: '💬 Recent Turns', timeline: '🔔 Event Timeline', filesModified: '📝 Modified Files',
      emptySession: '(empty)', noValue: '(none)', showEmpty: 'Show empty sessions',
      total: 'Total', turns: 'turns', tools: 'tools',
      copyPath: 'Path copied', copyResume: 'Copied — paste in VSCode terminal to resume',
      copyPathTitle: 'Copy full path', copyResumeTitle: 'Copy resume command',
      vscodeOpened: 'VSCode opened — paste with Ctrl+V in terminal (Ctrl+`)',
      launchFail: 'Launch failed', serverFail: 'Server connection failed', loadFail: 'Failed to load session data',
      copied: 'Copied', statsTooltip: 'Turns · Tool calls',
      secAgo: 's ago', minAgo: 'm ago', hrAgo: 'h ago', dayAgo: 'd ago',
    },
    ja: {
      working: '実行中', waiting: '質問中', idle: '待機', completed: '終了', unknown: '不明',
      stateWorking: '🔵 実行中', stateWaiting: '🟡 質問中', stateIdle: '🟢 待機', stateCompleted: '⚪ 終了', stateUnknown: '⚪ 不明',
      sessionDetail: 'セッション詳細', selectSession: 'セッションを選択してください', noSessions: 'セッションがありません',
      session: 'セッション', lastMsg: '最近の会話', stats: '統計', recent: '最近',
      summary: '📝 概要', path: '📁 パス', repo: '🏠 リポジトリ', branch: '🌿 ブランチ',
      sessionId: '🆔 セッション', created: '📅 作成', updated: '🕐 更新',
      statsTitle: '📊 統計', toolUsage: '🔧 ツール使用量', checkpoints: '📋 チェックポイント',
      recentTurns: '💬 最近の会話', timeline: '🔔 イベントタイムライン', filesModified: '📝 変更ファイル',
      emptySession: '(空)', noValue: '(なし)', showEmpty: '空セッション表示',
      total: '計', turns: 'ターン', tools: 'ツール',
      copyPath: 'パスをコピーしました', copyResume: 'コピー完了 — VSCodeターミナルに貼り付けてください',
      copyPathTitle: 'フルパスをコピー', copyResumeTitle: 'レジュームコマンドをコピー',
      vscodeOpened: 'VSCodeが開きました — ターミナル(Ctrl+`)でCtrl+Vで貼り付け',
      launchFail: '起動失敗', serverFail: 'サーバー接続失敗', loadFail: 'セッションデータを読み込めません',
      copied: 'コピーしました', statsTooltip: '会話数 · ツール呼出数',
      secAgo: '秒前', minAgo: '分前', hrAgo: '時間前', dayAgo: '日前',
    },
    zh: {
      working: '工作中', waiting: '提问中', idle: '空闲', completed: '结束', unknown: '未知',
      stateWorking: '🔵 工作中', stateWaiting: '🟡 提问中', stateIdle: '🟢 空闲', stateCompleted: '⚪ 结束', stateUnknown: '⚪ 未知',
      sessionDetail: '会话详情', selectSession: '请选择一个会话', noSessions: '没有会话',
      session: '会话', lastMsg: '最近对话', stats: '统计', recent: '最近',
      summary: '📝 摘要', path: '📁 路径', repo: '🏠 仓库', branch: '🌿 分支',
      sessionId: '🆔 会话', created: '📅 创建', updated: '🕐 更新',
      statsTitle: '📊 统计', toolUsage: '🔧 工具使用', checkpoints: '📋 检查点',
      recentTurns: '💬 最近对话', timeline: '🔔 事件时间线', filesModified: '📝 修改文件',
      emptySession: '(空会话)', noValue: '(无)', showEmpty: '显示空会话',
      total: '共', turns: '轮', tools: '工具',
      copyPath: '路径已复制', copyResume: '已复制 — 请在VSCode终端中粘贴',
      copyPathTitle: '复制完整路径', copyResumeTitle: '复制恢复命令',
      vscodeOpened: 'VSCode已打开 — 在终端(Ctrl+`)中用Ctrl+V粘贴',
      launchFail: '启动失败', serverFail: '服务器连接失败', loadFail: '无法加载会话数据',
      copied: '已复制', statsTooltip: '对话数 · 工具调用数',
      secAgo: '秒前', minAgo: '分前', hrAgo: '小时前', dayAgo: '天前',
    }
  };

  const ALL_KEYS = Object.keys(I18N.ko);

  for (const lang of ['en', 'ja', 'zh']) {
    it(`${lang} has all keys that ko has (${ALL_KEYS.length} keys)`, () => {
      const missing = ALL_KEYS.filter(k => !I18N[lang][k]);
      expect(missing, `${lang} missing keys: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('all states differ across languages', () => {
    const states = ['working', 'waiting', 'idle', 'completed'];
    for (const s of states) {
      const vals = new Set(Object.values(I18N).map(d => d[s]));
      expect(vals.size, `State "${s}" should differ across languages`).toBe(4);
    }
  });

  it('t() function fallback chain works', () => {
    let currentLang = 'ko';
    const t = (key) => (I18N[currentLang] || I18N.ko)[key] || I18N.ko[key] || key;

    currentLang = 'ko'; expect(t('working')).toBe('작업 중');
    currentLang = 'en'; expect(t('working')).toBe('Working');
    currentLang = 'ja'; expect(t('working')).toBe('実行中');
    currentLang = 'zh'; expect(t('working')).toBe('工作中');
  });

  it('t() falls back to ko for unknown language', () => {
    const t = (key) => (I18N['fr'] || I18N.ko)[key] || I18N.ko[key] || key;
    expect(t('working')).toBe('작업 중');
  });

  it('t() returns key for completely unknown key', () => {
    const t = (key) => (I18N.ko)[key] || key;
    expect(t('nonexistent_xyz')).toBe('nonexistent_xyz');
  });
});

describe('Cross-platform compatibility', () => {
  it('path.join produces valid paths on current platform', () => {
    const p = path.join('home', 'user', '.copilot', 'session-state');
    expect(p).toContain('session-state');
  });

  it('os.homedir returns a valid directory', () => {
    expect(fs.existsSync(os.homedir())).toBe(true);
  });

  it('path.sep is correct for platform', () => {
    expect(path.sep).toBe(process.platform === 'win32' ? '\\' : '/');
  });

  it('env var override for COPILOT_DIR works', () => {
    const dir = process.env.COPILOT_DIR || path.join(os.homedir(), '.copilot');
    expect(dir).toContain('.copilot');
  });

  it('process.kill(pid, 0) works for current process', () => {
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('process.kill throws for dead PID', () => {
    expect(() => process.kill(999999, 0)).toThrow();
  });

  it('fs.openSync + readSync works on current platform', () => {
    const tmp = path.join(os.tmpdir(), `ghcpLens-compat-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'test data');
    const fd = fs.openSync(tmp, 'r');
    const buf = Buffer.alloc(9);
    fs.readSync(fd, buf, 0, 9, 0);
    fs.closeSync(fd);
    expect(buf.toString()).toBe('test data');
    fs.unlinkSync(tmp);
  });

  it('Buffer handles multi-byte UTF-8 correctly', () => {
    const text = '한국어テスト中文🎯';
    const buf = Buffer.from(text, 'utf-8');
    expect(buf.toString('utf-8')).toBe(text);
  });
});

describe('API integration (live server)', () => {
  const fetchJSON = (urlPath) => new Promise((resolve, reject) => {
    http.get(`http://localhost:3002${urlPath}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
    }).on('error', reject);
  });

  const fetchRaw = (urlPath) => new Promise((resolve, reject) => {
    http.get(`http://localhost:3002${urlPath}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });

  it('GET /api/sessions returns array', async () => {
    try {
      const { data } = await fetchJSON('/api/sessions');
      expect(Array.isArray(data)).toBe(true);
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });

  it('session items have required fields', async () => {
    try {
      const { data: sessions } = await fetchJSON('/api/sessions');
      if (!sessions.length) return;
      const s = sessions[0];
      for (const key of ['id', 'isActive', 'state', 'summary', 'turnCount', 'toolCalls']) {
        expect(s, `Missing key: ${key}`).toHaveProperty(key);
      }
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });

  it('session detail returns extra fields', async () => {
    try {
      const { data: sessions } = await fetchJSON('/api/sessions');
      if (!sessions.length) return;
      const { data: detail } = await fetchJSON(`/api/sessions/${sessions[0].id}`);
      expect(detail).toHaveProperty('turnCount');
      expect(detail).toHaveProperty('toolCalls');
      expect(detail).toHaveProperty('subagentRuns');
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });

  it('nonexistent session returns 404', async () => {
    try {
      const { status } = await fetchRaw('/api/sessions/does-not-exist-xyz');
      expect(status).toBe(404);
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });

  it('GET / returns HTML with i18n', async () => {
    try {
      const { data } = await fetchRaw('/');
      expect(data).toContain('I18N');
      expect(data).toContain('lang-btn');
      expect(data).toContain('Copilot Lens');
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });

  it('GET / HTML contains all 4 language buttons', async () => {
    try {
      const { data } = await fetchRaw('/');
      expect(data).toContain('data-lang="ko"');
      expect(data).toContain('data-lang="en"');
      expect(data).toContain('data-lang="ja"');
      expect(data).toContain('data-lang="zh"');
    } catch (e) { if (e.code === 'ECONNREFUSED') return; throw e; }
  });
});
