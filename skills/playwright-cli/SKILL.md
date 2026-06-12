---
name: playwright
description: Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via direct `npx --yes --package @playwright/cli playwright-cli ...` commands.
---


# Playwright CLI Skill

Drive a real browser from the terminal using `playwright-cli` through direct `npx` commands.
Treat this skill as CLI-first automation. Do not pivot to `@playwright/test` unless the user explicitly asks for test files.

Do not ask the user to set helper variables such as `PWCLI`, `APP_UNPACKED_DIR`, or
`PLAYWRIGHT_CLI_SESSION` just to use this skill. Default to a directly executable command.
On Windows PowerShell, keep using the direct `npx` form instead of shell wrapper indirection.

## Prerequisite check (required)

Before proposing or running Playwright CLI commands, check Node.js first. Node.js must
be version 20 or newer:

```bash
node --version
node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
```

If `node` is missing or the detected major version is lower than 20, pause and tell
the user they need to upgrade to Node.js 20 or newer before this skill can be used.
Do not run `npx` or `playwright-cli` commands until Node.js 20+ is confirmed.

After Node.js 20+ is confirmed, check whether `npx` is available:

```bash
command -v npx >/dev/null 2>&1
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

Once `npx` is present, use direct `npx --yes --package @playwright/cli playwright-cli ...`
commands. A global install of `playwright-cli` is optional.

## Quick start

Use direct commands:

```bash
npx --yes --package @playwright/cli playwright-cli open https://playwright.dev --headed
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli click e15
npx --yes --package @playwright/cli playwright-cli type "Playwright"
npx --yes --package @playwright/cli playwright-cli press Enter
npx --yes --package @playwright/cli playwright-cli screenshot
```

On Windows PowerShell, the equivalent form is:

```powershell
npx --yes --package @playwright/cli playwright-cli open https://playwright.dev --headed
npx --yes --package @playwright/cli playwright-cli snapshot
```

This is also the preferred one-line sanity check:

```bash
npx --yes --package @playwright/cli playwright-cli --help
```

## Core workflow

1. Open the page.
2. Snapshot to get stable element refs.
3. Interact using refs from the latest snapshot.
4. Re-snapshot after navigation or significant DOM changes.
5. Capture artifacts (screenshot, pdf, traces) when useful.

Minimal loop:

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli click e3
npx --yes --package @playwright/cli playwright-cli snapshot
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
npx --yes --package @playwright/cli playwright-cli open https://example.com/form
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli fill e1 "user@example.com"
npx --yes --package @playwright/cli playwright-cli fill e2 "password123"
npx --yes --package @playwright/cli playwright-cli click e3
npx --yes --package @playwright/cli playwright-cli snapshot
```

### Debug a UI flow with traces

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --headed
npx --yes --package @playwright/cli playwright-cli tracing-start
# ...interactions...
npx --yes --package @playwright/cli playwright-cli tracing-stop
```

### Multi-tab work

```bash
npx --yes --package @playwright/cli playwright-cli tab-new https://example.com
npx --yes --package @playwright/cli playwright-cli tab-list
npx --yes --package @playwright/cli playwright-cli tab-select 0
npx --yes --package @playwright/cli playwright-cli snapshot
```

## Command style

Always prefer the fully spelled-out direct command:

```bash
npx --yes --package @playwright/cli playwright-cli --help
```

Do not introduce wrapper variables or shell aliases unless the user explicitly asks for them.

## References

Open only what you need:

- CLI command reference: `references/cli.md`
- Practical workflows and troubleshooting: `references/workflows.md`

## Guardrails

- Always snapshot before referencing element ids like `e12`.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over `eval` and `run-code` unless needed.
- On Windows, emit PowerShell-safe direct `npx` commands instead of `$env:...` wrapper setup.
- When you do not have a fresh snapshot, use placeholder refs like `eX` and say why; do not bypass refs with `run-code`.
- Use `--headed` when a visual check will help.
- When capturing artifacts in this repo, use `output/playwright/` and avoid introducing new top-level artifact folders.
- Default to CLI commands and workflows, not Playwright test specs.
