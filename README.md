# command-code-telemetry

[![Tests](https://github.com/CHITESHVARUN10/command-code-telemetry/actions/workflows/test.yml/badge.svg)](https://github.com/CHITESHVARUN10/command-code-telemetry/actions/workflows/test.yml)

Live model, context, speed, and cache telemetry for [Command Code](https://commandcode.ai) — plus `/tokens`, `/con`, and `/com` commands that work in the terminal **and over ACP**.

```
⬡ claude-sonnet-5-5 · effort high · ctx 23% (230.4k/1M) · tps ~87 · cache-hit 87%
```

## Two components

This repository contains two independent components that can be used together:

Bridge 2.0.3 adds [failure-only diagnostic reports](./acp-question-bridge/README.md#failure-only-reports-203). See the [research on other Command Code ACP adapters](./docs/acp-alternatives.md) for their failure-handling approaches and compatibility limits.

Bridge 2.0.4 also loads [T3 system guidance](./acp-question-bridge/t3-guidance.mjs) through Command Code's native prompt hook. It teaches models to discover the actual T3 tools, preview and render inline HTML through direct MCP calls, and wait for submitted question answers. The guidance is appended on every model round, including after compaction; user prompts remain unchanged. Install both bridge files as shown below. This improves tool usage without granting missing capabilities or removing Plan-mode restrictions.

- **Session monitor mod** ([session-monitor.ts](./session-monitor.ts)) loads inside Command Code. It provides telemetry, `/tokens`, `/con`, `/com`, and a best-effort plan review guardrail in terminal and ACP sessions.
- **ACP bridge** ([acp-question-bridge/bridge.mjs](./acp-question-bridge/bridge.mjs)) runs between an ACP client such as T3 Code and Command Code. It starts the real `cmd acp` process and forwards its ACP messages in both directions, with targeted changes described below. It does not replace the Command Code harness or require the session monitor mod.

The bridge forwards ordinary ACP traffic, including normal prompts, thinking, tool calls, session messages and permission requests. It translates recognized single-choice questions into ACP forms; provides `/context` from host usage updates; translates `/cccompact` into native `/compact`; and adds `/plan <task>` (also `/ccplan`) to enter native plan mode before planning. Plan reviews publish the identified plan as a T3 proposed-plan item and wait for an **Implement this plan** choice. A custom answer on a plan review requests revision, followed by another review; it never approves implementation. Other ACP clients may render these interactions differently. These are intended pass-through semantics, not a guarantee that every ACP feature or every client combination has been tested.

T3's `html_preview` / `html_render` MCP tools provide inline charts and interactive HTML for models using Command Code as well. The existing bridge forwards their configuration and results. See [visual tool access, tests, and a DeepSeek acceptance prompt](./docs/t3-visual-tools.md); native Plan mode and nested `codemode` calls have separate limitations.

There are limits: the question bridge cannot return multi-select or arbitrary custom text through Command Code's current question transport; cancellation may still lead the model to proceed with an assumption. `/context` uses the last ACP host reading, which can be an estimate and is **not** the terminal's detailed `/context` analysis. T3 currently intercepts `/compact` before the generic ACP provider receives it, so use `/cccompact` in a bridge session. See [bridge documentation](./acp-question-bridge/README.md) and [ACP capability research](./docs/acp-capability-research.md).

Bridge 2.0 handles output backpressure, drains final replies before exiting, clears abandoned questions, and reports failed connections. Since 2.0.2, silence alone does not cancel work by default: long tools and model requests can be quiet. Automatic silence cancellation requires an explicit positive `COMMAND_CODE_BRIDGE_IDLE_MS` setting. Manual Stop still works, and tasks are never automatically retried. [Diagnostic notes](./docs/bridge-reliability.md) explain the evidence and testing limits for the reported stalls.

Bridge 2.0.1 also accepts client JSON-RPC batches and returns protocol errors for malformed client frames without closing the provider. This corrects the fatal client-input handling that caused the subsequent code-1 exit.

## Why this exists

Command Code's built-in `/context` is a terminal-UI overlay. When Command Code runs behind an ACP client (Zed, T3 Code, …), that overlay is not part of the ACP command surface — a command the ACP layer does not resolve falls through to the model as ordinary prompt text. This mod publishes the same kind of information as plain-text slash commands, and keeps a live status line in the footer for terminal use.

- `/con` — current context usage.
- `/com` — compact the conversation now.
- `/tokens` — per-session token accounting.

All three return plain text, so they behave the same in the TUI and in any ACP client that routes slash commands to the mod host.

## Features

- **Live footer**: current model, reasoning effort, and context-window usage as a percentage with used/limit tokens. Turns yellow at ≥ 80% and red at ≥ 90%.
- **Live TPS**: while a response streams, `tps ~87` is a live estimate (streamed characters ÷ 4, matching the CLI's own estimator, over the time since the first streamed token). When the response completes it is replaced by the exact rate (`tps 87`).
- **Prompt-cache hit rate**: `cache-hit 87%` is the share of the latest request's input tokens served from cache. It appears only once the provider reports cache activity, so non-caching providers stay clean.
- **ACP-friendly commands**: `/con` and `/com` are advertised to ACP clients and resolved by the mod host before the prompt reaches the model.
- **Plan guardrail**: when a plan file is written and the built-in plan review will not run (for example in `bypass` mode, or over ACP where the review question loses the plan text), the mod posts the plan and asks Approve / Stop before implementation. Enabled by default; disable it with `--mod-option planGate=false`.
- **Session token accounting**: `/tokens` reports input, output, cache read/write, requests, turns, context fill, speed, and cache-hit rates, including per-model totals when you switch models.
- **Stays in sync while you work**: model/effort changes from `/model`, `/effort`, or any other surface update the footer immediately (or at the next request at the latest).
- **Survives resume**: totals are persisted as mod-private entries in the session store, so `/tokens` still adds up after a session is resumed.
- **Defensive by design**: every handler is wrapped, malformed event payloads are ignored, and unknown models degrade to raw token counts instead of failing.

## Install the session monitor mod

Requires [Command Code](https://commandcode.ai) with mod support. The mod is a single file with no dependencies.

Command Code loads user mods from `~/.commandcode/mods/`. Download the latest file straight there:

```sh
mkdir -p ~/.commandcode/mods
curl -fsSL https://raw.githubusercontent.com/CHITESHVARUN10/command-code-telemetry/master/session-monitor.ts \
  -o ~/.commandcode/mods/session-monitor.ts
```

Or, from a local clone:

```sh
mkdir -p ~/.commandcode/mods
cp session-monitor.ts ~/.commandcode/mods/
```

Reload a running session with `/reload`, or start a new one.

To try it without installing:

```sh
cmd --mod ./session-monitor.ts
```

### Install the ACP bridge for T3 Code

The bridge is separate from the mod. With Node.js available on the executable search path and Command Code installed at `/usr/local/bin/cmd`, copy the bridge to a stable location:

```sh
mkdir -p ~/.commandcode/acp-question-bridge
cp acp-question-bridge/t3-guidance.mjs ~/.commandcode/acp-question-bridge/t3-guidance.mjs
cp acp-question-bridge/bridge.mjs ~/.commandcode/acp-question-bridge/bridge.mjs
chmod +x ~/.commandcode/acp-question-bridge/bridge.mjs
```

In T3 Code, add a separate **local ACP provider** whose executable is the absolute path to that file, with no arguments. Select that provider for new sessions. The existing Command Code ACP provider can remain configured. The bridge launches `/usr/local/bin/cmd acp`; set `COMMAND_CODE_BINARY` for a different executable path. Restart a bridge session after updating the file.

To uninstall, remove the bridge provider from T3 settings and remove `~/.commandcode/acp-question-bridge/`. Remove the mod separately only if desired.

### Updating

Replace `~/.commandcode/mods/session-monitor.ts` with the latest version and run `/reload`.

### ACP clients

All commands are advertised to ACP clients when a session starts, so `/tokens`, `/con`, and `/com` appear in the client's slash-command list. They are parsed and resolved by the mod host, return plain text, and end the turn without a model call.

Send the command as a single text block. Extra content blocks (attachments) prevent slash-command parsing, so the text is treated as an ordinary prompt instead.

## Commands

| Command | What it does |
|---|---|
| `/con` | Live context usage: tokens used, window size, tokens free, fill percentage and a bar. |
| `/com` | Request compaction and report the host outcome when available. |
| `/tokens` | This session's input / output / cache totals, request and turn counts, context fill, speed, and cache-hit rates. |
| `/tokens reset` | Zero the session counters. |

### `/con`

```text
Context — claude-sonnet-5-5 · effort high

  used    230,400 tokens
  source  host context estimate
  window  1,000,000 tokens
  free    769,600 tokens (77%)
  fill     23%  █████░░░░░░░░░░░░░░░

  /com compacts the conversation · /tokens shows session totals
```

Reads `cmd.getContextUsage()` for the host’s current estimate. When the host does not expose a reading, it labels the last request’s token count as potentially stale. Unknown/BYOK models still report their used tokens, without a percentage.

### `/com`

```text
Conversation summarized.
Estimated conversation messages: 154,696 → 128,320 tokens.
Host context reading: 180,505 → 180,505 tokens.
```

Runs Command Code's native `cmd.sessions.compact()`. The message estimate and host context reading use different accounting; the latter may retain pre-compaction usage until a subsequent model request. A `too-small` outcome means the host did not find enough older messages to summarize. Command Code decides how much recent conversation to retain. If the host does not report an outcome, `/com` says it could not verify the result.

### `/tokens`

```text
Session tokens — claude-sonnet-5-5 · effort high

  input              230,400
  output              12,300
  cache read         200,000
  cache write         10,000
  ─────────────────────────
  requests 1 · turns 1

  · input includes cache read/write
  context            230,400 / 1,000,000  (23%)
  speed          87 tok/s (last response) · 85 tok/s (session avg)
  cache hit      87% (last response) · 87% (session avg)
```

## Options

| Option | Default | Effect |
|---|---|---|
| `--mod-option showTokens=false` | `true` | Footer shows only the context percentage, without the `(230.4k/1M)` detail. |
| `--mod-option planGate=false` | `true` | Disable the plan guardrail (plan display + approve/stop prompt). |

### Plan review over ACP

Command Code's built-in plan review only runs in `default` and `plan` modes, and the ACP bridge
sends its question without the plan text. The `planGate` guardrail fills that gap:

- A plan file written under `~/.commandcode/plans/` is posted to the feed with a warning
  notice — over ACP, warnings are the only notice level that reaches the client.
- Outside `default`/`plan` mode, it then asks **Approve — implement this plan** or
  **Stop — I want to review the plan**. Stop terminates the run and blocks same-batch
  implementation calls, so the plan is not written straight into code.
- In `default`/`plan` mode it only surfaces the plan; the built-in review owns the decision.

This is a best-effort guardrail, not a replacement for the native panel: it cannot change the
built-in review question, and dismissing/cancelling the prompt lets the run continue. The
upstream fix (forwarding `planContent` / `planFilePath` / `exitPlanMode` through ACP) is
described in [docs/upstream-plan-review.md](./docs/upstream-plan-review.md).

## How it works

- Event-driven: `model_request_start` / `model_request_end`, `turn_end`, `text_delta`, `thinking_delta`, `config_setting_changed`, `subagent_start` / `subagent_stop`.
- The footer is pushed through `cmd.ui.setStatus`; sessions without status capability simply skip it.
- Totals persist as mod-private session entries (`session-monitor/totals`), which is what makes resume work.
- The model → context-window/effort catalog is hydrated by re-reading the installed CLI bundle on first use, with an embedded static table as the offline fallback. Models added by a Command Code update are picked up automatically.

## Compatibility

Built against the documented [ModApi](https://commandcode.ai/docs/mods) only — no private internals and nothing version-pinned.

- **Graceful degradation**: unknown models show raw context tokens instead of a percentage; headless runs skip the footer; hosts that do not expose `getContextUsage()` or `sessions.compact()` get a clear message instead of an error.
- **Subagent-safe**: while a subagent runs, its requests do not overwrite the main conversation's context reading.
- **Future model updates**: if a future release changes the bundle format and the runtime catalog scan stops finding models, only context percentages are affected. Add the new ids to `STATIC_CATALOG` in `session-monitor.ts` (one line per model) and re-copy the file.

## Development

```sh
npm test
```

Runs the real mod factory against a stubbed ModApi: 17 checks covering registration, footer rendering, `/tokens`, `/con`, `/com`, reset, the plan gate, the subagent guard, malformed events, persistence + resume, and catalog scanning. The bundle-hydration check runs when a Command Code install is present and is skipped otherwise.

It also runs the bridge integration suite with isolated child processes: explicit answers, cancellation, native command precedence, plan display/approval/revision, session isolation, silence handling, connection errors, and a large thinking message with a slow reader. Run just that suite with `node --test acp-question-bridge/bridge.test.mjs`.

No npm dependencies. The bridge needs Node.js; Node ≥ 22.6 is required for the TypeScript test via type stripping. CI runs the suite on Node 22 and 24.

## Uninstall the mod

```sh
rm ~/.commandcode/mods/session-monitor.ts
```

Then `/reload`.

## License

MIT — see [LICENSE](./LICENSE).
