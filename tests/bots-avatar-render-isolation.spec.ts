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
const root=createRoot(document.getElementById('root'));
let nextId=0,now=0; const frames=new Map();
window.requestAnimationFrame=fn=>{frames.set(++nextId,fn);return nextId};
window.cancelAnimationFrame=id=>frames.delete(id);
window.IntersectionObserver=class { constructor(fn){this.fn=fn} observe(target){queueMicrotask(()=>this.fn([{target,isIntersecting:true}]))}unobserve(){}disconnect(){} };
window.avatarFixture={paints:{},render(color='#123456',busy=false){root.render(<><div data-probe='unchanged'><BotAvatar color='#ff2850' shape='flower'/></div><div data-probe='changed'><BotAvatar color={color} busy={busy}/></div></>)},step(count){for(let i=0;i<count;i++){now+=20;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(now)}},pending(){return frames.size},unmount(){root.unmount()}};
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
    await page.evaluate(() => (window as any).avatarFixture.step(30))
    assert(
      (await page.evaluate(() => (window as any).avatarFixture.paints.changed)) > after.changed + 1,
      "active animation continues"
    )
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.paints.unchanged),
      before.unchanged
    )
    await page.evaluate(() => (window as any).avatarFixture.unmount())
    assert.equal(
      await page.evaluate(() => (window as any).avatarFixture.pending()),
      0,
      "leaving the page cancels the shared animation clock"
    )
    assert.equal(await page.locator("svg.bot-avatar").count(), 0)
    console.log(
      "PASS: real avatar paint is local; unrelated settled avatars stay dormant; active animation continues; unmount cancels the clock"
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
