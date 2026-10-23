import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { prepareAutobizCollectorFixture } from "../support/autobiz-collector-dependency-fixture"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("loads the locked real YAML parser in a cold child Node without external node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-dependency-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
  const collector = join(root, "collector")
  prepareAutobizCollectorFixture(collector)
  const { stdout } = await execute(
    process.execPath,
    [
      "-e",
      `
    const matter=require(require.resolve('gray-matter',{paths:[process.argv[1]]}));
    const parsed=matter('---\\nbase: &base\\n  label: "Order: model"\\nentry:\\n  <<: *base\\n  items: [one, two]\\nbody: |\\n  first\\n  second\\n---\\nOriginal markdown');
    process.stdout.write(JSON.stringify({data:parsed.data,content:parsed.content}));
  `,
      collector
    ],
    { windowsHide: true, timeout: 5000 }
  )
  expect(JSON.parse(stdout)).toEqual({
    data: {
      base: { label: "Order: model" },
      entry: { label: "Order: model", items: ["one", "two"] },
      body: "first\nsecond\n"
    },
    content: "Original markdown"
  })
  const notices = await readFile(
    join(collector, "node_modules/gray-matter/THIRD-PARTY-NOTICES.md"),
    "utf8"
  )
  expect(notices).toContain("## gray-matter@4.0.3")
  expect(notices).toContain("## js-yaml@3.15.2")
})

it("reuses only the exact private dependency and refuses a changed fixture without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-dependency-"))
  roots.push(root)
  prepareAutobizCollectorFixture(root)
  const entry = join(root, "node_modules/gray-matter/index.js")
  const original = await readFile(entry)
  prepareAutobizCollectorFixture(root)
  expect((await readFile(entry)).equals(original)).toBe(true)
  await writeFile(entry, "changed private fixture")
  expect(() => prepareAutobizCollectorFixture(root)).toThrow("COLLECTOR_FIXTURE_DEPENDENCY_CHANGED")
  expect(await readFile(entry, "utf8")).toBe("changed private fixture")
})
