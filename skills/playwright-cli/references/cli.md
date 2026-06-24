# Playwright CLI Reference

Check Node.js first:

```bash
node --version
```

If the reported major version is lower than 20, stop there and tell the user to
upgrade Node.js before using this skill. Do not run any Playwright CLI command on
Node.js 18 or 19.

Only after Node.js 20+ is confirmed, use direct `npx` commands with the required
Chrome persistent suffix:

```bash
npx --yes --package @playwright/cli playwright-cli --help --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

Windows PowerShell:

```powershell
node --version
```

If the reported major version is lower than 20, stop there and tell the user to
upgrade Node.js first.

```powershell
npx --yes --package @playwright/cli playwright-cli --help --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

Do not require `PWCLI`, `APP_UNPACKED_DIR`, or similar helper variables for normal use.
Windows PowerShell is supported; all examples below use the fixed profile path
`"\.playwright-cli\chrome-user-data"`.

## Core

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli close --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli click e3 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli dblclick e7 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli type "search terms" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli press Enter --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli fill e5 "user@example.com" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli drag e2 e8 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli hover e4 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli select e9 "option-value" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli upload ./document.pdf --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli check e12 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli uncheck e12 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli eval "document.title" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli eval "el => el.textContent" e5 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli dialog-accept --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli dialog-accept "confirmation text" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli dialog-dismiss --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli resize 1920 1080 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Navigation

```bash
npx --yes --package @playwright/cli playwright-cli go-back --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli go-forward --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli reload --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Keyboard

```bash
npx --yes --package @playwright/cli playwright-cli press Enter --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli press ArrowDown --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli keydown Shift --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli keyup Shift --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Mouse

```bash
npx --yes --package @playwright/cli playwright-cli mousemove 150 300 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli mousedown --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli mousedown right --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli mouseup --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli mouseup right --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli mousewheel 0 100 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Save as

```bash
npx --yes --package @playwright/cli playwright-cli screenshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli screenshot e5 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli pdf --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Tabs

```bash
npx --yes --package @playwright/cli playwright-cli tab-list --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-new --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-new https://example.com/page --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-close --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-close 2 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tab-select 0 --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## DevTools

```bash
npx --yes --package @playwright/cli playwright-cli console --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli console warning --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli network --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli run-code "await page.waitForTimeout(1000)" --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tracing-start --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli tracing-stop --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```

## Sessions

Use a named session to isolate work:

```bash
npx --yes --package @playwright/cli playwright-cli --session todo open https://demo.playwright.dev/todomvc --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
npx --yes --package @playwright/cli playwright-cli --session todo snapshot --browser chrome --headed --persistent --profile "\.playwright-cli\chrome-user-data"
```
