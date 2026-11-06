# T3 visual tools through Command Code ACP

Inspected on 2026-11-06 against the installed T3 application bundle, Command Code 1.88.2, and bridge 2.0.1. This is separate from the question-card adapter and the session monitor mod.

## Result

T3's inline charts, diagrams, and interactive HTML pages are provided by its `html_preview` and `html_render` MCP tools. They are not a GPT-only model capability. Models generate the HTML; T3 previews, stores, and displays it.

The existing bridge already forwards the configuration and messages needed by these tools. No additional visual MCP server, permanent credential, global Command Code MCP configuration, or bridge runtime patch is needed for direct tool calls in the inspected versions. T3 supplies its own authenticated, thread-scoped MCP connection when opening the ACP session. A bridge cannot create that thread association for clients that do not supply it.

Verified architecture:

```text
T3 creates a thread-scoped MCP connection
  → session/new (or load/resume) carries a t3-code MCP server descriptor
  → our bridge forwards it unchanged
  → Command Code connects and discovers the tool schemas
  → DeepSeek / another model calls the registered MCP tool
  → T3 executes html_preview or html_render for that thread
  → Command Code emits ACP tool events and results
  → our bridge forwards them unchanged
  → T3 recognizes html_render and displays its HTML attachment inline
```

This is a different path from native Command Code `ask_user_question`, which our bridge translates from permissions to explicit elicitation forms. A local HTML button can change the visualization; it does not automatically submit an answer to the agent. Continue using the question adapter for decisions that must pause the agent and return an actual answer.

## Tool contracts

The actual MCP tools are named `html_preview` and `html_render`. Command Code qualifies tools by server; for T3 the names are normally `mcp__t3-code__html_preview` and `mcp__t3-code__html_render`. Discover the registered names rather than inventing aliases.

| Tool | Input | Result |
| --- | --- | --- |
| `html_preview` | `html`: complete document; optional `width`: 240–1600 CSS pixels; optional `appearance`: `dark` or `light` | PNG preview, measured `contentHeight`, console messages, and missing-image information |
| `html_render` | `html`: complete document; `title`: 1–200 characters; `height`: 80–2000 CSS pixels | `htmlRender` reference containing `attachmentId`, title, height, and optional width/height measurements |

HTML is limited to 512,000 characters by the installed schemas. T3's additional rendering and attachment validation still applies. Read the live descriptions for styling requirements: inline CSS/JS, transparent outer page, fluid width, fixed chart heights, T3 theme variables, and no `vh` or `height:100%` page sizing. Rendering stores an HTML attachment and produces an inline page; merely writing an HTML file or printing HTML in chat does not invoke this UI.

Run `html_preview`, inspect the returned preview and console output, fix any problems, then call `html_render` with the final HTML and measured height within its supported bounds. No local web server is required.

Command Code can defer external tool schemas. Its current discovery tool is `search_tools`, with `select:<registered-name>` for exact lookup. Its retired `tool_search` name should not be prescribed as the current tool. Some configurations also expose `codemode` with `describeTool` and script tool access. For the acceptance test, request **direct MCP calls**: T3 recognizes the individual ACP tool call by its qualified name. Nested calls inside `codemode` do not emit the same individual ACP events in the inspected Command Code bundle; their inline rendering is not covered by this verification. Do not claim support for that path based on successful tool execution alone.

## Installed source trace

T3's bundled server is split across `runtimeLayer-*.mjs`, `ManagedEndpointRuntime-*.mjs`, and `server-*.mjs` in `app.asar`. Bundle hashes change on updates. Relevant symbols:

- `HtmlPreviewTool`, `HtmlRenderTool`, `registerHtmlPreview`, and `layerHtmlToolkit`: actual MCP registration, schemas, preview-image handling, and renderer handlers.
- `HtmlRender.publish`: writes the rendered HTML attachment, measures it, and records its reference against the originating thread.
- `acpMcpContext`: supplies server name `t3-code`, an `acp-mcp-bridge` stdio command, and thread-scoped endpoint/authorization environment variables. It also constructs optional HTTP/ACP transport descriptors.
- `sessionMcpServers`: chooses an advertised supported transport, falling back to the stdio server descriptor. Generic local registry agents use that stdio path in the inspected build. Command Code advertises HTTP support, but T3's generic registry flavor does not enable its optional HTTP descriptor except for certain specific adapters.
- `makeAcpRegistryRuntime`: forwards T3's MCP process environment to the local provider process.
- `t3AcpPromptWithInstructions`: supplies T3's tool usage instructions to ACP agents, including the preview/render sequence. Its terminal MCP fallback exists, but is unnecessary when ordinary MCP discovery works.
- `extractMcpToolCallIdentity`: recognizes qualified MCP names such as `mcp__t3-code__html_render` in ACP tool titles.
- ACP dynamic-tool projection and `McpProviderSessions.takeHtmlRender`: associate successful render calls with their thread's stored HTML reference. This also supports providers whose ACP output lacks a typed `rawOutput` field.

