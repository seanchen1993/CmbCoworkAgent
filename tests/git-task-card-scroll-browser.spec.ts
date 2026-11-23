import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const renderer = join(root, "src/renderer/src")
  const stylesheet = readFileSync(join(renderer, "index.css"), "utf8").replace(
    /^@import "@fontsource[^\n]+\n/gm,
    ""
  )
  const styles = await compile(stylesheet, { base: renderer, onDependency: () => undefined })
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const css = styles.build(scanner.scan())
  const bundle = await build({
    entryPoints: [join(root, "tests/support/git-task-card-scroll-fixture.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  try {
    for (const mode of ["manual", "agent"]) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 680 } })
      try {
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.setContent(`<div id="root" data-commit-mode="${mode}"></div>`)
        await page.addStyleTag({ content: css })
        await page.addScriptTag({ content: bundle.outputFiles[0].text })

        await page.getByRole("button", { name: "选择任务卡片" }).click()
        await page.getByText("40 张可选", { exact: true }).waitFor()
        const popover = page.locator('[data-slot="popover-content"]')
        const list = popover.locator(".overflow-y-auto")
        const rows = list.getByRole("button")
        assert.match(await rows.first().innerText(), /^TASK-40/)
        assert(await list.evaluate((node) => node.scrollHeight > node.clientHeight))

        await list.hover()
        await page.mouse.wheel(0, 500)
        const listHandle = await list.elementHandle()
        await page.waitForFunction((node) => node.scrollTop > 0, listHandle, { timeout: 3000 })

        await page.mouse.wheel(0, -500)
        await page.waitForFunction((node) => node.scrollTop === 0, listHandle, { timeout: 3000 })

        await page.mouse.wheel(0, 3000)
        await page.waitForFunction(
          (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
          listHandle,
          { timeout: 3000 }
        )
        await rows.last().click()
        await page.getByRole("button", { name: /^TASK-01 ·/ }).waitFor()
        assert.deepEqual(errors, [])
        console.log(
          `PASS ${mode} Git commit task cards scroll with the wheel and remain selectable`
        )
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
