import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
// The execution-policy, inference, MCP, and memory derivations live in
// claude-config.ts. The runtime contract (provider-contracts/claude.ts)
// declares them; core calls them and hands the results to this provider's
// constructor and registerMemorySessionHook. This module never imports the
// contract — registration is two-step so it compiles on a core without one.
import {
  SDK_DISALLOWED_TOOLS,
  type resolveClaudeExecutionPolicy,
  type resolveClaudeInference,
  type resolveClaudeMcpServers,
  type resolveClaudeMemoryRuntime,
} from './claude-config.js';
// Transcript archiving and rotation are this provider's own concern: both
// read the SDK's on-disk .jsonl, which no other provider has.
import { archiveClaudeTranscript, rotateClaudeContinuation } from './claude-history.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

// ── Vault gate ──
//
// Implements MasterMind/Vault.md rules 1 (per-agent isolation) and 5 (auto-force
// tracing on own-vault read). Rules 2/3/4 are behavioral and out of scope here.
// Hook into PreToolUse — runs the moment Claude attempts a tool call, sees both
// tool_name and tool_input, can return decision='block'.
//
// Path semantics (per v2 container layout + MasterMind/Vault.md):
//   /workspace/vault/...        own attached-files mount (single-spawn scope)
//   /workspace/agent/Vault/...  own group-folder Vault subdir (used by the
//                               Phase-3 walking-skeleton sentinel)
//   anything else containing /Vault/  cross-agent path → block
//
// On own-vault touch we append to /workspace/.trace-forced. The Track-B JSONL
// sink reads this marker to force tracing for the rest of the spawn.

