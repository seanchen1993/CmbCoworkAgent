/** Real React controls; native authority is covered separately by IPC/manager/Guest tests. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = process.cwd()
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
    import React from "react"
    import {createRoot} from "react-dom/client"
    import {CreatorPlanningPanel} from "./src/renderer/src/components/customize/CreatorPlanningPanel"
    const a={pluginId:"a",name:"review-first",digest:"a".repeat(64)}
    const b={pluginId:"b",name:"compose-first",digest:"b".repeat(64)}
    let status={revision:0,state:"native"}, listener=()=>{}
    window.actions=[]
    const api={onChanged:cb=>{listener=cb;return()=>{}},
      planningCatalog:async()=>({status,candidates:[{...a,state:"ready"},{...b,state:"ready"}]}),
      selectPlanning:async input=>{
        if(input.expectedRevision!==status.revision)throw Error("stale")
        window.actions.push(input)
        status={revision:status.revision+1,state:input.selected?"ready":"native",...(input.selected?{selected:input.selected}:{})}
        return api.planningCatalog()
      }}
    window.fail=()=>{status={...status,state:"fallback",diagnostic:"策略已损坏，使用原生创造者。停止、安装核对和恢复仍可用。"};listener({threadId:"thread"})}
    createRoot(document.getElementById("root")).render(<main>
      <button onClick={()=>window.actions.push("stop")}>停止试用</button>
      <button onClick={()=>window.actions.push("inspect")}>核对安装</button>
      <button onClick={()=>window.actions.push("resume")}>恢复试用</button>
      <CreatorPlanningPanel api={api} threadId="thread" workspace="workspace" />
    </main>)
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.addScriptTag({ content: "window.__name = value => value" })
    const select = page.getByLabel("可选规划 Mod", { exact: true })
    await page.getByRole("button", { name: "验证并使用所选规划", exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll("select option").length === 3)
    const options = await select.locator("option").allTextContents()
    assert(
      options.filter((option) => option.includes("使用前验证规划接点")).length === 2,
      JSON.stringify(options)
    )
    await select.selectOption({ label: options[1] })
    await page.getByRole("button", { name: "验证并使用所选规划", exact: true }).click()
    await select.selectOption({ label: options[2] })
    await page.getByRole("button", { name: "验证并使用所选规划", exact: true }).click()
    await page.evaluate(() => (window as unknown as { fail(): void }).fail())
    await page
      .getByText("策略已损坏，使用原生创造者。停止、安装核对和恢复仍可用。", { exact: true })
      .waitFor()
    for (const name of ["停止试用", "核对安装", "恢复试用"]) {
      assert(await page.getByRole("button", { name, exact: true }).isEnabled())
      await page.getByRole("button", { name, exact: true }).click()
    }
    await page.getByRole("button", { name: "撤回策略，使用原生规划", exact: true }).click()
    await page.waitForFunction(
      () => (document.querySelector("select") as HTMLSelectElement)?.value === ""
    )
    const actions = await page.evaluate(() => (window as unknown as { actions: unknown[] }).actions)
    assert.equal((actions[0] as { selected: { pluginId: string } }).selected.pluginId, "a")
    assert.equal((actions[1] as { selected: { pluginId: string } }).selected.pluginId, "b")
    assert.deepEqual(actions.slice(2, 5), ["stop", "inspect", "resume"])
    assert.equal((actions[5] as { selected: unknown }).selected, null)
    assert.deepEqual(errors, [])
    console.log(
      "PASS actual creator planning controls: explicit selection, replacement, fallback, independent recovery and withdrawal"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
