import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  try {
    await mount(page, `
      import {FunctionPresentation} from ${JSON.stringify(resolve("src/renderer/src/lib/function-presentation.ts"))};
      const region=document.createElement('main');region.dataset.chatThreadId='layout';
      for(let n=0;n<64;n++){
        const pane=document.createElement('section');pane.dataset.functionPaneKey='pane-'+n;
        pane.dataset.functionPaneGeneration='generation';pane.textContent='Pane '+n;region.append(pane)
      }
      document.getElementById('root').append(region);
      let scans=0;const reports=[],base=Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll=function(selector){if(this===region&&selector==='[data-function-pane-key]')scans++;return base.call(this,selector)};
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.desktopFeedback=async()=>({receipt:'receipt',entries:[]});
      window.api.mods.desktopPresent=async report=>reports.push(report);
      const presentation=new FunctionPresentation('layout','owner',()=>region,Promise.resolve());
      window.layoutProbe={reports,reset:()=>scans=0,scans:()=>scans,close:()=>presentation.close()};
    `, [browserWorkerPlugin()])
    await page.waitForFunction("window.layoutProbe.reports.length>0")
    await page.evaluate("window.layoutProbe.reset()")
    const samples = await page.evaluate(async () => {
      const times: number[] = []
      for (let n = 0; n < 20; n++) {
        const start = performance.now()
        window.dispatchEvent(new Event("resize"))
        await new Promise<void>(done => requestAnimationFrame(() => done()))
        times.push(performance.now() - start)
      }
      return times
    })
    const scans = await page.evaluate<number>("window.layoutProbe.scans()")
    const report = { panes: 64, frames: 20, scans, samples }
    const output = resolve("output/mods-presentation-layout-performance-browser")
    mkdirSync(output, { recursive: true })
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert.equal(scans, 20, "Scan pane elements once per presentation, not once for every pane")
    assert.equal(await page.evaluate("window.layoutProbe.reports[0].panes.length"), 64)
    await page.evaluate("window.layoutProbe.close()")
    console.log("PASS 64-pane presentation preserves evidence with linear DOM collection")
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
