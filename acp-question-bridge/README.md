# Command Code ACP bridge

The bridge translates Command Code's single-choice question requests into ACP forms. A compatible client can show a user-input card, even when permissions are bypassed. Only an explicitly submitted option is returned. Dismissal and unsupported custom text produce cancellation. Command Code may still proceed with a stated assumption after cancellation.

`/context` shows the last session usage update received from Command Code, including the window and fill percentage. This host reading is an estimate and may not immediately reflect compaction. Before the host sends a reading, the command says that no reading is available. If a future Command Code version advertises its own `/context`, the bridge passes the command to it instead. `/cccompact` invokes Command Code’s native ACP `/compact`; use it in T3 because T3 intercepts `/compact` for its own compaction action and generic ACP providers currently lack that action. `/compact` itself passes through when an ACP client sends it directly. All other ACP traffic passes through unchanged except recognized question requests.

Command Code's current question transport cannot return multiple selections or arbitrary custom text; the bridge cannot add those features. The generic T3 form does not preserve separate option descriptions. Avoid relying on multi-select questions through this bridge.

The executable launches `/usr/local/bin/cmd acp`; set `COMMAND_CODE_BINARY` to override it. In T3, use the separate **Command Code Question Bridge (Test)** local ACP provider. New provider sessions load the installed bridge; existing sessions retain the version they started with.

To uninstall, remove the separate bridge provider in T3 settings, then remove `~/.commandcode/acp-question-bridge/`. Do not restore the saved complete settings backup without considering later settings changes. The original Command Code provider is independent.

Run tests from this repository with `node --test acp-question-bridge/bridge.test.mjs`.
