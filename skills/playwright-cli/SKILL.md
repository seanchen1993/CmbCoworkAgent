---
name: base-playwright-cli
description: Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via direct `npx --yes --package @playwright/cli playwright-cli ...` commands. Always run Chrome headed with the shared persistent profile at `\.playwright-cli\chrome-user-data`.
---

# Playwright CLI Skill

Drive a real browser from the terminal using `playwright-cli` through direct `npx` commands.
Treat this skill as CLI-first automation. Do not pivot to `@playwright/test` unless the user explicitly asks for test files.

Every browser-driving command in this skill must end with:

```powershell
--browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

Place that suffix after the subcommand and its arguments. Keep `--session` before the
subcommand when you need it. Use that shared profile path unless the user explicitly
supplies a different one.
Windows PowerShell is supported; Command Prompt is not explicitly covered.
Do not ask the user to set helper variables such as `PWCLI`, `APP_UNPACKED_DIR`, or
`PLAYWRIGHT_CLI_SESSION` just to use this skill. Default to a directly executable command.
On Windows PowerShell, keep using the direct `npx` form instead of shell wrapper indirection.

## Browser Reuse

If a browser window is already open and has not been closed, do not use `open` for the
next page. Use `tab-new <url>` instead.
Use `open` only to start the first page in a fresh browser session or after the
browser has been closed.

## Prerequisite check (required)

Before proposing or running Playwright CLI commands, check Node.js first. Node.js must
be version 20 or newer:

```bash
node --version
node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
```

If `node` is missing or the detected major version is lower than 20, pause and tell
the user they need to upgrade to Node.js 20 or newer before this skill can be used.
This is a hard stop. Do not run any Playwright CLI command until Node.js 20+ is confirmed.
The only allowed next step is to tell the user to upgrade Node.js.

After Node.js 20+ is confirmed, check whether `npx` is available:

Unix shells:

```bash
command -v npx >/dev/null 2>&1
```

Windows PowerShell:

```powershell
Get-Command npx | Out-Null
```

If `npx` is not available, pause and ask the user to install npm or reinstall
Node.js/npm (which provides `npx`). Provide these steps verbatim:

```bash
# Verify Node/npm are installed and Node.js is 20+
node --version
npm --version

# If missing or Node.js is lower than 20, install/upgrade Node.js/npm, then:
npm install -g @playwright/cli@latest
playwright-cli --help
```

Once both Node.js 20+ and `npx` are confirmed, use direct
`npx --yes --package @playwright/cli playwright-cli ...` commands with the required
Chrome suffix. A global install of `playwright-cli` is optional.
Use the fixed profile path `"\.playwright-cli\chrome-user-data"` in the examples below.

## Quick start

Use direct commands:

```bash
npx --yes --package @playwright/cli playwright-cli open https://playwright.dev --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e15 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli type "Playwright" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli press Enter --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli screenshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

Only after Node.js 20+ is confirmed, this is the preferred one-line sanity check:

```bash
npx --yes --package @playwright/cli playwright-cli --help --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Core workflow

1. Open the page.
2. Snapshot to get stable element refs.
3. Interact using refs from the latest snapshot.
4. Re-snapshot after navigation or significant DOM changes.
5. Capture artifacts (screenshot, pdf, traces) when useful.

Minimal loop:

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e3 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## When to snapshot again

Snapshot again after:

- navigation
- clicking elements that change the UI substantially
- opening/closing modals or menus
- tab switches

Refs can go stale. When a command fails due to a missing ref, snapshot again.

## Recommended patterns

### Form fill and submit

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com/form --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli fill e1 "user@example.com" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli fill e2 "password123" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e3 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

### Debug a UI flow with traces

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tracing-start --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
# ...interactions...
npx --yes --package @playwright/cli playwright-cli tracing-stop --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

### Multi-tab work

```bash
npx --yes --package @playwright/cli playwright-cli tab-new https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-list --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-select 0 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Command style

Always prefer the fully spelled-out direct command with the required suffix appended.

## References

Open only what you need:

- CLI command reference: `references/cli.md`
- Practical workflows and troubleshooting: `references/workflows.md`

## Guardrails

- Node.js `<20` is a blocking prerequisite failure. Stop immediately and instruct the
  user to upgrade; do not probe further with `npx` or any Playwright CLI command.
- Always snapshot before referencing element ids like `e12`.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over `eval` and `run-code` unless needed.
- On Windows, emit PowerShell-safe direct `npx` commands instead of `$env:...` wrapper setup.
- When you do not have a fresh snapshot, use placeholder refs like `eX` and say why; do not bypass refs with `run-code`.
- Use `--headed` when a visual check will help.
- When capturing artifacts in this repo, use `output/playwright/` and avoid introducing new top-level artifact folders.
- Default to CLI commands and workflows, not Playwright test specs.
