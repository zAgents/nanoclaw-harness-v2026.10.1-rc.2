# Harness: JSONL request tracing + per-agent Vault gate

This repository is [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) with the
[zAgents/nanoclaw-harness](https://github.com/zAgents/nanoclaw-harness) patches applied
directly to the source tree, so no `git apply` step is needed at install time.

| | |
|---|---|
| nanoclaw base | tag `v2026.10.1-rc.2` (package.json version 2026.10.1-rc.2) |
| harness source | zAgents/nanoclaw-harness @ `f1a1131` (patches pinned to nanoclaw v2.0.17) |

## What the harness adds

Four files carry the harness. Everything else is upstream nanoclaw.

- `src/log.ts`: when a log call carries a `trace` object, an event line is also appended to
  `groups/<agent_folder>/Traces/YYYY-MM-DD/<trace_id>.jsonl` and (for entry events) to
  `groups/<agent_folder>/Traces/index.jsonl`. Also exports the session-to-inbound map,
  the `entryNodeForAgentFolder` / `traceScopeForAgentFolder` mapping hooks, and
  `writeTraceSentinels`, which writes `.current-trace-id` and `.current-agent` into
  `data/v2-sessions/<agent_group_id>/<session_id>/` (mounted at `/workspace` in the container).
- `src/router.ts`: on every routed inbound, records the inbound id as the trace id, writes the
  sentinels, and emits the `entry` trace event with a short request summary.
- `src/delivery.ts`: on every delivered outbound, emits the paired `exit` trace event.
- `container/agent-runner/src/providers/claude.ts`: a PreToolUse Vault gate. Own-vault paths
  (`/workspace/vault`, `/workspace/agent/Vault`) are allowed and force tracing; any other path
  containing `/Vault/` is blocked. Mind-page reads/writes under `/workspace/agent/*.md` and vault
  decisions are emitted as `read` / `write` / `vault_access` events into the same trace file.

Per-agent node overrides go in `entryNodeForAgentFolder` and `traceScopeForAgentFolder` in
`src/log.ts`, as the harness's `new-agent.sh` describes.

## Porting notes (v2.0.17 patches onto 2026.10)

- `getAgentGroup` is async upstream now; the delivery exit hook awaits it.
- `SDK_DISALLOWED_TOOLS` moved to `claude-config.ts`; the harness no longer redeclares it.
- The trace lookup in `emit` is wrapped in its own try/catch so a throwing data bag cannot escape
  (upstream's `log.test.ts` covers this).
- Three hunks in the original patches reverted unrelated upstream fixes (typing-indicator cleanup on
  failed wake, the accumulate-policy security check, and the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  override). Those were artifacts of an older working tree and were not ported.

## Not included

The MasterMind starter pack, project wiki templates, Nova viewer and lifecycle scripts live in
the harness repo, not in nanoclaw. Use them from there; point `install-nanoclaw.sh --upstream`
at this repository and skip `install-harness.sh`'s patch step (it will report the patches as
already applied only against the old baseline; the code here already contains them).
