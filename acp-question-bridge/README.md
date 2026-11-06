# Command Code ACP bridge

The bridge runs the real `/usr/local/bin/cmd acp` and forwards normal prompts, thinking, tool calls, permissions, session management, and unknown ACP methods. It converts recognized Command Code questions to ACP elicitation forms so T3 asks the user even with full access. Only submitted answers select options. It is independent of the session monitor mod.

T3's inline charts and interactive HTML use its existing `html_preview` and `html_render` MCP tools. T3 supplies their connection to Command Code through ACP; this bridge already forwards that configuration and the visual tool results. No separate visual server or runtime update is required for direct calls. Native Plan mode hides MCP tools. See [visual-tool investigation, verification limits, and test prompt](../docs/t3-visual-tools.md).

## Commands

| Command | Behavior |
| --- | --- |
| `/context` | Last session usage received from Command Code. An estimate, potentially stale after compaction; not terminal `/context` analysis. |
| `/cccompact` | Native ACP `/compact`. T3 intercepts `/compact` itself before generic ACP providers receive it. |
| `/plan <task>` or `/ccplan <task>` | Set native session mode to `plan`, wait for acknowledgement, then send the task. Mode errors never start the task. |
| `/plan` or `/ccplan` | Set native plan mode without calling the model. For subsequent tasks, select Plan in T3 as well: T3 may reapply its selected mode on each new turn. |
| `/bridge-status` | Bridge version, received message count, forwarded thinking count, pending questions, and silence limit. No model call. |

An advertised native command with the same name takes precedence. Attachments prevent these local command matches; send a command as one text block.

## Plan review

Use `/plan <task>` or select Plan in T3. Native plan mode restricts tools while the agent investigates and prepares the plan. When Command Code asks to approve its plan, the bridge:

1. Uses explicit plan content when available, a plan file observed in that session's tool traffic, or the native `exit_plan_mode` fallback argument. It never scans the global plans directory for another session's newest file. Replayed history does not register a plan.
2. Publishes ACP `plan_update` with markdown for T3's proposed-plan UI. Other clients receive ordinary plan text unless they advertise draft plan support.
3. Opens a native T3 question card with **Implement this plan** and **Stop — review or revise in chat**. Use this card to approve the running review; a separate Implement action on T3's plan item may queue a new turn.
4. Maps explicit implementation approval to Command Code's original approval option. For file plans it checks that the displayed content has not changed; changes require another review. Approval uses Command Code's native "Yes, auto-accept edits" semantics, which may restore its prior bypass mode.
5. Treats custom text on this particular review card as revision feedback. It cancels native approval, waits for the native prompt to finish successfully, then submits the exact feedback in a new native prompt asking for revision and another review. The client prompt stays open until that sequence finishes. Stop, cancellation, and native errors discard queued feedback.

Missing/unreadable plans cannot be approved. Ask the agent to write and present the plan again. The existing mod may also display its own earlier plan guardrail; it is separate from this native review.

This uses T3's existing proposed-plan and question support. It does not wire T3's full editor/annotation workflow into Command Code's terminal plan editor. The installed Command Code resolves plan files using a global directory and drops its chosen file path from ACP; the bridge can only identify the plan from the session traffic it sees. Concurrent planning sessions remain an upstream limitation; see [diagnostic notes](../docs/bridge-reliability.md).

## Connection handling

The bridge respects output backpressure and flushes final messages before closing. Child exit, broken pipes, and malformed Command Code output fail outstanding requests explicitly. Malformed client input receives a JSON-RPC parse/invalid-request error without terminating the provider. Client batches are expanded into individual frames for Command Code; T3 correlates the individual replies by request ID. Stop and session teardown clear question mappings; late answers cannot answer a later turn. Ordinary permission requests still pass through.

Since bridge 2.0.2, silence cancellation is **disabled by default**. ACP does not guarantee heartbeats: a tool, model request, or suspended host can be quiet without proving failure. Diagnostics still record inactivity; manual Stop and actual transport failures still work. A genuinely stalled but connected provider can therefore remain waiting until you stop it.

