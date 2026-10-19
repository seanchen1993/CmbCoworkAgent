import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const roots: string[] = []
const validator = resolve("resources/mods/autobiz-knowledge/validate-knowledge-draft.py")
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "cmb-knowledge-draft-"))
  roots.push(workspace)
  const feature = join(workspace, "project", ".autobizdevops", "features", "feature-1")
  await mkdir(feature, { recursive: true })
  const source = "# Actual requirement\nPreserve lineage.\n"
  const markdown = "# Reusable knowledge\nDerived from PRD.md; pending review.\n"
  await writeFile(join(feature, "PRD.md"), source)
  await writeFile(join(feature, "KNOWLEDGE_DRAFT.md"), markdown)
  const descriptor = {
    schemaVersion: "autobiz.knowledge-draft/v1",
    title: "Lineage",
    summary: "Preserve artifact lineage",
    securityReview: "pending",
    markdownDigest: sha(markdown),
    sources: [{ path: "PRD.md", digest: sha(source) }]
  }
  async function run(change: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    await writeFile(
      join(feature, "KNOWLEDGE_DRAFT.json"),
      JSON.stringify({ ...descriptor, ...change })
    )
    const child = spawnSync("python", ["-X", "utf8", validator], {
      encoding: "utf8",
      env: {
        ...process.env,
        PLUGIN_WORKSPACE: workspace,
        PROJECT_DIR: "project",
        FEATURE_ID: "feature-1",
        PYTHONDONTWRITEBYTECODE: "1",
        ...env
      }
    })
    if (child.error) throw child.error
    return { code: child.status, result: JSON.parse(child.stdout) }
  }
  return { feature, run }
}

it("checks actual Feature bytes and reports pending review without advancing or publishing", async () => {
  const f = await fixture()
  const before = await readFile(join(f.feature, "PRD.md"), "utf8")
  expect(await f.run()).toMatchObject({
    code: 0,
    result: {
      ok: true,
      state: "awaiting-review",
      reviewed: false,
      sourcesChecked: 1
    }
  })
  expect(await readFile(join(f.feature, "PRD.md"), "utf8")).toBe(before)
})

it("rejects changed source, changed draft, self-evidence and author-declared approval", async () => {
  const f = await fixture()
  for (const change of [
    { markdownDigest: "0".repeat(64) },
    { securityReview: "approved" },
    { sources: [{ path: "KNOWLEDGE_DRAFT.md", digest: "0".repeat(64) }] },
    { sources: [{ path: "PRD.md", digest: "0".repeat(64) }] },
    { sources: [] }
  ])
    expect(await f.run(change)).toMatchObject({ code: 1, result: { ok: false } })
  await writeFile(join(f.feature, "PRD.md"), "Changed by another step")
  expect(await f.run()).toMatchObject({ code: 1, result: { ok: false } })
})

it("rejects cross-Feature sources and missing or forged host scope", async () => {
  const f = await fixture()
  for (const path of ["../PRD.md", "C:/other/PRD.md", "/other/PRD.md", "a\\PRD.md"])
    expect(await f.run({ sources: [{ path, digest: "0".repeat(64) }] })).toMatchObject({
      code: 1,
      result: { ok: false }
    })
  const invalidScopes: Array<Record<string, string>> = [
    { FEATURE_ID: "../feature-1" },
    { PROJECT_DIR: "" },
    { PLUGIN_WORKSPACE: "" }
  ]
  for (const env of invalidScopes)
    expect(await f.run({}, env)).toMatchObject({ code: 1, result: { ok: false } })
})
