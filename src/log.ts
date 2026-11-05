import fs from 'fs';
import path from 'path';

// Inlined to avoid an import cycle: log.ts <- config.ts <- env.ts <- log.ts.
// config.ts derives GROUPS_DIR as `path.resolve(PROJECT_ROOT, 'groups')` where
// PROJECT_ROOT is `process.cwd()` — same value, no cycle.
const HARNESS_GROUPS_DIR = (): string => path.resolve(process.cwd(), 'groups');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

// JSONL trace sink. When a log call carries `trace` in its data
// ({ trace_id, agent_folder, event? }), an event line is also appended
// to <GROUPS_DIR>/<agent_folder>/Traces/YYYY-MM-DD/<trace_id>.jsonl.
// Plaintext stdout/stderr emission is unchanged. Per TracingPlan.md
// event shape: trace_id, timestamp, agent (folder), node_id, event, metadata.
//
// Per-invocation tracing (TracingPlan.md "One trace = one invocation"):
// trace_id is the inbound Discord message id, not the session id.
// router.ts records inbound→session via recordInboundForSession; delivery.ts
// looks up the most-recent inbound's id with traceIdForSession.
export interface TraceContext {
  trace_id: string;
  agent_folder: string;
  event?: string;
  node_id?: string;
  related_node_id?: string | null;
  summary?: string;
}

const sessionLastInbound = new Map<string, string>();
export function recordInboundForSession(sessionId: string, inboundMsgId: string): void {
  sessionLastInbound.set(sessionId, inboundMsgId);
}
export function traceIdForSession(sessionId: string): string | undefined {
  return sessionLastInbound.get(sessionId);
}

/**
 * Map an agent group folder to the MindGraph node that represents the agent's
 * entry/exit point. Default convention: node_id = the agent's Soul.md
 * (`<folder>:soul`). Add per-folder overrides here as you create agents whose
 * scope name differs from their group folder name.
 *
 * Used by router (entry) and delivery (exit) so a trace's first and last
 * events land on the same canonical node.
 */
export function entryNodeForAgentFolder(folder: string): string {
  // Per-agent overrides go here. Example:
  //   if (folder === 'myagent') return 'myagent:soul';
  return `${folder}:claude.local`;
}

/**
 * MindGraph scope (the prefix before the colon in node_ids) for an agent
 * group folder. The container's PreToolUse hook reads this to compose
 * intermediate-event node_ids like `<scope>:goal`, `<scope>:protocols`.
 *
 * Default: scope = folder name. Override per-folder if your scope name differs.
 */
export function traceScopeForAgentFolder(folder: string): string {
  // Per-agent overrides go here. Example:
  //   if (folder === 'myagent-folder') return 'myagent-scope';
  return folder;
}

/**
 * Per-invocation sentinels read by the container's PreToolUse hook to tag
 * intermediate `read`/`write`/`vault_access` events with the right trace_id
 * + scope. Written here on every router pass so coalesced sessions
 * attribute intermediates to the most-recent invocation. Path mirrors the
 * `<sessDir>` → `/workspace` mount in container-runner.ts.
 */
const SESSIONS_BASE = path.resolve(process.cwd(), 'data', 'v2-sessions');
export function writeTraceSentinels(agentGroupId: string, sessionId: string, traceId: string, scope: string): void {
  const sessDir = path.join(SESSIONS_BASE, agentGroupId, sessionId);
  /* eslint-disable no-catch-all/no-catch-all -- tracing must never break the host */
  try {
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '.current-trace-id'), traceId);
    fs.writeFileSync(path.join(sessDir, '.current-agent'), scope);
  } catch {
    // Tracing must never break the host — drop silently.
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
function dateDir(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function writeTraceLine(trace: TraceContext, level: Level, msg: string, data: Record<string, unknown>): void {
  if (!trace.trace_id || !trace.agent_folder) return;
  const tracesRoot = path.join(HARNESS_GROUPS_DIR(), trace.agent_folder, 'Traces');
  const dir = path.join(tracesRoot, dateDir());
  /* eslint-disable no-catch-all/no-catch-all -- tracing must never break the host */
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Strip the trace key from the metadata bucket to avoid duplication.
    const { trace: _omit, ...meta } = data;
    void _omit;
    const ts = new Date().toISOString();
    // Per `mindgraph-trace/load.ts:271`, request_summary is read off the entry
    // event at the TOP LEVEL — putting it in metadata leaves the SELECTED
    // TRACE panel as "(no summary)". Hoist it out for entry/route events.
    const event = trace.event ?? level;
    const isEntry = event === 'entry' || event === 'route';
    const line = JSON.stringify({
      trace_id: trace.trace_id,
      timestamp: ts,
      agent: trace.agent_folder,
      node_id: trace.node_id ?? `host:${msg}`,
      event,
      related_node_id: trace.related_node_id ?? null,
      ...(isEntry && trace.summary ? { request_summary: trace.summary } : {}),
      metadata: { level, msg, ...meta },
    });
    fs.appendFileSync(path.join(dir, `${trace.trace_id}.jsonl`), line + '\n');
    // index.jsonl: append on the request-entry event ('route') so the trace
    // shows up in Nova's left panel exactly once per inbound message. Summary
    // comes from the inbound text the user sent. Per TracingPlan.md
    // "Index line shape" + "One trace = one invocation".
    if (trace.event === 'route' || trace.event === 'entry') {
      const summary = trace.summary ?? (typeof meta.summary === 'string' ? meta.summary : msg);
      const indexLine = JSON.stringify({
        trace_id: trace.trace_id,
        timestamp: ts,
        summary,
        agents: [trace.agent_folder],
        node_count: 1,
        path: `${dateDir()}/${trace.trace_id}.jsonl`,
      });
      fs.appendFileSync(path.join(tracesRoot, 'index.jsonl'), indexLine + '\n');
    }
  } catch {
    // Tracing must never break the host. Drop silently — plaintext log already emitted.
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function safeStringify(v: unknown): string {
  // The replacer runs after each toJSON, so nested redaction holds; mapping BigInt
  // and cycles here keeps stringify from throwing on them.
  const ancestors: unknown[] = [];
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw */
  try {
    return JSON.stringify(v, function (this: unknown, _key, value: unknown) {
      if (typeof value === 'bigint') return `${value}n`;
      if (typeof value !== 'object' || value === null) return value;
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(value)) return '[Circular]';
      ancestors.push(value);
      return value;
    });
  } catch {
    // A throwing toJSON, getter or Proxy trap: fail closed, never print the raw value.
    return '[unserializable]';
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return safeStringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : safeStringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw: a throw here reaches uncaughtException, which exits the host */
  try {
    stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
  } catch {
    // e.g. a throwing getter on the data bag itself, read before safeStringify sees it.
    try {
      process.stderr.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET} [log data unserializable]\n`);
    } catch {
      /* nowhere left to report it */
    }
  }
  // JSONL trace sink: a `trace` key on the data bag also appends an event line.
  // Reading the bag can itself throw (e.g. a Proxy trap), so this is guarded too.
  try {
    if (data && typeof data.trace === 'object' && data.trace !== null) {
      const tc = data.trace as TraceContext;
      if (tc.trace_id && tc.agent_folder) writeTraceLine(tc, level, msg, data);
    }
  } catch {
    // Tracing must never break the host — the plaintext line is already out.
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
