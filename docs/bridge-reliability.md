# ACP bridge reliability and plan review investigation

Inspected 2026-11-04 against Command Code 1.88.2 and installed T3 Code Beta 0.1.5. The repository and installed bridge had identical hashes before this change. No prompt, resume, compaction, cancellation, provider change, or other action was sent to the user's affected thread or native session. Local diagnostic files were read only; tests used synthetic children and newly created isolated native sessions.

## What the evidence establishes

The old bridge forwarded `agent_thought_chunk` without modifying it. Compaction aliases also forwarded to the native `/compact` handler. No code intentionally removed thinking after compaction. Local diagnostics contain incomplete ACP prompt lifecycles and teardown/interruption races, but no retained bridge traffic trace sufficient to establish the precise historical cause. A resumed conversation showing the submitted message only establishes that the host persisted it, not that the model produced output. The original provider working is useful evidence, but does not identify which connection/runtime state failed.

The old bridge did have concrete reliability gaps:

- It ignored `write()` backpressure in both directions, allowing large replays or output bursts to accumulate behind a slow reader.
- It called `process.exit()` on the child's `exit` event, before child pipes or the bridge's own stdout necessarily drained. Final responses could be truncated.
- It had no pipe-error handling and silently dropped malformed JSON, leaving requests without an explicit failure.
- It retained translated questions after cancellation and did not bind their lifecycle to the originating session/turn.
- It had no activity diagnostics or silence/cancellation deadline. A connected child that stopped producing output could leave the client waiting indefinitely.

These are fixed without changing the installed Command Code bundle or T3 application. They are failure modes covered by regression tests, not a claim that the historical stall has been conclusively reproduced or that all provider stalls can be prevented. Silence cancellation is a recovery mechanism and can interrupt legitimate work that produces no ACP activity for the configured interval.

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
