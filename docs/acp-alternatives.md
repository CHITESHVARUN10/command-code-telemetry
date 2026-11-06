# Other Command Code ACP adapters and reliability lessons

Researched 2026-11-06. These are verified examples, not an exhaustive list. Source was downloaded for reading only; no third-party adapter was installed or run.

## Native Command Code ACP

Command Code's [official ACP implementation](https://commandcode.ai/docs/acp) runs `cmd acp`, maintains native sessions, and connects editor-supplied MCP servers. Its documented behavior supports keeping this as our underlying harness. The official documentation does not establish that a silent connection is dead or promise periodic heartbeats.

## Paseo compatibility proxy

[mohemohe/paseo-cmd-acp](https://github.com/mohemohe/paseo-cmd-acp), inspected commit `50be8534d79fa9b2c0b4d2bf7ae05e690580b5db`, wraps `cmd acp`, much like our transport arrangement, but targets Paseo's UI conventions.

Its [main process handling](https://github.com/mohemohe/paseo-cmd-acp/blob/50be8534d79fa9b2c0b4d2bf7ae05e690580b5db/src/main.ts) and [pending-request handling](https://github.com/mohemohe/paseo-cmd-acp/blob/50be8534d79fa9b2c0b4d2bf7ae05e690580b5db/src/proxy.ts) provide concrete relevant patterns: settle pending requests on startup/exit failure, use child `close` so output drains, flush stdout before exit, and preserve forwarding order. Its other translations address mode options, usage accounting, diffs and error presentation. Those changes are specific to Paseo and should not be copied indiscriminately into T3.

Our bridge already uses pending-request failure handling and child `close`, plus output backpressure. This comparison supports those choices; it does not prove that their adapter solved our historical incident.

## Headless Command Code adapter

[tariqwest/commandcode-acp](https://github.com/tariqwest/commandcode-acp), inspected commit `dd99370460de025ccbbed3126208444bd935c2f5`, takes a different approach: it runs `cmd -p ... --output-format json` and constructs ACP sessions/updates around headless output.

Its [subprocess implementation](https://github.com/tariqwest/commandcode-acp/blob/dd99370460de025ccbbed3126208444bd935c2f5/src/cmd.ts) waits for `close`, consumes a final buffered line, waits for asynchronous output handlers, and escalates explicit abort from SIGTERM to SIGKILL after 1.5 seconds. Its [documented limitations](https://github.com/tariqwest/commandcode-acp/blob/dd99370460de025ccbbed3126208444bd935c2f5/README.md#what-is-not-forwarded-by-design) include no forwarded host MCP servers, image/audio prompts or tool-result updates, and final-text rather than token streaming.

Recommendation: study its lifecycle code, but do not replace our native proxy with it. The documented missing host-MCP path conflicts directly with the T3 visual tools we just investigated. No evidence was found that this adapter resolves the particular DeepSeek silence problem.

## A verified fix in the ACP host

Paseo [PR #8384](https://github.com/getpaseo/paseo/pull/8384), merged October 31, 2026, describes a real startup hang: an initialize request stayed unresolved after the provider process exited, and the host waited for a timeout. The fix rejects startup requests on child close after stderr drains and tests with real subprocesses.

Lesson: process death and unresolved promises should produce explicit failures promptly. This is different from cancelling a live process just because no messages arrived. Our bridge's opt-in silence policy and failure recorder preserve that distinction. The PR does not claim to repair post-initialization model hangs.

## Similar upstream reports are not a diagnosis

Command Code [issue #991](https://github.com/CommandCodeAI/command-code/issues/991) reports truncated upstream streams and retry exhaustion with large DeepSeek contexts on Apple Silicon. [Issue #596](https://github.com/CommandCodeAI/command-code/issues/596) reports 503 errors and continuation trouble around compaction; the page is closed as not planned. These are user reports of related symptoms, not demonstrated causes of our incident or verified fixes for it. No matching third-party fix was established in this investigation.

## What we adopted

Keep the native Command Code ACP process, preserve its tools and host MCP connection, drain transport output, settle failed requests explicitly, and avoid automatic task replay. Bridge 2.0.3 adds failure-only snapshots with a bounded metadata history so the next observed failure can be classified as startup, pipe/protocol, native request, unexpected exit, or an explicitly enabled silence timeout. It records bridge source locations and process state; it cannot reveal an upstream service's internal source location.

No third-party code was copied, no alternate adapter was installed, and the affected conversation was untouched.
