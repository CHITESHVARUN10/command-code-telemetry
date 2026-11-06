# ACP bridge reliability and plan review investigation

## Bridge 2.0.3: failure-only flight recorder

The last 96 metadata-only transport events stay in memory during normal work. Detected startup, protocol/pipe, unexpected native-exit and bridge-handler failures flush a bounded snapshot to the local `crashes` directory; structured native request errors and opt-in silence timeouts also produce labeled failure reports without being misclassified as process crashes. Fatal reports are updated with the eventual native close status. Ordinary client teardown no longer enters the unexpected-exit failure path just because a prompt was pending when the client disconnected.

Reports contain sanitized bridge call-site frames, runtime/version/process data, pending request ages, active tool kinds/statuses, per-process hashed correlation identifiers, buffered-output state and observed timer gaps. No raw payloads, native stderr, credentials, prompts, commands or answers are retained. Report-write failures are contained. Owner-only files retain the ten newest reports. See [configuration and limits](../acp-question-bridge/README.md#failure-only-reports-203) and [other ACP adapter research](./acp-alternatives.md).

Additional subprocess tests cover no report on normal teardown, crash state/exit status, metadata bounds and privacy, startup ENOENT, bridge exception call sites, native request errors without terminating later turns, retention, and disabled/unwritable report storage. The unchanged monitor remains independent.

## Bridge 2.0.2: silence is not proof of failure

The November 6 screenshot's cancellation is confirmed by bridge diagnostics at 11:59:27.516 UTC. Bridge 2.0.1 had received 3,793 native messages, including 3,165 thinking chunks, before triggering `silence_timeout`. Command Code returned `stopReason: cancelled` 15 milliseconds later. The bridge initiated this cancellation; no native crash was recorded at that point.

The last recorded inactivity was 944,912 ms (about 15 minutes 45 seconds), despite a configured 300,000 ms timeout. There was also a long gap between progress records. This establishes delayed timer observation, but cannot distinguish host sleep, process suspension, event-loop delay, or the underlying cause of missing native output. The diagnostic does not retain tool input/output, so it cannot identify which command or request was waiting. No prompt, resume, cancellation, or other action was sent to the affected session for this investigation.

The default automatic cancellation introduced in 2.0 was too aggressive: ACP does not require periodic heartbeats. In 2.0.2, `COMMAND_CODE_BRIDGE_IDLE_MS` defaults to `0` (disabled). A positive explicit value retains the previous cancellation behavior. Progress diagnostics, manual Stop, cancellation grace handling, and actual transport failure detection remain. This prevents the bridge's default policy from cancelling legitimate silent work; it does not fix or automatically diagnose a stalled model/tool. A connected but genuinely stuck provider can wait until manually stopped. Existing processes retain their original policy until reconnected.

Regression coverage checks the unset default, delayed output after silence, a subsequent turn, manual Stop, and opt-in automatic cancellation against an unresponsive child. Native smoke checks use fresh disposable sessions only.

## Bridge 2.0.1 follow-up

The 2026-11-04 16:28 IST screenshot was accompanied by a bridge diagnostic at 10:58:00 UTC: `Invalid JSON-RPC from ACP client; the connection was closed instead of dropping a message.` The process had received 226 agent messages, including 61 thinking chunks, and had no outstanding recorded requests when it rejected the frame. Its fatal client-input policy set the bridge exit code to 1 even though the native child subsequently exited with code 0. This identifies the immediate reason for that provider exit, rather than attributing it to a model crash or silence timeout.

Version 2.0's diagnostic did not distinguish failed JSON parsing from rejection of arrays or primitive values. The exact client frame was intentionally not retained, so its shape cannot be reconstructed. Installed T3's Effect JSON-RPC codec supports batch encoding, while the installed Command Code ACP parser rejects batches. Version 2.0.1 expands client batches into individual frames, returns standard parse/invalid-request errors for bad client input without terminating the provider, and records only error category and frame length. Malformed native output remains a transport failure. Tests cover continued thinking after a bad client frame, invalid message shapes, batch order and responses, and fragmented large UTF-8 input. No request was sent to the affected session during this follow-up.

Inspected 2026-11-04 against Command Code 1.88.2 and installed T3 Code Beta 0.1.5. The repository and installed bridge had identical hashes before this change. No prompt, resume, compaction, cancellation, provider change, or other action was sent to the user's affected thread or native session. Local diagnostic files were read only; tests used synthetic children and newly created isolated native sessions.

## What the evidence establishes

The old bridge forwarded `agent_thought_chunk` without modifying it. Compaction aliases also forwarded to the native `/compact` handler. No code intentionally removed thinking after compaction. Local diagnostics contain incomplete ACP prompt lifecycles and teardown/interruption races, but no retained bridge traffic trace sufficient to establish the precise historical cause. A resumed conversation showing the submitted message only establishes that the host persisted it, not that the model produced output. The original provider working is useful evidence, but does not identify which connection/runtime state failed.

The old bridge did have concrete reliability gaps:

- It ignored `write()` backpressure in both directions, allowing large replays or output bursts to accumulate behind a slow reader.
- It called `process.exit()` on the child's `exit` event, before child pipes or the bridge's own stdout necessarily drained. Final responses could be truncated.
- It had no pipe-error handling and silently dropped malformed JSON, leaving requests without an explicit failure.
- It retained translated questions after cancellation and did not bind their lifecycle to the originating session/turn.
- It had no activity diagnostics or silence/cancellation deadline. A connected child that stopped producing output could leave the client waiting indefinitely.

These were addressed without changing the installed Command Code bundle or T3 application. They are failure modes covered by regression tests, not a claim that the historical stall has been conclusively reproduced or that all provider stalls can be prevented. Since 2.0.2, silence cancellation is an opt-in recovery mechanism because it can interrupt legitimate work that produces no ACP activity for the configured interval.

A controlled comparison reproduced truncation: with a slow client, the previous committed bridge returned 131,072 bytes of a 2,800,164-byte final thinking frame, leaving invalid JSON while reporting exit code 0. The updated bridge returned all 2,800,164 bytes as a complete JSON frame. This demonstrates the transport bug independently of the affected session.

## Plan transport findings

Installed Command Code's `requestQuestion` serializes the question and labels as a permission request. Its native plan approval contains `planContent`, `planFilePath`, and `exitPlanMode`, but that serializer drops those fields. Its built-in plan review uses two options: `Yes, auto-accept edits` and `Cancel`. Native `session/set_mode` supports `plan`; this is a real permission mode, not just a prompt instruction.

Installed T3's ACP parser accepts `session/update` → `plan_update` with `plan:{type:'markdown', planId, content}`. `emitPlan` turns that into an active `proposed_plan` item. Its generic elicitation handler creates a native pending user-input request and returns the submitted answer. T3's normal client initializes with form elicitation support but currently omits the draft `plan` capability despite implementing the update. The bridge enables markdown plans for the verified `t3-code` client identity or clients that explicitly advertise plan support; other clients get a text plan.

The bridge reconstructs the missing display from session-observed plan paths or `exit_plan_mode` input, displays it before the form, and maps only explicit approval to the native approval. It rejects missing plans and asks again if a displayed file changed. Plan custom feedback cancels native approval and becomes an explicit revision prompt after the native prompt settles. There is no general auto-retry or replay of a failed task.

The full T3 annotation/editor → Command Code edited-plan result path is not implemented. For the current running review, use the approval card. T3's separate plan Implement action is a new-turn workflow, and clicking it while a question is pending may queue work behind the unanswered question.

An upstream limitation remains: Command Code's `resolvePlanContent` chooses the newest plan file in its global plans directory after session startup. ACP does not identify that choice. The bridge deliberately avoids global newest-file scanning and cannot prove that concurrent native planning sessions chose the same file it observed. Forwarding native `planContent`/`planFilePath` is the complete fix; see [upstream proposal](./upstream-plan-review.md). Do not claim terminal plan-editor parity or guaranteed concurrent plan identity.

## Validation

`npm test` runs the unchanged 17-check monitor suite and the bridge child-process integration suite. Bridge coverage includes explicit non-recommended selections, unsupported/cancelled answers, ordinary permissions, per-session context readings, native command precedence, compaction followed by thinking and another prompt, late-answer isolation, mode-switch sequencing/errors/cancellation, markdown plan publication, changed-plan reapproval, plan feedback continuation, unavailable/cross-session/symlinked plans, missing form capabilities, silence handling, waiting for user input, active thinking, malformed output, child exit, and a 2.8 MB final thinking message with a slow reader.

A fresh session against the installed Command Code accepted `/plan`, `/cccompact`, and `/bridge-status`. A second fresh session using `deepseek/deepseek-v4.1-flash` called the real `exit_plan_mode`; the bridge emitted a native markdown plan update followed by a form. The test client explicitly chose Stop, and the model returned `Plan left unimplemented`. A subsequent `/cccompact` returned `Nothing to compact yet`; another real prompt returned `Bridge responding after compact.` Eight actual thinking chunks traversed the bridge. These were direct ACP tests, not a T3 GUI test or a large-context compaction test.

## Local UI test

Start a fresh process using the bridge provider. Leave the affected conversation untouched. Send `/plan Plan a small change in this project. Write the plan under ~/.commandcode/plans/ and call exit_plan_mode. Do not implement until I approve.` Confirm a proposed-plan item and approval card appear. Submit a custom requested change; confirm another review appears with the change. Stop one review and verify no implementation. Approve a subsequent review only when ready. Then use `/cccompact`, send another prompt, and check any actual thinking is expandable. The bridge cannot show thinking the provider did not emit.

If a new stall occurs, the rotated bridge diagnostics distinguish received activity from complete silence, record timeout/cancellation/failure, and show whether thinking chunks reached the bridge without recording conversation content. No automatic operation touches the affected historical session.
