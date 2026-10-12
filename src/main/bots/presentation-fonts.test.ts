import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { GlobalFonts } from "@napi-rs/canvas"
import { BotDocumentReader } from "./document-reader"
import { BotPresentationInputError } from "./presentation-contract"

let directory: string, reader: BotDocumentReader
const require = createRequire(import.meta.url)
const parentFonts = GlobalFonts.families.map((font) => font.family)
const parentFontEnvironment = process.env.DISABLE_SYSTEM_FONTS_LOAD
const input = {
  name: "项目汇报.pptx",
  title: "研发交付元数据",
  slides: [
    { kind: "title" as const, title: "Delivery review", subtitle: "Project progress" },
    { kind: "content" as const, title: "Results", points: ["Completed implementation"] },
    {
      kind: "two-column" as const,
      title: "Next steps",
      left: { heading: "Engineering", points: ["Review changes"] },
      right: { heading: "Validation", points: ["Check evidence"] }
    }
  ]
}

beforeAll(async () => {
  await mkdir("output", { recursive: true })
  directory = await mkdtemp(resolve("output/presentation-fonts-"))
  const entry = join(directory, "document.cjs")
  const preload = join(directory, "latin-fonts.cjs")
  const font = join(
    dirname(require.resolve("pdfjs-dist/package.json")),
    "standard_fonts/LiberationSans-Regular.ttf"
  )
  // Restrict fonts only inside the disposable worker. The bundled PDF font makes
  // this test independent of installed fonts and the host operating system.
  await writeFile(
    preload,
    [
      'process.env.DISABLE_SYSTEM_FONTS_LOAD = "1"',
      'const assert = require("node:assert/strict")',
      `const { GlobalFonts } = require(${JSON.stringify(require.resolve("@napi-rs/canvas"))})`,
      "assert.deepEqual(GlobalFonts.families, [])",
      `assert.ok(GlobalFonts.registerFromPath(${JSON.stringify(font)}, "Arial"))`,
      'assert.deepEqual(GlobalFonts.families.map(font => font.family).sort(), ["Arial", "Liberation Sans"])'
    ].join("\n")
  )
  await build({
    entryPoints: ["src/main/bots/document-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["pdfjs-dist/*", "@napi-rs/canvas"],
    logLevel: "silent"
  })
  reader = new BotDocumentReader({ entry, execArgv: ["--require", preload] })
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  expect(process.env.DISABLE_SYSTEM_FONTS_LOAD).toBe(parentFontEnvironment)
  expect(GlobalFonts.families.map((font) => font.family)).toEqual(parentFonts)
})

it("renders Latin slide content with a Chinese filename and metadata title in a Latin-only worker", async () => {
  const drafts = await reader.presentationDrafts(input, new AbortController().signal)
  expect(drafts.layouts).toHaveLength(3)
  expect(drafts.previews).toHaveLength(3)
  for (const layout of drafts.layouts) {
    expect(layout.font).toBe("Arial")
    expect(layout.title).toBe(input.title)
    expect(layout.pages).toHaveLength(3)
  }
}, 20_000)

it("reports a typed missing-font error when visible slide content requires CJK in the same Latin-only worker", async () => {
  await expect(
    reader.presentationDrafts(
      {
        ...input,
        name: "report.pptx",
        title: "Delivery review",
        slides: [{ kind: "content", title: "Results", points: ["研发交付成果"] }]
      },
      new AbortController().signal
    )
  ).rejects.toMatchObject({
    name: BotPresentationInputError.name,
    code: "presentation_font_unavailable"
  })
}, 20_000)
