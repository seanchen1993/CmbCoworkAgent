import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {BotAvatar} from './src/renderer/src/components/bots/BotAvatar';
import {BotGroupAvatar} from './src/renderer/src/components/bots/BotGroupAvatar';
const root=createRoot(document.getElementById('root'));
let nextId=0,now=0; const frames=new Map();
window.requestAnimationFrame=fn=>{frames.set(++nextId,fn);return nextId};
window.cancelAnimationFrame=id=>frames.delete(id);
let visibility='visible';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
window.setFixtureVisibility=value=>{visibility=value;document.dispatchEvent(new Event('visibilitychange'))};
window.avatarFixture={paints:{},render(color='#123456',busy=false,animated=true){root.render(<><div data-probe='unchanged'><BotAvatar color='#ff2850' shape='flower'/></div><div data-probe='changed'><BotAvatar color={color} busy={busy} animated={animated}/></div></>)},renderGroup(){root.render(<><div data-probe='group'><BotGroupAvatar memberIds={['a','b']} bots={[{id:'a',color:'#123456',shape:'drop'},{id:'b',color:'#123456',shape:'flower'}]} userInitials='U'/></div><div data-probe='changed'><BotAvatar color='#00aabb' busy/></div></>)},step(count,interval=20){for(let i=0;i<count;i++){now+=interval;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(now)}},pending(){return frames.size},unmount(){root.unmount()}};
window.avatarFixture.render();`
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "count-real-svg-paints",
        setup(b) {
          b.onLoad({ filter: /grok-avatar-kernel\.js$/ }, (args) => ({
            contents: readFileSync(args.path, "utf8").replace(
              "function RE(e, t) {",
              `function RE(e, t) { const name=e.closest('[data-probe]')?.dataset.probe;if(name)window.avatarFixture.paints[name]=(window.avatarFixture.paints[name]??0)+1;`
            ),
            loader: "js"
          }))
        }
      }
    ]
  })
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(
      req.url === "/entry.js"
        ? bundle.outputFiles[0].text
        : '<div id="root"></div><script type="module" src="/entry.js"></script>'
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator("svg.bot-avatar").first().waitFor()
    await page.waitForTimeout(50)
    await page.evaluate(() => (window as any).avatarFixture.step(300))
    const before = await page.evaluate(() => ({ ...(window as any).avatarFixture.paints }))
    assert(before.unchanged > 0 && before.changed > 0, "real SVG paint is observed")
    await page.evaluate(() => (window as any).avatarFixture.render("#00aabb"))
    await page.waitForTimeout(50)
    await page.evaluate(() => (window as any).avatarFixture.step(2))
    const after = await page.evaluate(() => ({ ...(window as any).avatarFixture.paints }))
    assert.equal(
      after.unchanged,
      before.unchanged,
      "one avatar change must not repaint other settled avatars"
    )
    assert(after.changed > before.changed, "changed avatar is still painted")
    await page.evaluate(() => (window as any).avatarFixture.render("#00aabb", true))
    await page.waitForTimeout(50)
    const activeStart = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(120, 1000 / 120))
    const activePaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    assert(
      activePaints - activeStart >= 29 && activePaints - activeStart <= 31,
      "active SVG painting stays within 30 fps even on a 120 Hz display"
    )
    assert(
      (await page.evaluate(() => (window as any).avatarFixture.paints.changed)) > after.changed + 1,
      "active animation continues"
    )
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.paints.unchanged),
      before.unchanged
    )
    // Use Chromium's actual IntersectionObserver: a working face leaving the
    // viewport must stop drawing, then resume without changing its task state.
    await page.locator("#root").evaluate((node) => { node.style.marginTop = "2000px" })
    await page.waitForTimeout(100)
    await page.evaluate(() => (window as any).avatarFixture.step(10))
    const offscreenPaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(120))
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.paints.changed), offscreenPaints)
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.pending()), 0)
    await page.locator("#root").evaluate((node) => { node.style.marginTop = "0px" })
    await page.waitForTimeout(100)
    await page.evaluate(() => (window as any).avatarFixture.step(60))
    assert((await page.evaluate(() => (window as any).avatarFixture.paints.changed)) > offscreenPaints)

    // Window visibility is controlled input here, not a claim that the native
    // OS minimize/restore path was exercised by this component test.
    await page.evaluate(() => (window as any).setFixtureVisibility("hidden"))
    const hiddenPaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(120))
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.paints.changed), hiddenPaints)
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.pending()), 0)
    await page.evaluate(() => (window as any).setFixtureVisibility("visible"))
    await page.evaluate(() => (window as any).avatarFixture.step(60))
    assert((await page.evaluate(() => (window as any).avatarFixture.paints.changed)) > hiddenPaints)
    await page.evaluate(() => (window as any).avatarFixture.render("#00aabb", false))
    await page.waitForTimeout(50)
    await page.evaluate(() => (window as any).avatarFixture.step(300))
    const stoppedPaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(300))
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.paints.changed),
      stoppedPaints,
      "returning to idle settles the animation instead of continuing to paint"
    )
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.pending()), 0)
    await page.evaluate(() => (window as any).avatarFixture.render("#00aabb", true, false))
    await page.waitForTimeout(50)
    await page.evaluate(() => (window as any).avatarFixture.step(60))
    const staticPaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(300))
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.paints.changed),
      staticPaints,
      "a static working avatar does not keep painting"
    )
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.pending()), 0)
    await page.evaluate(() => (window as any).avatarFixture.renderGroup())
    await page.waitForTimeout(100)
    await page.evaluate(() => (window as any).avatarFixture.step(120))
    const groupShape = await page.locator("[data-probe='group']").innerHTML()
    const groupPaints = await page.evaluate(() => (window as any).avatarFixture.paints.group)
    const indicatorPaints = await page.evaluate(() => (window as any).avatarFixture.paints.changed)
    await page.evaluate(() => (window as any).avatarFixture.step(120))
    assert.equal(await page.locator("[data-probe='group']").innerHTML(), groupShape,
      "group identity stays fixed while the work indicator animates")
    assert.equal(await page.evaluate(() => (window as any).avatarFixture.paints.group), groupPaints)
    assert((await page.evaluate(() => (window as any).avatarFixture.paints.changed)) > indicatorPaints,
      "the separate working indicator retains its animation")
    await page.evaluate(() => (window as any).avatarFixture.unmount())
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.pending()),
      0,
      "leaving the page cancels the shared animation clock"
    )
    assert.equal(await page.locator("svg.bot-avatar").count(), 0)
    console.log(
      "PASS: real avatar paint is local; 30fps budget; actual offscreen pause/resume; hidden pause/resume; idle/unmount cancel the clock"
    )
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
