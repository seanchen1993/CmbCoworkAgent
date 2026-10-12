import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { createCanvas, GlobalFonts } from "@napi-rs/canvas"
import { BotDocumentReader } from "./document-reader"
import { prepareBotImage } from "./image-reader"
import { pdfDocument } from "./document-fixtures"

const require = createRequire(import.meta.url)
const parentFlag = process.env.DISABLE_SYSTEM_FONTS_LOAD
const parentFonts = GlobalFonts.families.map((font) => font.family)
let directory: string, entry: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "raster-worker-fonts-"))
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "junction")
  entry = join(directory, "document.cjs")
  await build({
    entryPoints: ["src/main/bots/document-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["pdfjs-dist/*", "@napi-rs/canvas"],
    logLevel: "silent"
  })
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  expect(process.env.DISABLE_SYSTEM_FONTS_LOAD).toBe(parentFlag)
  expect(GlobalFonts.families.map((font) => font.family)).toEqual(parentFonts)
})
async function observedReader(name: string, raster: boolean) {
  const preload = join(directory, `${name}.cjs`),
    record = join(directory, `${name}.json`)
  const font = join(
    dirname(require.resolve("pdfjs-dist/package.json")),
    "standard_fonts/LiberationSans-Regular.ttf"
  )
  // Observe the flag at the first actual native import. Font-bearing branches
  // then register a bundled Latin font only in this child, independent of OS fonts.
  await writeFile(
    preload,
    [
      'const assert = require("node:assert/strict")',
      'const Module = require("node:module")',
      'const fs = require("node:fs")',
      "delete process.env.DISABLE_SYSTEM_FONTS_LOAD",
      "const original = Module._load",
      "let observed = false",
      "Module._load = function(id, parent, main) {",
      '  if (id !== "@napi-rs/canvas" || observed) return original.call(this, id, parent, main)',
      `  assert.equal(process.env.DISABLE_SYSTEM_FONTS_LOAD, ${raster ? '"1"' : "undefined"})`,
      "  observed = true",
      '  process.env.DISABLE_SYSTEM_FONTS_LOAD = "1"',
      "  const canvas = original.call(this, id, parent, main)",
      ...(raster
        ? ["  assert.deepEqual(canvas.GlobalFonts.families, [])"]
        : [`  assert.ok(canvas.GlobalFonts.registerFromPath(${JSON.stringify(font)}, "Arial"))`]),
      "  return canvas",
      "}",
      `process.on("exit", () => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ observed })))`
    ].join("\n")
  )
  return {
    reader: new BotDocumentReader({ entry, execArgv: ["--require", preload] }),
    observed: async () =>
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
        observed: true
      })
  }
}
it("decodes raster pixels without loading any system fonts and preserves byte-identical image output", async () => {
  const canvas = createCanvas(960, 540),
    context = canvas.getContext("2d")
  context.fillStyle = "#10213d"
  context.fillRect(0, 0, 960, 540)
  context.fillStyle = "#ffffff"
  context.fillRect(70, 70, 400, 120)
  const bytes = await canvas.encode("png"),
    signal = new AbortController().signal
  const expected = await prepareBotImage({ kind: "image", bytes })
  const observed = await observedReader("raster", true)
  expect(await observed.reader.image(bytes, undefined, signal)).toEqual(expected)
  await observed.observed()
}, 20_000)
it("preserves font-bearing PDF and presentation worker branches", async () => {
  const pdf = await observedReader("pdf", false)
  expect(
    await pdf.reader.pdfPage(
      pdfDocument(["Text remains visible"]),
      1,
      undefined,
      new AbortController().signal
    )
  ).toMatchObject({ page: 1, pageCount: 1 })
  await pdf.observed()
  const pptx = await observedReader("presentation", false)
  const drafts = await pptx.reader.presentationDrafts(
    {
      name: "Report.pptx",
      title: "Report",
      slides: [{ kind: "title", title: "Editable text" }]
    },
    new AbortController().signal
  )
  expect(drafts.layouts).toHaveLength(3)
  expect(drafts.layouts.every((layout) => layout.font === "Arial")).toBe(true)
  await pptx.observed()
}, 20_000)
