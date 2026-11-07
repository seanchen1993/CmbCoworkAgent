import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Exercise the actual renderer entry and tray component: a source-order assertion
// cannot establish that a failing effect leaves a usable recovery screen.
async function main(): Promise<void> {
  const root = process.cwd()
  const bundle = await build({
    entryPoints: [resolve("src/renderer/src/main.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "isolated-app-content",
        setup(builder) {
          builder.onResolve(
            { filter: /^(\.\/App|\.\/lib\/console-gate|\.\/lib\/theme-preference)$/ },
            ({ path }) => ({ path, namespace: "fixture" })
          )
          builder.onResolve({ filter: /\.css$/ }, ({ path }) => ({ path, namespace: "fixture" }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "tsx",
            resolveDir: root,
            contents:
              path === "./App"
                ? `export default function App() {
                  if(window.fixtureMode === "app-failure") throw new Error("App fixture failure")
                  return <div>Application ready</div>
                }`
                : path.endsWith("theme-preference")
                  ? "export function initializeThemePreference() {}"
                  : ""
          }))
        }
      }
    ],
    logLevel: "silent"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    for (const mode of ["normal", "missing-bridge", "subscription-failure", "app-failure"]) {
      const page = await browser.newPage()
      await page.setContent('<div id="root"></div>')
      await page.evaluate((fixtureMode) => {
        Object.assign(window, { fixtureMode, responses: [] })
        if (fixtureMode !== "missing-bridge") {
          Object.assign(window, {
            electron: {
              onCloseToTrayPrompt(callback: unknown) {
                if (fixtureMode === "subscription-failure")
                  throw new Error("Bridge subscription failed")
                Object.assign(window, { closeCallback: callback })
                return () => {}
              },
              respondCloseToTrayPrompt(...args: unknown[]) {
                const fixture = window as unknown as { responses: unknown[][] }
                fixture.responses.push(args)
              }
            }
          })
        }
      }, mode)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      if (mode === "normal") {
        await page.getByText("Application ready", { exact: true }).waitFor()
        assert.equal(await page.getByRole("alert").count(), 0)
      } else {
        await page.getByRole("heading", { name: "界面渲染失败" }).waitFor()
        assert.equal(await page.getByRole("button", { name: "重新加载", exact: true }).count(), 1)
        assert.equal(await page.getByRole("button", { name: "关闭窗口", exact: true }).count(), 1)
        assert.notEqual(await page.locator("#root").textContent(), "")
      }
      if (mode === "normal" || mode === "app-failure") {
        await page.evaluate(() => {
          const fixture = window as unknown as { closeCallback: (event: unknown) => void }
          fixture.closeCallback({
            type: "open",
            requestId: 7,
            reason: "tray-unavailable",
            trayAreaName: "系统托盘",
            canMinimizeToTray: false,
            rememberChoiceAllowed: false
          })
        })
        await page.getByRole("button", { name: /退出应用/ }).click()
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as { responses: unknown[][] }).responses),
          [[7, "direct-close", false]]
        )
      }
      await page.close()
      console.log(`PASS renderer entry boundary: ${mode}`)
    }
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
