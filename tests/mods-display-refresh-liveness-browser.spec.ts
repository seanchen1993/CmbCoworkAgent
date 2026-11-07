/** Real hooks: progress during congestion, and no retired source reply after invalidation. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {useModCommands} from ${JSON.stringify(resolve("src/renderer/src/features/slash-commands/useModCommands.ts"))};
      import {useFunctionTurnNotices} from ${JSON.stringify(resolve("src/renderer/src/lib/use-function-turn-notices.ts"))};
      import {useFunctionPlacedRows} from ${JSON.stringify(resolve("src/renderer/src/lib/use-function-placed-rows.ts"))};
      import {publishFunctionDesktopOwner} from ${JSON.stringify(resolve("src/renderer/src/lib/function-desktop-owner.ts"))};
      {const listeners=new Set(),waiting=[];let text="initial",hold=false;
      const read=async kind=>{const value=[{id:text,requestId:text,command:text,name:text,text}];
        if(hold)await new Promise(done=>waiting.push({kind,done}));return value};
      window.api.mods.commands=()=>read("commands");
      window.api.mods.turnNotices=()=>read("notices");
      window.api.mods.placedRows=()=>read("placed");
      window.api.mods.onCardsChanged=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      window.api.mods.onJobsChanged=()=>()=>{};
      const current=()=>true;
      function Fixture(){const commands=useModCommands("a",true),notices=useFunctionTurnNotices("a",true),
        placed=useFunctionPlacedRows("a",true,current);
        return <div data-result>{JSON.stringify([commands.items.map(x=>x.title),notices.map(x=>x.text),placed.map(x=>x.requestId)])}</div>}
      publishFunctionDesktopOwner("a","owner");
      window.fixture={hold:value=>{text=value;hold=true},waiting:()=>waiting.length,
        emit:scope=>{for(const fn of listeners)fn({threadId:"a",scope})},
        release:()=>{for(const item of waiting.splice(0))item.done()},
        close:()=>host.unmount()};
      host.render(<Fixture/>);}
    `
    )
    await page.waitForFunction(
      () =>
        document.querySelector("[data-result]")?.textContent ===
        '[["initial"],["initial"],["initial"]]'
    )
    await page.evaluate("window.fixture.hold('retired');window.fixture.emit()")
    await page.waitForFunction("window.fixture.waiting() === 3")
    await page.evaluate("window.fixture.hold('current');window.fixture.emit('source-retiring:1')")
    await page.waitForFunction(
      () => document.querySelector("[data-result]")?.textContent === "[[],[],[]]"
    )
    await page.evaluate("window.fixture.release()")
    await page.waitForFunction("window.fixture.waiting() === 3")
    assert.equal(await page.locator("[data-result]").textContent(), "[[],[],[]]")
    await page.evaluate("window.fixture.release()")
    await page.waitForFunction(
      () =>
        document.querySelector("[data-result]")?.textContent ===
        '[["current"],["current"],["current"]]'
    )
    // No quiet interval: every pending placed/notices response gets a new content update.
    for (let i = 0; i < 20; i++) {
      await page.evaluate((n) => {
        const f = (
          window as unknown as {
            fixture: {
              hold(value: string): void
              emit(scope: string): void
              release(): void
            }
          }
        ).fixture
        f.hold(String(n))
        f.emit("placed")
        f.emit("records")
      }, i)
      await page.waitForFunction("window.fixture.waiting() === 2")
      await page.evaluate(
        "window.fixture.emit('placed');window.fixture.emit('records');window.fixture.release()"
      )
      await page.waitForFunction(
        (n) =>
          document.querySelector("[data-result]")?.textContent ===
          JSON.stringify([["current"], [String(n)], [String(n)]]),
        i
      )
      await page.evaluate("window.fixture.release()")
    }
    await page.evaluate("window.fixture.close()")
    assert.deepEqual(errors, [])
    console.log(
      "PASS real command/notice/placed hooks reject revoked replies and retain progress during updates"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
