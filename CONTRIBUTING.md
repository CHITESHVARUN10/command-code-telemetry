# Contributing

Thanks for taking a look. This is a single-file Command Code mod with no runtime dependencies.

## Before you open a PR

1. Keep the mod self-contained in `session-monitor.ts`.
2. Use the documented ModApi only (`https://commandcode.ai/docs/mods`); do not reach into private CLI internals.
3. Make failures invisible: event handlers and commands must never throw on malformed payloads.
4. Run the tests:

   ```sh
   npm test
   ```

5. Exercise the real host, since the stub only simulates the ModApi:

   ```sh
   cmd --mod ./session-monitor.ts
   ```

   Check the footer, `/tokens`, `/tokens reset`, `/con`, and `/com`.
6. Update `README.md` when behavior, commands, flags, or requirements change.

## Style

- Tabs for indentation in `.ts` and `.mjs` files.
- Single quotes, semicolons, and trailing commas, matching the existing code.
- Command output that must work over ACP stays plain text — no ANSI escapes.

## Reporting bugs

Include the Command Code version (`cmd --version`), your OS and Node version, the command you ran, and the exact output.
