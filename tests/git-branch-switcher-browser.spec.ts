import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React from "react"
        import {createRoot} from "react-dom/client"
        import {GitBranchSwitcher} from "./src/renderer/src/components/chat/GitBranchSwitcher"
        const pending=[], lists=[], switches=[], notices=[]
        window.addEventListener("cmb:git-branch-switched",event=>notices.push(event.detail))
        window.api={git:{
          currentBranch:cwd=>new Promise((resolve,reject)=>pending.push({cwd,resolve,reject})),
          listBranches:cwd=>new Promise((resolve,reject)=>lists.push({cwd,resolve,reject})),
          switchBranch:(branch,cwd)=>new Promise((resolve,reject)=>switches.push({cwd,branch,resolve,reject}))
        }}
        const root=createRoot(document.getElementById("root"))
        window.fixture={
          render:workspacePath=>root.render(<GitBranchSwitcher workspacePath={workspacePath} environmentRailCollapsed={false}/>),
          pending:()=>pending.map(row=>row.cwd??null),
          finish:(index,value)=>pending[index].resolve(value),
          fail:index=>pending[index].reject(Error("old workspace failed")),
          listCount:()=>lists.length,
          listFinish:(index,value)=>lists[index].resolve(value),
          switchCount:()=>switches.length,
          switchFinish:index=>switches[index].resolve({success:true}),
          switchFail:index=>switches[index].reject(Error("stale switch failed")),
          listFail:index=>lists[index].reject(Error("stale list failed")),
          notices:()=>notices,
          unmount:()=>root.unmount()
        }
      `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    alias: { "@": resolve("src/renderer/src") }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    for (const scenario of ["late-success", "late-error", "multi-repository", "unmount"] as const) {
      const page = await browser.newPage()
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.evaluate(() => window.fixture.render(undefined))
      await page.waitForFunction(() => window.fixture.pending().length === 1)
      if (scenario === "unmount") {
        await page.evaluate(() => {
          window.fixture.unmount()
          window.fixture.finish(0, {
            isGitRepo: true,
            isMultiRepo: true,
            repositories: [{ path: "old/sub", displayPath: "sub", gitRoot: "old/sub" }]
          })
        })
        await page.waitForTimeout(100)
        assert.equal(
          await page.evaluate(() => window.fixture.pending().length),
          1,
          "unmounted detection must not start child repository reads"
        )
        console.log("PASS unmount")
        await page.close()
        continue
      }
      if (scenario === "multi-repository") {
        await page.evaluate(() =>
          window.fixture.finish(0, {
            isGitRepo: true,
            isMultiRepo: true,
            repositories: [{ path: "old/sub", displayPath: "sub", gitRoot: "old/sub" }]
          })
        )
        await page.waitForFunction(() => window.fixture.pending().length === 2)
      }
      await page.evaluate(() => window.fixture.render("owned"))
      const ownedIndex = scenario === "multi-repository" ? 2 : 1
      await page.waitForFunction(
        (index) => window.fixture.pending().length === index + 1,
        ownedIndex
      )
      await page.evaluate(
        (index) =>
          window.fixture.finish(index, {
            isGitRepo: true,
            branch: "master",
            isWorktree: false
          }),
        ownedIndex
      )
      await page.getByRole("button", { name: "master", exact: true }).waitFor()
      await page.evaluate((scenario) => {
        if (scenario === "late-error") window.fixture.fail(0)
        else
          window.fixture.finish(scenario === "multi-repository" ? 1 : 0, {
            isGitRepo: true,
            branch: "codex/mods-v2",
            isWorktree: false
          })
      }, scenario)
      await page.waitForTimeout(100)
      assert.equal(
        await page.getByRole("button", { name: "master", exact: true }).count(),
        1,
        scenario + " must preserve the current workspace branch"
      )
      console.log("PASS " + scenario)
      await page.close()
    }
    for (const scenario of [
      "stale-list",
      "stale-switch",
      "stale-list-error",
      "stale-switch-error"
    ] as const) {
      const page = await browser.newPage()
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.evaluate(() => window.fixture.render("old"))
      await page.waitForFunction(() => window.fixture.pending().length === 1)
      await page.evaluate(() =>
        window.fixture.finish(0, {
          isGitRepo: true,
          branch: "old-main",
          isWorktree: false
        })
      )
      await page.getByRole("button", { name: "old-main", exact: true }).click()
      await page.waitForFunction(() => window.fixture.listCount() === 1)
      if (scenario.startsWith("stale-switch")) {
        await page.evaluate(() =>
          window.fixture.listFinish(0, { success: true, branches: ["target"] })
        )
        await page.getByRole("button", { name: "target", exact: true }).click()
        await page.waitForFunction(() => window.fixture.switchCount() === 1)
      }
      await page.evaluate(() => window.fixture.render("owned"))
      await page.waitForFunction(() => window.fixture.pending().length === 2)
      await page.evaluate(() =>
        window.fixture.finish(1, {
          isGitRepo: true,
          branch: "master",
          isWorktree: false
        })
      )
      await page.getByRole("button", { name: "master", exact: true }).click()
      await page.waitForFunction(() => window.fixture.listCount() >= 2)
      await page.evaluate(() =>
        window.fixture.listFinish(window.fixture.listCount() - 1, {
          success: true,
          branches: ["owned-target"]
        })
      )
      await page.getByRole("button", { name: "owned-target", exact: true }).waitFor()
      await page.evaluate((scenario) => {
        if (scenario === "stale-list")
          window.fixture.listFinish(0, { success: true, branches: ["stale-target"] })
        else if (scenario === "stale-list-error") window.fixture.listFail(0)
        else if (scenario === "stale-switch-error") window.fixture.switchFail(0)
        else window.fixture.switchFinish(0)
      }, scenario)
      await page.waitForTimeout(100)
      assert.equal(
        await page.getByRole("button", { name: "owned-target", exact: true }).count(),
        1,
        scenario + " must not replace current options or close current UI"
      )
      assert.equal(
        await page.evaluate(() => window.fixture.pending().length),
        2,
        "old switch must not start a detection against the old cwd"
      )
      if (scenario === "stale-switch")
        assert.deepEqual(
          await page.evaluate(() => window.fixture.notices()),
          [{ workspacePath: "old", branch: "target" }],
          "completed operation still notifies its actual workspace"
        )
      console.log("PASS " + scenario)
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

interface BranchFixture {
  render(path: string | undefined): void
  pending(): (string | null)[]
  finish(index: number, value: Record<string, unknown>): void
  fail(index: number): void
  listCount(): number
  listFinish(index: number, value: Record<string, unknown>): void
  switchCount(): number
  switchFinish(index: number): void
  switchFail(index: number): void
  listFail(index: number): void
  notices(): { workspacePath: string; branch: string }[]
  unmount(): void
}
declare global {
  interface Window {
    fixture: BranchFixture
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
