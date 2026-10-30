# Upstream: plan review over ACP

Status: a best-effort workaround ships as `planGate` in `session-monitor.ts`; this document
describes the proper fix for Command Code (and the client-side rendering it enables).

## Observed behavior (Command Code 1.88.0)

- In `default` and `plan` modes, Command Code's built-in plan-review mod presents the plan when
  `exit_plan_mode` / `plan_review` runs, or when a plan file was written and the turn stops.
- In `bypass`, `auto-accept`, and `dont-ask`, the built-in mod returns early
  (`if ("default" !== mode && "plan" !== mode) return;`). A plan written without plan mode is
  therefore implemented with no review at all.
- Over ACP, even when the review runs, the plan text is dropped. The ACP adapter's
  `requestQuestion` sends only the question and option labels; the question payload's
  `planContent`, `planFilePath`, and `exitPlanMode` fields never reach the client. The client
  sees "Plan Review: Plan ready for review. Begin implementation?" with
  "Yes, auto-accept edits" / "Cancel" but cannot show the plan.

## Minimal fix: forward the plan payload over ACP

In the ACP adapter's `requestQuestion`, carry the plan fields on the permission request:

```ts
const toolCall = {
	toolCallId,
	title: question.header ? `${question.header}: ${question.question}` : question.question,
	kind: "other",
	status: "pending",
	rawInput: {
		question: question.question,
		options: question.options.map((option) => option.label),
		...(question.planContent ? {planContent: question.planContent} : {}),
		...(question.planFilePath ? {planFilePath: question.planFilePath} : {}),
		...(question.exitPlanMode ? {exitPlanMode: true} : {}),
	},
};
```

This is additive and backward compatible: ACP clients already receive `rawInput` for
permission requests. Clients that hide `rawInput` can be served through `_meta`:

```ts
_meta: {
	...(question.exitPlanMode ? {exitPlanMode: true} : {}),
	...(question.planFilePath ? {planFilePath: question.planFilePath} : {}),
	...(question.planContent ? {planContent: question.planContent} : {}),
},
```

## Client rendering (T3 Code and other ACP clients)

When a `session/request_permission` request has `toolCall.rawInput.exitPlanMode === true` (or
`_meta.exitPlanMode`), render a plan panel: the markdown plan content, the file path, and
Approve / Cancel. Otherwise fall back to the existing option list. Until that exists, the
`planGate` workaround posts the plan as a warning notice before the permission request.

## Mode policy

Skipping review in `bypass`, `auto-accept`, and `dont-ask` is a deliberate opt-out, but it
makes "plan this out" silently implement when the person did not switch modes. Either:

- run the plan-review backstop whenever a plan file was written, regardless of mode; or
- add a setting (`permissions.planReview: "always" | "default-plan"`) and honor it.

## Reproduction

1. Connect an ACP client (T3 Code) to Command Code with permission mode `bypass`.
2. Prompt: "Plan out <task>." — do not switch to plan mode.
3. The model writes `~/.commandcode/plans/<name>.md` and implements it; no review appears.
4. Repeat in `default`/`plan` mode: the review question appears, but the plan text is absent
   from the ACP permission request.

## Workaround in this repository

`planGate` watches `write_file` / `edit_file` under `~/.commandcode/plans/`, posts the plan
with a warning notice, and asks Approve / Stop outside `default`/`plan` modes. It is
best-effort: it cannot change the built-in review question, and dismissing/cancelling the
prompt lets the run continue. See the "Plan review over ACP" section in the main README.
