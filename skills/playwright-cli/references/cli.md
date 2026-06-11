# Playwright CLI Reference

Use direct `npx` commands:

```bash
npx --yes --package @playwright/cli playwright-cli --help
```

Windows PowerShell:

```powershell
npx --yes --package @playwright/cli playwright-cli --help
```

Do not require `PWCLI`, `APP_UNPACKED_DIR`, or similar helper variables for normal use.

## Core

```bash
npx --yes --package @playwright/cli playwright-cli open https://example.com
npx --yes --package @playwright/cli playwright-cli close
npx --yes --package @playwright/cli playwright-cli snapshot
npx --yes --package @playwright/cli playwright-cli click e3
npx --yes --package @playwright/cli playwright-cli dblclick e7
npx --yes --package @playwright/cli playwright-cli type "search terms"
npx --yes --package @playwright/cli playwright-cli press Enter
npx --yes --package @playwright/cli playwright-cli fill e5 "user@example.com"
npx --yes --package @playwright/cli playwright-cli drag e2 e8
npx --yes --package @playwright/cli playwright-cli hover e4
npx --yes --package @playwright/cli playwright-cli select e9 "option-value"
npx --yes --package @playwright/cli playwright-cli upload ./document.pdf
npx --yes --package @playwright/cli playwright-cli check e12
npx --yes --package @playwright/cli playwright-cli uncheck e12
npx --yes --package @playwright/cli playwright-cli eval "document.title"
npx --yes --package @playwright/cli playwright-cli eval "el => el.textContent" e5
npx --yes --package @playwright/cli playwright-cli dialog-accept
npx --yes --package @playwright/cli playwright-cli dialog-accept "confirmation text"
npx --yes --package @playwright/cli playwright-cli dialog-dismiss
npx --yes --package @playwright/cli playwright-cli resize 1920 1080
```

## Navigation

```bash
npx --yes --package @playwright/cli playwright-cli go-back
npx --yes --package @playwright/cli playwright-cli go-forward
npx --yes --package @playwright/cli playwright-cli reload
```

## Keyboard

```bash
npx --yes --package @playwright/cli playwright-cli press Enter
npx --yes --package @playwright/cli playwright-cli press ArrowDown
npx --yes --package @playwright/cli playwright-cli keydown Shift
npx --yes --package @playwright/cli playwright-cli keyup Shift
```

## Mouse

```bash
npx --yes --package @playwright/cli playwright-cli mousemove 150 300
npx --yes --package @playwright/cli playwright-cli mousedown
npx --yes --package @playwright/cli playwright-cli mousedown right
npx --yes --package @playwright/cli playwright-cli mouseup
npx --yes --package @playwright/cli playwright-cli mouseup right
npx --yes --package @playwright/cli playwright-cli mousewheel 0 100
```

## Save as

```bash
npx --yes --package @playwright/cli playwright-cli screenshot
npx --yes --package @playwright/cli playwright-cli screenshot e5
npx --yes --package @playwright/cli playwright-cli pdf
```

## Tabs

```bash
npx --yes --package @playwright/cli playwright-cli tab-list
npx --yes --package @playwright/cli playwright-cli tab-new
npx --yes --package @playwright/cli playwright-cli tab-new https://example.com/page
npx --yes --package @playwright/cli playwright-cli tab-close
npx --yes --package @playwright/cli playwright-cli tab-close 2
npx --yes --package @playwright/cli playwright-cli tab-select 0
```

## DevTools

```bash
npx --yes --package @playwright/cli playwright-cli console
npx --yes --package @playwright/cli playwright-cli console warning
npx --yes --package @playwright/cli playwright-cli network
npx --yes --package @playwright/cli playwright-cli run-code "await page.waitForTimeout(1000)"
npx --yes --package @playwright/cli playwright-cli tracing-start
npx --yes --package @playwright/cli playwright-cli tracing-stop
```

## Sessions

Use a named session to isolate work:

```bash
npx --yes --package @playwright/cli playwright-cli --session todo open https://demo.playwright.dev/todomvc
npx --yes --package @playwright/cli playwright-cli --session todo snapshot
```
