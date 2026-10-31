# DeepSeek user interaction investigation

Investigation date: 2026-10-31. Installed T3 Code Beta 0.1.5; installed Command Code 1.88.2. T3's installed Electron bundle was inspected directly; public source was also checked at commit `79f1fadfc6020b820d541ca4691d2feebb15dd1b` and may differ from the installed build.

## Findings

DeepSeek in the observed setup runs through the Command Code ACP registry agent. Command Code registers the native `ask_user_question` tool and sends its schema to the model: one to four questions, each with a header, question text, two to four labeled options with descriptions, and optional `multiSelect`. Its description promises a free-text answer and says to mark recommendations in the first option's label. Command Code's own child agents do not receive this tool. This is a harness tool, not an MCP tool or a DeepSeek-specific provider tool.

A live, isolated ACP session using DeepSeek called the real tool. The resulting `session/request_permission` had a `toolCall` of kind `other`, `rawInput` containing the question and labels, and three options `option_0`, `option_1`, `option_2`, all of kind `allow_once`. An ACP test client replied `option_1`; the model reported `Option B`. This proves one explicit choice survives Command Code's ACP round-trip; it does not test T3's UI.

Command Code's `requestQuestions` loops over questions and makes a separate permission request for each. The response accepts one `optionId`, converts its numeric suffix to one label, and returns one `selectedOptions` entry. It omits `multiSelect`, custom answers, previews, and the full grouped questionnaire from the ACP question payload. Descriptions appear in the option display names. The tool call ID (or a generated fallback) is used for the request, and Command Code associates the answer with the question's array index. Cancellation becomes an empty answer. Its tool instructions permit the model to proceed with a stated assumption after a decline.

T3's generic ACP adapter treats these requests as permissions unless its provider flavor identifies them as questions. In the installed build the only `extractPermissionQuestion` flavor found is Antigravity, not generic ACP registry. When its runtime policy allows an `other` operation, the adapter selects the first `allow_once` option without asking the user. All Command Code question options have that kind, so it returns `option_0`; Command Code translates that to the first label and tells the model it was answered. The installed selector was executed independently with three representative options and returned `option_0`. This is a concrete reproducible code path consistent with the reported symptoms, not proof of the exact events in the unprovided test thread. Verify the actual T3 runtime policy and event record for that run before attributing the historical answer to it. Command Code bypass mode and T3's full-access policy are separate settings.

Codex uses `item/tool/requestUserInput`: T3 creates a pending user-input request, waits for its deferred answer, and returns the answer to the original request. T3 also contains a user-input UI and ACP elicitation handling. Its pending-request tools list, read and respond to existing questions; they do not expose a create operation. Command Code's generic ACP bridge currently does not use the full user-input interface. The Antigravity extraction is provider-specific and must remain unaffected by any change.

## Recommended approach

1. Immediate T3-side safety patch: recognize Command Code question permission requests using a narrowly scoped, validated provider identity and payload signature, before permission auto-approval. Convert each to a T3 user-input question and map the explicitly submitted choice back to the exact offered option ID. Cancellation/interruption must resolve as cancelled; invalid or missing answers must never select a default. Preserve all normal permission behavior for other tools and providers. This gives reliable *single-select* only, because the existing ACP payload cannot express the full contract. A broad heuristic matching arbitrary `kind: other` permission requests is unsafe.
2. Complete feature: change Command Code's ACP bridge to negotiate and use a structured form elicitation or an agreed extension carrying the complete questions, stable IDs, descriptions, multi-select and free text, and receive structured answers. Pair it with T3's existing elicitation/user-input path, validating values and cancellation at both boundaries. Do not claim full support merely by changing T3's permission mapping: one ACP permission option ID cannot encode arbitrary multi-select or text. Verify protocol capabilities and compatibility with clients that do not support the extension. For unsupported clients, fail explicitly or use a clearly disclosed fallback, never invent an answer.
3. Only after the transport works, consider a mod or prompt nudge so the model chooses the appropriate tool. An extra MCP server is not established as necessary, and a system prompt cannot repair this wire-format loss or bypass auto-approval.

## Required regression and acceptance tests

Run against a patched T3 adapter and a deterministic fake ACP agent, plus a real Command Code/T3 integration and a user-driven UI test. Capture request ID, question ID, selected values and returned provider payload (without recording private answers in logs):

- Single select B; recommended A with explicit C; multi-select B+D; exact custom text; two questions with distinct IDs; cancel without selection; three successive interactions without state leakage.
- In full-access and approval-required modes, confirm a question never auto-answers; verify no normal permission approval changes. Test interruption/disconnect, late or duplicate responses, malformed IDs/values and multi-question partial cancellation.
- Verify Codex, Claude, Antigravity and ordinary ACP permission regressions independently. Test client capability negotiation and fallback.
- For real T3 UI tests, the user must select and submit known values; compare captured server response and actual tool result rather than the model's summary.

Current verification: the live single-select ACP test used an automated test client, not T3; the installed T3 first-option selector was checked in isolation. The seven end-to-end UI tests have not been run, and no patch has been applied.

## Source pointers

- Installed Command Code bundle: `/usr/local/lib/node_modules/command-code/dist/cli.mjs`, `requestQuestions`, `requestQuestion`, `ask_user_question` schema and tool implementation.
- Installed T3 application: `/Applications/T3 Code (Beta).app/Contents/Resources/app.asar`, server bundle functions `wireAcpRuntimeHandlers`, `acpPermissionDisposition`, `selectAutoApprovedPermissionOption` and `makeAntigravityAcpAdapterFlavor`.
- Public T3 source: `packages/provider-acp/src/server/adapter.ts` and `clientPolicy.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` and `AntigravityAdapterV2.ts`, `packages/client-runtime/src/state/pendingUserInput.ts`. Public source can differ from the installed release.