To opt into automatic cancellation, set `COMMAND_CODE_BRIDGE_IDLE_MS` to a positive duration. At that limit the bridge sends cancellation; after `COMMAND_CODE_BRIDGE_CANCEL_MS` without completion it fails the connection. Waiting for a user question or native client request is exempt. Thinking and tool updates refresh the limit. This policy can interrupt legitimate silent work. There are no automatic task retries, automatic resumes, or fabricated thinking messages.

Diagnostics rotate at approximately 1 MiB, keeping the current file and one backup. They contain counts and lifecycle events, not prompts, answers, plans, credentials, or captured child stderr. Command Code's own stderr is still forwarded to the client as before.

### Failure-only reports (2.0.3)

The bridge keeps the last 96 message summaries in memory and writes a separate JSON report **only on a detected failure**: startup/pipe/protocol failure, unexpected native exit, bridge exception, a native JSON-RPC request error, or an explicitly enabled silence timeout. Request errors and timeouts are labeled as such; they are not necessarily process crashes. Normal completion, normal client teardown, and ordinary Stop do not create reports.

Reports live in `~/.commandcode/acp-question-bridge/crashes/`, retain the ten newest files, and use owner-only file permissions. They include version/runtime information, native exit code/signal when available, message counts and sizes, pending request ages, tool kinds/statuses, output backpressure, observed timer gaps, and bridge source line numbers. Request/session/tool identifiers are hashed with a per-process salt. Prompts, answers, HTML, commands, tool titles, environment values, raw error messages, and native stderr are excluded. The existing lifecycle diagnostic is separate; set `COMMAND_CODE_BRIDGE_LOG` to an empty string if you want only failure reports on disk.

The report path is printed to stderr on failure and the directory appears in `/bridge-status`. Share the latest JSON report for diagnosis. Reports locate the bridge boundary that failed, not the internal source line of a native tool/model service. A silent live hang alone does not trigger a report with the default policy. SIGKILL, power loss, and failures before JavaScript loads cannot reliably produce an in-process report. Recording errors never deliberately terminate the bridge.

| Environment variable | Default |
| --- | --- |
| `COMMAND_CODE_BINARY` | `/usr/local/bin/cmd` |
| `COMMAND_CODE_BRIDGE_IDLE_MS` | `0` (disabled); positive milliseconds opt into silence cancellation |
| `COMMAND_CODE_BRIDGE_CANCEL_MS` | `5000` |
| `COMMAND_CODE_BRIDGE_LOG` | `~/.commandcode/acp-question-bridge/diagnostics.ndjson`; empty disables logging |
| `COMMAND_CODE_BRIDGE_CRASH_DIR` | `~/.commandcode/acp-question-bridge/crashes/`; empty disables failure reports |

Configure these on the local ACP provider's process environment. New provider processes load new bridge code; replacing the file does not update or interrupt an existing process.

## Remaining question limits

Command Code's current question transport accepts one option ID per question. General questions cannot return multiple selections or arbitrary custom text. Unsupported custom text and dismissal cancel the question. Command Code may still proceed with an assumption after a general question is cancelled. The plan-specific feedback continuation described above does not change the general tool's schema. Generic T3 forms also do not preserve separate option descriptions.

## Install and rollback

Copy `bridge.mjs` to `~/.commandcode/acp-question-bridge/bridge.mjs`, make it executable, and configure a separate local ACP provider with that absolute executable and no arguments. Keep the original Command Code provider available. For updates, save the installed file first and replace it atomically. Reconnect only when ready; active sessions retain the old code.

To roll back, restore that one bridge file from its backup and start a new provider process. To uninstall, remove the separate provider in T3 settings, then remove `~/.commandcode/acp-question-bridge/`. Do not restore a full settings backup over later settings changes. The original provider and session monitor mod are independent.

Run tests with `node --test acp-question-bridge/bridge.test.mjs`, or `npm test` for both components.
