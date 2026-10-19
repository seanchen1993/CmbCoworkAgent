/** Actual React native consent; persistence/compiler/VM and IPC have independent real tests. */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: {
      loader: "tsx",
      resolveDir: resolve(__dirname, ".."),
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectFunctionConsent} from './src/renderer/src/components/harness-board/ProjectFunctionConsent';
      const root=createRoot(document.getElementById('root'));let version=1,pending,epoch=0;
      const calls=[],ready=[];const review=projectId=>({projectId,projectVersion:version,packageDigest:'a'.repeat(64),workspace:'C:/private/'+projectId,
        source:{name:'actual-native-name',digest:'b'.repeat(64),state:'needs-approval',capabilities:['tool.call','fs.write'],scannedMethods:['tool.call'],scanIncomplete:false}});
      window.api={harnessBoard:{localProjects:{mods:{read:async projectId=>review(projectId),approve:input=>{calls.push(input);return new Promise(resolve=>pending=()=>resolve({...review(input.projectId),source:{...review(input.projectId).source,state:'ready'}}))}}}}};
      const show=id=>root.render(<React.StrictMode><ProjectFunctionConsent key={++epoch} projectId={id} version={version} onReady={value=>ready.push([id,value])}/></React.StrictMode>);
      window.fixture={calls,ready,show,bump:()=>{version++;show('A')},resolve:()=>pending()};show('A');
    `
    }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    const page = await browser.newPage(),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const approve = page.getByRole("button", { name: "确认本包灵件权限", exact: true })
    await approve.waitFor()
    assert(await approve.isDisabled())
    await page.getByText("本包灵件：actual-native-name", { exact: true }).waitFor()
    await page.getByRole("checkbox").check()
    assert(await approve.isEnabled())
    await page.evaluate("window.fixture.bump()")
    await page.waitForFunction("!document.querySelector('input').checked")
    assert(
      await approve.isDisabled(),
      "New project version cannot inherit unchecked native consent"
    )
    await page.getByRole("checkbox").check()
    await approve.evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal(await page.evaluate("window.fixture.calls.length"), 1)
    assert.deepEqual(await page.evaluate("window.fixture.calls[0]"), {
      projectId: "A",
      projectVersion: 2,
      packageDigest: "a".repeat(64),
      compiledDigest: "b".repeat(64)
    })
    await page.evaluate("window.fixture.show('B')")
    await page.getByText("授权目录：C:/private/B", { exact: true }).waitFor()
    await page.evaluate("window.fixture.resolve()")
    await page.waitForTimeout(80)
    assert.equal(await page.getByText("此目录已授权当前源码版本。", { exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.fixture.ready.filter(([id,value])=>id==='B'&&value).length"),
      0
    )
    await page.getByRole("checkbox").check()
    await approve.click()
    await page.evaluate("window.fixture.resolve()")
    await page.getByText("此目录已授权当前源码版本。", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "PASS exact native package source/directory/permission consent, version invalidation, double-click and delayed cross-project fencing"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
