/** Browser-computed contrast for real theme surfaces and production Mods color/style mapping. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { functionUiStyle } from "../src/renderer/src/lib/function-ui-style"
import type { THEME_DEFINITIONS } from "../src/renderer/src/lib/theme-registry"

async function main() {
  const root = process.cwd()
  const css = readFileSync(resolve(root, "src/renderer/src/assets/mods-ansi-colors.css"), "utf8")
  assert(readFileSync(resolve(root, "src/renderer/src/index.css"), "utf8")
    .includes('@import "./assets/mods-ansi-colors.css"'))
  const compiled = await build({
    stdin: { contents: `
      import { functionUiStyle } from "./src/renderer/src/lib/function-ui-style"
      import { THEME_DEFINITIONS } from "./src/renderer/src/lib/theme-registry"
      window.modsAnsiFixture = { style: functionUiStyle, themes: THEME_DEFINITIONS }
    `, resolveDir: root, loader: "ts" },
    bundle: true, write: false, platform: "browser", format: "iife"
  })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.setContent(`<style>${css}</style><main id="host"></main>`)
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    // tsx keepNames helpers are outside Playwright-serialized callbacks.
    // Match the existing browser fixtures; this only returns the supplied function.
    await page.addScriptTag({ content: "window.__name = (value) => value" })
    const rows = await page.evaluate(() => {
      const fixture = (window as unknown as {
        modsAnsiFixture: { style: typeof functionUiStyle; themes: typeof THEME_DEFINITIONS }
      }).modsAnsiFixture
      const results: Array<{ theme: string; scheme: string; surface: string; name: string;
        color: string; background: string; contrast: number }> = []
      const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      const luminance = (color: string) => rgb(color).map(value => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const host = document.querySelector<HTMLElement>("#host")!
      const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"]
      for (const theme of fixture.themes) {
        document.documentElement.dataset.colorScheme = theme.colorScheme
        document.documentElement.classList.toggle("dark", theme.colorScheme === "dark")
        document.documentElement.style.setProperty("--background", theme.palette.background)
        for (const surface of ["background", "backgroundSecondary", "backgroundElevated", "backgroundInteractive"] as const) {
          host.style.backgroundColor = theme.palette[surface]
          const background = getComputedStyle(host).backgroundColor
          for (const name of names) {
            const text = document.createElement("span")
            text.textContent = name === "yellow" ? "☀ Clear ▁▂▃█" : name
            Object.assign(text.style, fixture.style({ type: "Text", props: { color: name } }))
            host.replaceChildren(text)
            const color = getComputedStyle(text).color
            const a = luminance(color), b = luminance(background)
            results.push({ theme: theme.id, scheme: theme.colorScheme, surface, name, color,
              background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) })
          }
          for (const [foreground, backdrop] of [["white", "black"], ["black", "white"]]) {
            for (const inverse of [false, true]) {
              const paired = document.createElement("span")
              Object.assign(paired.style, fixture.style({ type: "Text",
                props: { color: foreground, backgroundColor: backdrop, inverse } }))
              host.replaceChildren(paired)
              const color = getComputedStyle(paired).color
              const background = getComputedStyle(paired).backgroundColor
              const expected = (inverse ? backdrop : foreground) === "white"
                ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)"
              const expectedBackground = expected === "rgb(255, 255, 255)"
                ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)"
              if (color !== expected || background !== expectedBackground) throw Error("ANSI_PAIR_CHANGED")
              const a = luminance(color), b = luminance(background)
              results.push({ theme: theme.id, scheme: theme.colorScheme, surface,
                name: `pair-${foreground}-${backdrop}-${inverse}`, color, background,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) })
            }
          }
          const inverse = document.createElement("span")
          Object.assign(inverse.style, fixture.style({ type: "Text", props: { color: "yellow", inverse: true } }))
          host.replaceChildren(inverse)
          const inverseColor = getComputedStyle(inverse).color
          const inverseBackground = getComputedStyle(inverse).backgroundColor
          const inverseA = luminance(inverseColor), inverseB = luminance(inverseBackground)
          results.push({ theme: theme.id, scheme: theme.colorScheme, surface,
            name: "inverse-adaptive-yellow", color: inverseColor, background: inverseBackground,
            contrast: (Math.max(inverseA, inverseB) + 0.05) / (Math.min(inverseA, inverseB) + 0.05) })
          const raw = document.createElement("span")
          Object.assign(raw.style, fixture.style({ type: "Text", props: { color: "#ffff00" } }))
          host.replaceChildren(raw)
          if (getComputedStyle(raw).color !== "rgb(255, 255, 0)") throw Error("RAW_HEX_CHANGED")
        }
      }
      return results
    })
    const output = resolve(root, "output/mods-ansi-color-browser")
    mkdirSync(output, { recursive: true })
    writeFileSync(resolve(output, "contrast.json"), JSON.stringify(rows, null, 2))
    for (const row of rows) assert(row.contrast >= 4.5,
      `${row.theme}/${row.surface}/${row.name}: ${row.contrast.toFixed(2)} < 4.5`)
    for (const name of ["yellow", "cyan", "green", "red", "blue", "magenta"]) {
      const colors = new Set(rows.filter(row => row.name === name).map(row => row.color))
      assert.equal(colors.size, 2, `${name} must change with the real light/dark scheme`)
    }
    for (const row of rows) {
      const [r, g, b] = row.color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      if (row.name === "yellow") assert(r > b && g > b, "yellow must remain a warm yellow/amber hue")
      if (row.name === "cyan") assert(g > r && b > r, "cyan must retain its cool hue")
      if (row.name === "red") assert(r > g && r > b, "red hue")
      if (row.name === "green") assert(g > r && g > b, "green hue")
      if (row.name === "blue") assert(b > r && b > g, "blue hue")
      if (row.name === "magenta") assert(r > g && b > g, "magenta hue")
    }
    assert(rows.some(row => row.scheme === "light") && rows.some(row => row.scheme === "dark"))
    assert.deepEqual(errors, [])
    console.log(`Mods ANSI: ${rows.length} browser-computed contrast checks passed`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
