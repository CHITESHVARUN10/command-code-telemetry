# command-code-session-monitor

Live model, context, speed, and cache telemetry for [Command Code](https://commandcode.ai) — plus `/tokens`, `/con`, and `/com` commands that work in the terminal **and over ACP**.

```
⬡ claude-sonnet-5-5 · effort high · ctx 23% (230.4k/1M) · tps ~87 · cache-hit 87%
```

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
- **ACP-friendly commands**: `/con` and `/com` return plain text and are resolved by the mod host before the prompt reaches the model.
- **Session token accounting**: `/tokens` reports input, output, cache read/write, requests, turns, context fill, speed, and cache-hit rates, including per-model totals when you switch models.
- **Stays in sync while you work**: model/effort changes from `/model`, `/effort`, or any other surface update the footer immediately (or at the next request at the latest).
- **Survives resume**: totals are persisted as mod-private entries in the session store, so `/tokens` still adds up after a session is resumed.
- **Defensive by design**: every handler is wrapped, malformed event payloads are ignored, and unknown models degrade to raw token counts instead of failing.

## Install

Requires [Command Code](https://commandcode.ai) with mod support. The mod is a single file with no dependencies.

Command Code loads user mods from `~/.commandcode/mods/`:

```sh
mkdir -p ~/.commandcode/mods
cp session-monitor.ts ~/.commandcode/mods/session-monitor.ts
```

Reload a running session with `/reload`, or start a new one.

To try it without installing:

```sh
cmd --mod ./session-monitor.ts
```

### Updating

Replace `~/.commandcode/mods/session-monitor.ts` with the latest version and run `/reload`.

### ACP clients

Mod commands are not advertised in ACP's command list, so they will not appear in a client's slash-command autocomplete. Type the command as the first line of the prompt:

```
/con
```

The command returns plain text and ends the turn; no model call is made. Send the command as a single text block — extra content blocks (attachments) prevent slash-command parsing.

## Commands

| Command | What it does |
|---|---|
| `/con` | Live context usage: tokens used, window size, tokens free, fill percentage and a bar. |
| `/com` | Compact the conversation and report tokens freed, message counts, and the new fill. |
| `/tokens` | This session's input / output / cache totals, request and turn counts, context fill, speed, and cache-hit rates. |
| `/tokens reset` | Zero the session counters. |

### `/con`

```text
Context — claude-sonnet-5-5 · effort high

  used    230,400 tokens
  window  1,000,000 tokens
  free    769,600 tokens (77%)
  fill     23%  █████░░░░░░░░░░░░░░░

  /com compacts the conversation · /tokens shows session totals
```

Reads `cmd.getContextUsage()` for a live reading and falls back to the last request's token count when the host does not expose it. Unknown/BYOK models still report their used tokens, without a percentage.

### `/com`

```text
Compacted conversation: ~120,000 tokens freed · 40 → 9 messages.
Context is now 14% full (140,000 / 1,000,000).
```

Runs `cmd.sessions.compact()` — the same underlying compaction as the built-in `/compact` — and also refreshes the footer immediately instead of waiting for the next request.

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

Runs the real mod factory against a stubbed ModApi: 16 checks covering registration, footer rendering, `/tokens`, `/con`, `/com`, reset, the subagent guard, malformed events, persistence + resume, and catalog scanning. The bundle-hydration check runs when a Command Code install is present and is skipped otherwise.

No dependencies. Node ≥ 22.6 is required only to run the TypeScript test directly via type stripping. CI runs the suite on Node 22 and 24.

## Uninstall

```sh
rm ~/.commandcode/mods/session-monitor.ts
```

Then `/reload`.

## License

MIT — see [LICENSE](./LICENSE).