const VAULT_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);
const VAULT_OWN_ATTACHED = '/workspace/vault';
const VAULT_OWN_GROUP = '/workspace/agent/Vault';
const VAULT_TRACE_MARKER = '/workspace/.trace-forced';
const VAULT_PATH_RE = /\/[Vv]ault(\/|$)/;
const VAULT_BASH_PATH_RE = /(?:^|[\s'"=:])(\/[\w\-./~]*[Vv]ault[\w\-./]*)/g;

function extractVaultPaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  if (VAULT_FILE_TOOLS.has(toolName)) {
    const candidate = toolInput.file_path ?? toolInput.path;
    return typeof candidate === 'string' ? [candidate] : [];
  }
  if (toolName === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    const out: string[] = [];
    let m: RegExpExecArray | null;
    VAULT_BASH_PATH_RE.lastIndex = 0;
    while ((m = VAULT_BASH_PATH_RE.exec(cmd)) !== null) {
      if (m[1]) out.push(m[1]);
    }
    return out;
  }
  return [];
}

function isOwnVaultPath(p: string): boolean {
  const n = path.normalize(p);
  return (
    n === VAULT_OWN_ATTACHED ||
    n.startsWith(VAULT_OWN_ATTACHED + '/') ||
    n === VAULT_OWN_GROUP ||
    n.startsWith(VAULT_OWN_GROUP + '/')
  );
}

interface VaultDecision {
  block: boolean;
  forceTrace: boolean;
  reason: string;
}

function evaluateVaultPath(p: string): VaultDecision {
  if (isOwnVaultPath(p)) {
    return { block: false, forceTrace: true, reason: 'own vault — auto-force tracing (rule 5)' };
  }
  if (VAULT_PATH_RE.test(p)) {
    return { block: true, forceTrace: false, reason: 'cross-agent vault path (rule 1)' };
  }
  return { block: false, forceTrace: false, reason: '' };
}

function markTraceForced(toolName: string, p: string, reason: string): void {
  try {
    fs.appendFileSync(VAULT_TRACE_MARKER, `${new Date().toISOString()}\t${toolName}\t${p}\t${reason}\n`);
  } catch (err) {
    log(`vault-gate: failed to write trace marker: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Container-side trace emission ──
//
// Per `_ProjectWiki/TracingPlan.md`, agents emit `read`/`write`/`mcp_call`
// events from inside the container so the trace shows actual reasoning steps
// (not just host-emitted entry/exit anchors). The host writes the current
// inbound msg.id to /workspace/.current-trace-id at routing time; this hook
// reads it to tag emitted events with the right trace_id.
//
// Mind-file detection: anything matching /workspace/agent/<basename>.md (root
// of the group folder) is treated as a Mind page. The node_id is derived as
// `<agent>:<basename-lowercased-no-ext>`. The `<agent>` scope is read from
// /workspace/.current-agent (host-written sibling sentinel) so this code stays
// folder-agnostic — works for any agent group folder.

const TRACE_ID_FILE = '/workspace/.current-trace-id';
const TRACE_AGENT_FILE = '/workspace/.current-agent';
const MIND_FILE_RE = /^\/workspace\/agent\/([A-Za-z][\w-]*)\.md$/;

function readSentinel(p: string): string | undefined {
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return v.length ? v : undefined;
  } catch {
    return undefined;
  }
}

function dateDir(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function appendTraceEvent(payload: Record<string, unknown>): void {
  const traceId = readSentinel(TRACE_ID_FILE);
  if (!traceId) return;
  const dir = `/workspace/agent/Traces/${dateDir()}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/${traceId}.jsonl`, JSON.stringify(payload) + '\n');
  } catch (err) {
    log(`trace-emit: failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function emitMindEvent(toolName: string, mindPath: string): void {
  const traceId = readSentinel(TRACE_ID_FILE);
  const agent = readSentinel(TRACE_AGENT_FILE);
  if (!traceId || !agent) return; // no active invocation context; silently drop
  const m = MIND_FILE_RE.exec(mindPath);
  if (!m) return;
  const slug = m[1].toLowerCase();
  const eventName = toolName === 'Read' ? 'read' : 'write';
  appendTraceEvent({
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    agent,
    node_id: `${agent}:${slug}`,
    event: eventName,
    related_node_id: null,
    metadata: { tool: toolName, path: mindPath },
  });
}

/**
 * Vault decisions are also trace events: rule-1 BLOCK and rule-5 AUTO-TRACE
 * both go into the JSONL so Nova surfaces *why* a vault path was touched
 * (or refused) alongside the agent's reasoning steps. Uses the standard
 * `vault_access` event shape, with `metadata.reason` carrying the gate's
 * own explanation string.
 */
function emitVaultEvent(toolName: string, vaultPath: string, decision: 'allow' | 'block', reason: string): void {
  const traceId = readSentinel(TRACE_ID_FILE);
  const agent = readSentinel(TRACE_AGENT_FILE);
  if (!traceId || !agent) return;
  const safeSlug = vaultPath.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'vault';
  appendTraceEvent({
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    agent,
    node_id: `${agent}:vault:${safeSlug}`,
    event: 'vault_access',
    related_node_id: null,
    metadata: { tool: toolName, path: vaultPath, decision, reason },
  });
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

export { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude-config.js';

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Vault gate (MasterMind/Vault.md rules 1 + 5).
  const vaultPaths = extractVaultPaths(toolName, i.tool_input ?? {});
  for (const p of vaultPaths) {
    const decision = evaluateVaultPath(p);
    if (decision.block) {
      log(`vault-gate: BLOCK ${toolName} "${p}" (${decision.reason})`);
      emitVaultEvent(toolName, p, 'block', decision.reason);
      return {
        decision: 'block',
        stopReason: `Vault rule 1 (per-agent isolation): you may not access "${p}" — that's another agent's Vault, or a path that looks like one. If you genuinely need this, ask the operator directly per MasterMind/Vault.md (no agent→agent vault transfer).`,
      } as unknown as ReturnType<HookCallback>;
    }
    if (decision.forceTrace) {
      log(`vault-gate: AUTO-TRACE ${toolName} "${p}" (${decision.reason})`);
      markTraceForced(toolName, p, decision.reason);
      emitVaultEvent(toolName, p, 'allow', decision.reason);
    }
  }
  // Mind-page touch → emit a `read`/`write` trace event so Nova shows
  // intermediate steps (the agent reasoning), not just host entry/exit
  // anchors. Only fires on Read/Write/Edit; Bash and other tools skipped.
  if (VAULT_FILE_TOOLS.has(toolName)) {
    const target = (i.tool_input?.file_path ?? i.tool_input?.path) as string | undefined;
    if (typeof target === 'string') emitMindEvent(toolName, target);
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Minimum spacing between `activity` frames derived from streaming deltas. */
const STREAM_ACTIVITY_INTERVAL_MS = 1000;

// The notices are written for a terminal user; a chat user can't act on them
// and must never be invited to paste a key.
const OWNER_FIX_HINT =
  "Whoever runs this NanoClaw needs to fix this outside the chat. Please don't send keys or passwords here.";

/** The Claude CLI's own fixed failure notices (exact strings), safe to show in a channel, and the hint added to each. */
const SDK_NOTICES = new Map([
  ['Not logged in · Please run /login', OWNER_FIX_HINT],
  ['Invalid API key · Fix external API key', OWNER_FIX_HINT],
  ['Invalid auth token · Fix external auth token', OWNER_FIX_HINT],
  ['Credit balance is too low', OWNER_FIX_HINT],
  ['Prompt is too long', 'This conversation got too long. An admin can send /clear to start a new one.'],
]);

/** The real clock for archive names and rotation stamps; tests hand the history functions a fixed one. */
const REAL_CLOCK = { now: () => Date.now() };

// The PreCompact hook is provider-originated: the SDK raises it from inside
// the query, and the archive it triggers reads the SDK's own transcript.
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveClaudeTranscript(
      {
        transcriptPath: preCompact.transcript_path,
        sessionId: preCompact.session_id,
        assistantName,
        log,
      },
      REAL_CLOCK,
    );
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env or
 * `.env`; the host-side claude provider (src/providers/claude.ts) passes it
 * into the container. Useful with a 1M-context model variant.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  private assistantName?: string;
  private mcp: ReturnType<typeof resolveClaudeMcpServers>;
  private inference: ReturnType<typeof resolveClaudeInference>;
  private executionPolicy: ReturnType<typeof resolveClaudeExecutionPolicy>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * `configuration` is the contract's configuration as resolved by core
   * (createProvider): execution policy, inference, and MCP servers. This
   * provider does not call the resolves itself.
   */
  constructor(options: ProviderOptions, configuration: ResolvedRuntimeConfiguration) {
    this.assistantName = options.assistantName;
    this.mcp = configuration.mcpServers as ReturnType<typeof resolveClaudeMcpServers>;
    this.additionalDirectories = options.additionalDirectories;
    this.inference = configuration.inference as ReturnType<typeof resolveClaudeInference>;
    this.executionPolicy = configuration.executionPolicy as ReturnType<typeof resolveClaudeExecutionPolicy>;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  /**
   * `memory` is the contract's resolved memory capability (the runtime env
   * that keeps the SDK's own auto-memory off). Core registers the hook before
   * any query, so the SDK sees the same env it always did.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration, memory?: unknown): void {
    this.memorySessionHook = hook;
    this.env = {
      ...this.env,
      ...((memory as ReturnType<typeof resolveClaudeMemoryRuntime> | undefined) ?? {}),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * Pre-resume maintenance: drop a transcript too large or too old to
   * cold-resume within the host's idle ceiling (see claude-history.ts).
   */
  maybeRotateContinuation(continuation: string, _cwd: string): string | null {
    return rotateClaudeContinuation({ continuation, assistantName: this.assistantName, log }, REAL_CLOCK);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        // The append (agent name + destinations) is rebuilt at every container
        // start. Left to the SDK default, Claude Code records the prompt on a
        // session's first request and resends that record on every resume, so
        // a resumed agent would keep its old name and destination list until
        // compaction. snapshot: false renders it fresh each time.
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions, snapshot: false }
          : undefined,
        allowedTools: [...this.mcp.allowedTools],
        disallowedTools: [...this.executionPolicy.disallowedTools],
        // The SDK emits `assistant` only per completed content block, so a long
        // block is silent and the host sweep kills the container mid-generation.
        // Streaming deltas are the liveness signal for that window; translateEvents
        // turns them into throttled `activity` and nothing else.
        includePartialMessages: true,
        env: this.env,
        model: this.inference.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.inference.effort as any,
        permissionMode: this.executionPolicy.permissionMode,
        allowDangerouslySkipPermissions: this.executionPolicy.allowDangerouslySkipPermissions,
        settingSources: ['project', 'user', 'local'],
        // Flag-level settings: `fastMode` only when the install turns it on,
        // then the execution policy's fixed keys, spread last so per-group
        // input can never override them. Both are Settings members rather
        // than query options, which is why they ride `settings`.
        settings: { ...this.inference.settings, ...this.executionPolicy.settings },
        mcpServers: this.mcp.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      let lastStreamActivityAt = 0;
      for await (const message of sdkResult) {
        if (aborted) return;

        // Yield activity for every SDK event so the poll loop knows the agent
        // is working. Deltas arrive per token and carry no content for us, so
        // they count at most once per second, and not as messages.
        if (message.type === 'stream_event') {
          const now = Date.now();
          if (now - lastStreamActivityAt < STREAM_ACTIVITY_INTERVAL_MS) continue;
          lastStreamActivityAt = now;
          yield { type: 'activity' };
          continue;
        }
        messageCount++;
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          // Surface each assistant message's text as it streams in. The final
          // `result` event only carries the LAST assistant text — a wrapped
          // <message> block composed between tool calls would otherwise be
          // invisible to the poll-loop and silently lost.
          //
          // ONE text event per assistant message, joining its text blocks in
          // content order ('' separator — the blocks are adjacent output).
          // Emitting per-BLOCK events would hand the poll-loop's block parser
          // fragments: a <message> block (or an <internal> span) spanning two
          // text blocks of the same assistant message would look unterminated
          // in each event, while the turn's result text — which reports the
          // final message's text as a whole — could still contain it complete.
          // Joining pins the containment premise at the granularity the
          // result reports. Blocks split across ASSISTANT MESSAGES (a tool
          // call between them) remain unparseable mid-turn by design; the
          // poll-loop's midTurnSent===0 fallback and wrap-nudge cover that.
          const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
            ?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('');
            if (text) yield { type: 'text', text };
          }
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Keep that actionable notice separate from
          // model output so the poll-loop can deliver it without scratchpad.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const isError = m.is_error === true;
          // Some failures (e.g. an invalid API key) leave errors[] empty and put
          // the SDK's own notice in `result`. Other result text can echo upstream
          // bodies, so only exact fixed notices are reused; the rest stay generic.
          const candidate = isError && !m.errors?.length ? (m.result?.trim() ?? '') : '';
          // Notice first, hint on its own line: setup's ping shows only the first line.
          const hint = SDK_NOTICES.get(candidate);
          const resultAsError = hint ? `${candidate}\n${hint}` : '';
          yield {
            type: 'result',
            text: resultAsError ? null : (m.result ?? null),
            isError,
            error: m.errors?.length ? m.errors.join('\n') : resultAsError || undefined,
          };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
          // not necessarily an error. `rate_limit_info.status` is usually
          // 'allowed' (here's your remaining headroom). Treating every one of
          // these as a terminal quota error logged a spurious rate-limit line
          // on healthy turns (#3016) — and aborted them outright wherever the
          // classification is acted on. ONLY 'rejected' is an actual block.
          //
          // When it IS rejected the SDK tells us WHY, so we can finally
          // distinguish the two cases properly instead of guessing:
          //   errorCode 'credits_required' / overageDisabledReason
          //   'out_of_credits'  → genuinely out of credits (billing)
          //   otherwise         → a transient window limit that resets.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            // Informational ('allowed' / 'allowed_warning') — never kill the turn.
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // Not a `result`: the poll loop treats result text as the agent's turn
          // output — a synthetic "Context compacted." result has no <message>
          // block, so it triggers the "response was not delivered — please
          // re-send" nudge and the agent duplicates its previous message.
          // Compaction is bookkeeping: log it, count it as activity only.
          log(`Context compacted${detail}.`);
          yield { type: 'activity' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

// Function-form registration only; the runtime contract attaches itself from
// provider-contracts/claude.ts through the same two-step path any
// skill-installed provider uses.
registerProvider('claude', (opts, configuration) => {
  if (!configuration) {
    throw new Error('Claude provider requires its runtime contract; construct it through createProvider');
  }
  return new ClaudeProvider(opts, configuration);
});
