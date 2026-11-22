import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { build } from "vite"
import { expect, it } from "vitest"
import { radixScrollbarWheel } from "../../scripts/vite-radix-scrollbar-wheel"

const fixtureEntry = "cmb-radix-wheel-fixture"

async function compileFixture(entry: string) {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [radixScrollbarWheel(), {
      name: fixtureEntry,
      resolveId: (id) => id === fixtureEntry ? `\0${id}` : undefined,
      load(id) {
        if (id !== `\0${fixtureEntry}`) return
        return `
          import * as Area from ${JSON.stringify(entry)}
          import { createElement as h } from 'react'
          import { createRoot } from 'react-dom/client'
          const listeners = new Map()
          const add = EventTarget.prototype.addEventListener
          const remove = EventTarget.prototype.removeEventListener
          EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (type === 'wheel' && options?.passive === false) listeners.set(listener, this)
            return add.call(this, type, listener, options)
          }
          EventTarget.prototype.removeEventListener = function (type, listener, options) {
            if (type === 'wheel') listeners.delete(listener)
            return remove.call(this, type, listener, options)
          }
          const scrollbar = (id, orientation) => h(Area.Scrollbar, {
            id, orientation, style: orientation === 'vertical'
              ? { display: 'flex', width: 16, background: '#ddd' }
              : { display: 'flex', flexDirection: 'column', height: 16, background: '#ddd' }
          }, h(Area.Thumb, { id: id + '-thumb', style: { flex: 1, background: '#555' } }))
          const inner = h(Area.Root, {
            type: 'always', style: { position: 'relative', width: 240, height: 160, overflow: 'hidden' }
          }, h(Area.Viewport, { id: 'inner', style: { width: '100%', height: '100%' } },
            h('div', { style: { width: 900, height: 900 } }, 'Transcript')),
            scrollbar('vertical', 'vertical'), scrollbar('horizontal', 'horizontal'), h(Area.Corner))
          const outer = h(Area.Root, {
            type: 'always', style: { position: 'relative', width: 320, height: 240, overflow: 'hidden' }
          }, h(Area.Viewport, { id: 'outer', style: { width: '100%', height: '100%' } },
            h('div', { style: { height: 1500, padding: 12 } }, inner)),
            scrollbar('outer-vertical', 'vertical'))
          const root = createRoot(document.querySelector('#root'))
          root.render(outer)
          window.fixture = {
            targets: () => [...listeners.values()].map(node => node === document ? 'document' : node.id).sort(),
            unmount: () => root.unmount()
          }
        `
      }
    }],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: fixtureEntry, output: { format: "iife", inlineDynamicImports: true } }
    }
  })
  const bundle = Array.isArray(output) ? output[0] : output
  if (!("output" in bundle)) throw Error("Expected the Radix fixture renderer bundle")
  const script = bundle.output.find((file) => file.type === "chunk" && file.isEntry)
  if (!script || script.type !== "chunk") throw Error("Missing the Radix fixture entry")
  return script.code
}

it.each([
  ["ESM", "@radix-ui/react-scroll-area"],
  ["CJS", resolve("node_modules/@radix-ui/react-scroll-area/dist/index.js")]
])("scopes Radix %s wheel handling and preserves nested scrolling and drag", async (_kind, entry) => {
  const bundle = await compileFixture(entry)
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(8_000)
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle })
    await page.locator("#vertical-thumb").waitFor({ state: "visible" })
    await page.locator("#horizontal-thumb").waitFor({ state: "visible" })
    const targets = () => page.evaluate("window.fixture.targets()")
    expect(await targets()).toEqual(["horizontal", "outer-vertical", "vertical"])

    const position = () => page.locator("#inner").evaluate(element => ({
      x: element.scrollLeft, y: element.scrollTop
    }))
    const outerTop = () => page.locator("#outer").evaluate(element => element.scrollTop)
    const wheel = (selector: string, deltaX: number, deltaY: number) =>
      page.locator(selector).evaluate((element, [x, y]) => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: x, deltaY: y })
        element.dispatchEvent(event)
        return event.defaultPrevented
      }, [deltaX, deltaY])

    expect(await wheel("#inner", 0, 32)).toBe(false)
    expect(await position()).toEqual({ x: 0, y: 0 })
    expect(await wheel("#vertical-thumb", 0, 52)).toBe(true)
    expect(await wheel("#horizontal-thumb", 63, 0)).toBe(true)
    expect(await position()).toEqual({ x: 63, y: 52 })
    expect(await outerTop()).toBe(0)

    // At the nested edge, the original handler clamps locally and leaves the wheel available.
    expect(await wheel("#vertical-thumb", 0, -75)).toBe(false)
    expect(await wheel("#horizontal-thumb", -75, 0)).toBe(false)
    expect(await position()).toEqual({ x: 0, y: 0 })

    await page.locator("#inner").hover({ position: { x: 100, y: 50 } })
    await page.mouse.wheel(0, 65)
    await expect.poll(position).toEqual({ x: 0, y: 65 })
    expect(await outerTop()).toBe(0)

    const thumb = await page.locator("#vertical-thumb").boundingBox()
    expect(thumb).toBeTruthy()
    if (!thumb) throw Error("Radix pointer drag requires a mounted thumb")
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 48, { steps: 4 })
    await page.mouse.up()
    expect((await position()).y).toBeGreaterThan(200)
    expect(await outerTop()).toBe(0)

    const bottom = await page.locator("#inner").evaluate(element => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    await page.locator("#vertical-thumb").hover({ position: { x: 3, y: 3 } })
    await page.mouse.wheel(0, 65)
    await expect.poll(outerTop).toBeGreaterThan(0)
    expect((await position()).y).toBe(bottom)

    await page.evaluate("window.fixture.unmount()")
    expect(await targets()).toEqual([])
  } finally {
    await browser.close()
  }
}, 30_000)
