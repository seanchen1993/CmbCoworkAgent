import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Run with npx tsx tests/git-branch-scroll-range-browser.spec.ts.
async function main(): Promise<void> {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import { createRoot } from "react-dom/client"
import { GitBranchSwitcher } from "./src/renderer/src/components/chat/GitBranchSwitcher"

const readPage = offset => {
  const end = Math.min(offset + 20000, 950000)
  const next = end < 950000 ? { snapshot: 1, offset: end } : undefined
  return {
    local: Array.from({ length: end - offset }, (_, index) => "bulk-" + (offset + index)).join("\\n"),
    remote: next ? "" : "origin/first\\norigin/last",
    next
  }
}
window.api = { git: {
  currentBranch: async () => ({
    isGitRepo: true, branch: "bulk-0", isWorktree: false, isInsideWorkTree: true
  }),
  listBranchMenu: async (_, { paged }) => {
    if (!paged) throw new Error("Expected a paged branch list")
    return { success: true, branch: "bulk-0", ...readPage(0) }
  },
  readBranchMenuPage: async ({ offset }) => readPage(offset),
  getChangedFileCount: async () => 0,
  cancelBranchList: async () => {},
  cancelBranchProbe: async () => {},
  switchBranch: async (branch, cwd, kind) => {
    window.checkout = { branch, cwd, kind }
    return { success: true, branch, headChanged: true }
  }
} }
createRoot(document.getElementById("root")).render(
  <GitBranchSwitcher workspacePath="/repo" environmentRailCollapsed={false} />
)
`
    },
    alias: { "@": resolve("src/renderer/src") },
    bundle: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage()
    const pageErrors: Error[] = []
    page.on("pageerror", (error) => pageErrors.push(error))
    page.setDefaultTimeout(15000)
    await page.setContent('<main id="root" style="margin:100px"></main>')
    await page.addStyleTag({ path: resolve("src/renderer/src/components/chat/git-branch-menu.css") })
    await page.addStyleTag({ content: `
      [aria-label="分支列表"] { overflow-y: auto }
      [data-branch-choice] { display: block; width: 100% }
    ` })
    await page.addScriptTag({ content: outputFiles[0].text })
    await page.getByRole("button", { name: "切换 Git 分支" }).click()

    const search = page.getByRole("textbox", { name: "搜索分支" })
    const list = page.getByRole("region", { name: "分支列表" })
    const first = list.getByRole("button", { name: "bulk-0", exact: true })
    const last = list.getByRole("button", { name: "origin/last", exact: true })
    await first.waitFor()
    await search.press("ArrowDown")
    assert.equal(await first.evaluate((node) => node === document.activeElement), true)
    await page.keyboard.press("ArrowUp")
    assert.equal(await last.evaluate((node) => node === document.activeElement), true)
    await page.keyboard.press("ArrowDown")
    assert.equal(await first.evaluate((node) => node === document.activeElement), true)

    await list.evaluate((node) => { node.scrollTop = node.scrollHeight / 2 })
    await page.waitForFunction(() => {
      const list = document.querySelector('[aria-label="分支列表"]')
      if (!list) return false
      const { x, y, width, height } = list.getBoundingClientRect()
      const branch = document.elementFromPoint(x + width / 2, y + height / 2)
        ?.closest("[data-branch-index]")?.getAttribute("data-branch-index")
      const index = Number(branch)
      return index > 470000 && index < 480000
    })
    await list.hover()
    await page.mouse.wheel(0, 20_000_000)
    const lastLocal = list.getByRole("button", { name: "bulk-949999", exact: true })
    await lastLocal.waitFor()
    assert.equal(await lastLocal.evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(x + width / 2, y + height / 2))
    }), true)
    assert.ok(await list.getByRole("button").count() < 30)
    await lastLocal.click()
    assert.deepEqual(await page.evaluate("window.checkout"), {
      branch: "bulk-949999", cwd: "/repo", kind: "local"
    })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
