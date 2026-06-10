# Playwright CLI Workflows

Use direct `npx` commands and snapshot often.
In this repo, run commands from `output/playwright/<label>/` to keep artifacts contained.

## Standard interaction loop

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli click e3
npx --yes --package @playwright/cli playwright-cli snapshot
```

## Form submission

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com/form --headed
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli fill e1 "user@example.com"
npx --yes --package @playwright/cli playwright-cli fill e2 "password123"
npx --yes --package @playwright/cli playwright-cli click e3
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli screenshot
```

## Data extraction

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli eval "document.title"
npx --yes --package @playwright/cli playwright-cli eval "el => el.textContent" e12
```

## Debugging and inspection

Capture console messages and network activity after reproducing an issue:

```bash
npx --yes --package @playwright/cli playwright-cli console warning
npx --yes --package @playwright/cli playwright-cli network
```

Record a trace around a suspicious flow:

```bash
npx --yes --package @playwright/cli playwright-cli tracing-start
# reproduce the issue
npx --yes --package @playwright/cli playwright-cli tracing-stop
npx --yes --package @playwright/cli playwright-cli screenshot
```

## Sessions

Use sessions to isolate work across projects:

```bash
npx --yes --package @playwright/cli playwright-cli --session marketing open https://example.com
npx --yes --package @playwright/cli playwright-cli --session marketing snapshot
npx --yes --package @playwright/cli playwright-cli --session checkout open https://example.com/checkout
```

## Configuration file

By default, the CLI reads `playwright-cli.json` from the current directory. Use `--config` to point at a specific file.

Minimal example:

```json
{
  "browser": {
    "launchOptions": {
      "headless": false
    },
    "contextOptions": {
      "viewport": { "width": 1280, "height": 720 }
    }
  }
}
```

## Troubleshooting

- If an element ref fails, run `npx --yes --package @playwright/cli playwright-cli snapshot` again and retry.
- If the page looks wrong, re-open with `--headed` and resize the window.
- If a flow depends on prior state, use a named `--session`.
