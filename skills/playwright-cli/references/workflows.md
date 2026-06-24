# Playwright CLI Workflows

Use direct `npx` commands and snapshot often.
In this repo, run commands from `output/playwright/<label>/` to keep artifacts contained.
Before starting, verify Node.js is installed and `node --version` reports version 20
or newer. If it is lower than 20, ask the user to upgrade Node.js before using this
skill. This is a blocking failure: do not continue to any Playwright CLI command until
Node.js 20+ is available.

If a browser window is already open and still running, prefer `tab-new <url>` for the
next destination instead of `open`. Reserve `open` for the first page of a fresh
browser session, or after the browser has been closed.

Every command in these workflows must end with:

```powershell
--browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

PowerShell should use the same suffix with `"\.playwright-cli\chrome-user-data"` as the profile path.

## Standard interaction loop

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e3 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Form submission

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com/form --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli fill e1 "user@example.com" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli fill e2 "password123" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e3 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli screenshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Data extraction

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli eval "document.title" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli eval "el => el.textContent" e12 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Debugging and inspection

Capture console messages and network activity after reproducing an issue:

```bash
npx --yes --package @playwright/cli playwright-cli console warning --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli network --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

Record a trace around a suspicious flow:

```bash
npx --yes --package @playwright/cli playwright-cli tracing-start --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
# reproduce the issue
npx --yes --package @playwright/cli playwright-cli tracing-stop --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli screenshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Sessions

Use sessions to isolate work across projects:

```bash
npx --yes --package @playwright/cli playwright-cli --session marketing open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli --session marketing snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli --session checkout open https://example.com/checkout --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
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

- If an element ref fails, run `npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"` again and retry.
- If the page looks wrong, re-open with `--headed` and resize the window.
- If a flow depends on prior state, use a named `--session`.