Command Code's installed `dist/cli.mjs`:

- `handleNewSession`, `handleLoadSession`, `handleResumeSession`, `bindAgentSession`, and `connectEditorMcpServers` forward and connect editor-supplied MCP servers.
- `planEditorMcpServers` accepts stdio and HTTP, skips SSE, and gives existing Command Code servers precedence over editor servers with the same name. A manually configured `t3-code` server can therefore shadow the actual thread-scoped one.
- `toolTitleFor` preserves unknown/MCP qualified tool names. `translateAgentEvent` sends the input and final text/image content through ACP. Our bridge preserves those events.
- `getToolsForMode` and `isToolAllowedInMode` exclude MCP tools in native `plan` mode. The bridge must not silently bypass that restriction. Use a non-Plan mode for the visual test; native Plan-mode visuals would require an upstream policy change or an explicitly designed separate route.

Codex uses its own provider integration for MCP configuration and tool events. Both paths reach the same T3 HTML tools and renderer; our Command Code bridge does not route DeepSeek through Codex or require a GPT model.

## Verification and limits

`npm test` covers the existing monitor checks and bridge regression suite. New bridge tests verify that:

- Initialization capabilities and stdio/HTTP MCP descriptors survive new/load/resume/fork requests unchanged, including headers and environment fields.
- HTML input, preview images, qualified MCP names, HTML attachment references, and error results survive forwarding across two independent sessions.
- Bridge diagnostics do not record the test credentials, HTML, or attachment references.

These are transport tests with a fake native process. They do not assert that every native session method is supported by Command Code.

`npm run test:bridge-mcp` is a separate opt-in smoke test against real installed, authenticated Command Code. It creates a disposable working directory and a fresh native session, supplies a probe stdio MCP server named `t3-code`, and verifies that Command Code initializes it and discovers its two tool schemas. It closes only that new session. It makes **zero model calls**, changes no MCP settings, and does not inspect or resume existing sessions. The probe tools do not render anything.

To check the installed bridge file instead of the repository copy:

```sh
node acp-question-bridge/mcp-loading.smoke.mjs "$HOME/.commandcode/acp-question-bridge/bridge.mjs"
```

Local result: real Command Code 1.88.2 discovered both probe schemas through bridge 2.0.1. This proves real editor-MCP loading, not that DeepSeek selected the tools or that a real page rendered in the T3 UI. That final acceptance test needs the actual model/provider thread below. No new bridge installation is needed: the runtime file is unchanged.

## DeepSeek acceptance prompt

Use a new or disposable T3 conversation with the bridge provider and DeepSeek selected. Choose a non-Plan mode. Paste:

```text
Test T3 Code's native inline HTML visualization tools in this conversation.

Discover the actual registered T3 MCP tools for html_preview and html_render.
If their schemas are deferred, use the available tool-discovery mechanism;
in Command Code this may be search_tools. Read their real schemas.

Create a small interactive bar chart with clearly labeled demonstration data:
Apples 12, Oranges 8, Bananas 15. Add buttons to switch between counts and
percentages. Use inline CSS/JS and T3 theme variables. No external libraries.

Call html_preview, inspect its preview/console result, then call html_render
with the final HTML and an appropriate measured height. Call these MCP tools
directly by their registered names, so each has its own visible tool call;
do not nest them inside codemode for this test. Do not start a web server.

If either tool is missing or fails, report the exact tool name and error.
Do not claim the chart rendered unless html_render actually succeeds.
Do not modify project files or enter Plan mode.
```

Acceptance requires two visible tool invocations, successful preview, a successful render attachment, the actual inline chart, and buttons that change its display. A model's claim that it rendered is insufficient. The chart's local controls do not need to send a message back to the model.

If it fails, distinguish discovery failure, MCP permission rejection, renderer error, and successful execution without inline display. Check for native Plan mode, a conflicting `t3-code` MCP configuration, disabled tools, or use of nested `codemode`. Never copy thread-scoped MCP tokens into permanent configuration or logs. Keep existing sessions untouched during investigation.

Official Command Code references: [ACP editor MCP support](https://commandcode.ai/docs/acp), [MCP setup](https://commandcode.ai/docs/mcp), and [tool availability and Plan restrictions](https://commandcode.ai/docs/reference/tools). Installed implementation details above were checked locally rather than inferred from those pages.
