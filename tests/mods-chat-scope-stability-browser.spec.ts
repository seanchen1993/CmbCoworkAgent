/** Actual scope hook/context; no model, user database or native grants. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

declare global {
  interface Window {
    scopeFixture: {
      bump(): void
      count(): number
      reads: string[]
      changeWorkspace(): void
      returnWorkspace(): void
      firstCurrent(): boolean
      oldCurrent(): boolean
      revoke(): boolean
    }
  }
}

async function main() {
  const output = resolve("output/chat-interaction-performance", process.env.PERF_LABEL ?? "scope")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    await page.addInitScript("globalThis.__name=(value)=>value")
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {memo,useContext,useMemo} from 'react';
      import {ModsChatScope,useModsChatState} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      {let renders=0,notify,oldCurrent,firstCurrent;const reads=[];
      window.api.mods.onConfigurationChanged=fn=>{notify=fn;return()=>{}};
      window.api.mods.onCardsChanged=()=>()=>{};
      window.api.mods.chatDisplayCapability=async(thread,workspace)=>{reads.push(workspace);return true};
      const Consumer=memo(function Consumer(){const scope=useContext(ModsChatScope);renders++;return <output data-ready={scope.ready}>{scope.threadId}</output>});
      function Fixture(){const [workspace,setWorkspace]=useState('C:/scope-A'),[tick,setTick]=useState(0),state=useModsChatState('scope-thread',workspace);
        const value=useMemo(()=>({threadId:'scope-thread',...state}),[state]);
        window.scopeFixture={bump:()=>setTick(n=>n+1),count:()=>renders,reads,
          changeWorkspace:()=>{oldCurrent=firstCurrent=state.isCurrent;setWorkspace('C:/scope-B')},oldCurrent:()=>oldCurrent(),firstCurrent:()=>firstCurrent(),returnWorkspace:()=>setWorkspace('C:/scope-A'),
          revoke:()=>{oldCurrent=state.isCurrent;notify({scope:'configuration'});return oldCurrent()}};
        return <ModsChatScope.Provider value={value}><span hidden>{tick}</span><Consumer/></ModsChatScope.Provider>}
      host.render(<Fixture/>)}
    `
    )
    await page.locator('[data-ready="true"]').waitFor()
    const before = await page.evaluate(() => window.scopeFixture.count())
    for (let i = 0; i < 30; i++)
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            window.scopeFixture.bump()
            requestAnimationFrame(() => done())
          })
      )
    const after = await page.evaluate(() => window.scopeFixture.count())
    await page.evaluate(() => window.scopeFixture.changeWorkspace())
    await page.waitForFunction(() => window.scopeFixture.reads.includes("C:/scope-B"))
    await page.locator('[data-ready="true"]').waitFor()
    assert.equal(await page.evaluate(() => window.scopeFixture.oldCurrent()), false)
    const afterWorkspace = await page.evaluate(() => window.scopeFixture.count())
    assert(afterWorkspace > after, "Workspace replacement must publish a new context")
    assert.equal(
      await page.evaluate(() => window.scopeFixture.revoke()),
      false,
      "Configuration revocation must invalidate the captured closure synchronously"
    )
    await page.locator('[data-ready="true"]').waitFor()
    const afterConfiguration = await page.evaluate(() => window.scopeFixture.count())
    assert(afterConfiguration > afterWorkspace)
    await page.evaluate(() => window.scopeFixture.returnWorkspace())
    await page.waitForFunction(
      () => window.scopeFixture.reads.filter((value) => value === "C:/scope-A").length === 2
    )
    await page.locator('[data-ready="true"]').waitFor()
    assert.equal(
      await page.evaluate(() => window.scopeFixture.firstCurrent()),
      false,
      "Returning to the first directory must not revive its old permission closure"
    )
    assert.deepEqual(errors, [])
    const result = {
      before,
      after,
      unrelatedConsumerRenders: after - before,
      afterWorkspace,
      afterConfiguration,
      errors
    }
    writeFileSync(join(output, "scope-stability.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
    assert.equal(after, before, "Unrelated parent updates must not broadcast the scope context")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
