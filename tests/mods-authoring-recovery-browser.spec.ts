import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
interface RecoveryFixture {
  calls: Array<[string, Record<string, unknown>?]>
  different(value: boolean): void
  preparation(value: string): void
  show(): void
}
type RecoveryWindow = Window & { fixture: RecoveryFixture }

async function main() {
  const output = resolve("output/mods-harness-20261009", `authoring-recovery-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const stage = process.env.CREATOR_RECOVERY_STAGE
    ? resolve(process.env.CREATOR_RECOVERY_STAGE)
    : process.cwd()
  const install = resolve(stage, "src/renderer/src/components/customize/AuthoringRecoveryPanel.tsx")
  const prepare = resolve(
    stage,
    "src/renderer/src/components/customize/AuthoringPreparationRecovery.tsx"
  )
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import{createRoot}from"react-dom/client";
    import{AuthoringRecoveryPanel}from${JSON.stringify(install)};
    import{AuthoringPreparationRecovery}from${JSON.stringify(prepare)};
    const root=createRoot(document.getElementById("root")),calls=[];
    let different=false,key=0,preparation="live";
    const api={inspectUncertain:async input=>{calls.push(["inspect",input]);return{ok:true,value:{operationId:"op",installationId:"installation",originalState:"unknown",catalog:different?"different":"after",configuration:"different",observedVersionId:"observed-current-version",inspectionDigest:"a".repeat(64),canAccept:!different}}},
      reconcile:async input=>{calls.push(["reconcile",input]);return{ok:true,value:{state:"reconciled",operationId:"op"}}},
      inspectPreparation:async input=>{calls.push(["inspect-preparation",input]);return{ok:true,value:{state:preparation,canRecover:preparation==="stale",fingerprint:"b".repeat(64)}}},
      recoverPreparation:async input=>{calls.push(["recover-preparation",input]);return{ok:true,value:{state:"recovered",versionId:"version",preserved:"quarantine"}}}};
    const show=()=>root.render(<main style={{maxWidth:720,margin:"16px auto",padding:16}}><h1>创作者模式 · 中断核对</h1><AuthoringRecoveryPanel key={++key} api={api} threadId="thread" workspace="project" operationId="op" onReconciled={()=>calls.push(["accepted"])}/><AuthoringPreparationRecovery key={"prepare"+key} api={api} threadId="thread" workspace="project"/></main>);
    window.fixture={calls,show,different:value=>different=value,preparation:value=>preparation=value};show();
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const checks: string[] = []
  try {
    await page.setContent('<div id="root"></div>')
    const css = readdirSync(resolve("out/renderer/assets")).find((name) =>
      /^index-.*\.css$/.test(name)
    )
    if (css)
      await page.addStyleTag({ content: readFileSync(resolve("out/renderer/assets", css), "utf8") })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const calls = () => page.evaluate(() => (window as unknown as RecoveryWindow).fixture.calls)
    assert.equal((await calls()).length, 0)
    checks.push("no automatic inspection or repair")
    await page.getByRole("button", { name: "查看上次中断的结果", exact: true }).click()
    await page.getByText("observed-current-version", { exact: false }).waitFor()
    assert.equal((await calls()).filter((row) => row[0] === "reconcile").length, 0)
    await page.screenshot({ path: join(output, "recovery-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(output, "recovery-narrow.png") })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    checks.push("exact observed version and config warning, narrow viewport")
    await page.getByRole("button", { name: "确认保留当前状态", exact: true }).click()
    await page.getByText("原中断记录仍保留", { exact: false }).waitFor()
    const accepted = (await calls()).find((row) => row[0] === "reconcile")
    assert.equal(accepted?.[1]?.expectedInspectionDigest, "a".repeat(64))
    checks.push("explicit acceptance binds exact observation")
    await page.evaluate(() => {
      ;(window as unknown as RecoveryWindow).fixture.different(true)
      ;(window as unknown as RecoveryWindow).fixture.show()
    })
    await page.getByRole("button", { name: "查看上次中断的结果", exact: true }).click()
    assert(
      await page.getByRole("button", { name: "确认保留当前状态", exact: true }).isDisabled()
    )
    checks.push("divergent catalog cannot be accepted")
    await page.getByText("安装准备卡住了？", { exact: true }).click()
    await page.getByRole("button", { name: "检查上次准备的状态", exact: true }).click()
    await page.getByText("安装文件还在准备中，请稍候。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "保留文件，允许重新准备", exact: true }).count(),
      0
    )
    await page.evaluate(() => (window as unknown as RecoveryWindow).fixture.preparation("stale"))
    await page.getByRole("button", { name: "检查上次准备的状态", exact: true }).click()
    await page.getByRole("button", { name: "保留文件，允许重新准备", exact: true }).click()
    await page.getByText("准备占用已释放。", { exact: false }).waitFor()
    assert.equal(
      (await calls()).find((row) => row[0] === "recover-preparation")?.[1]?.expectedFingerprint,
      "b".repeat(64)
    )
    checks.push("live preparation cannot be stolen; stale recovery is explicit")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
    console.log(`PASS ${checks.length} creator recovery browser checks: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
