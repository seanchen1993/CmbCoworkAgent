/** Preflight the exact A21 authoring sources without launching any older Electron output. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { liveDisplayFiles } from "./support/creator-live-display-fixture"
import { checkFunctionAuthorTypes } from "../src/main/mods/devtools/authoring-check"
import { checkFunctionPlugin } from "../src/main/mods/devtools/check"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "a21-source-preflight-"))
  const results: unknown[] = []
  try {
    for (const patched of [false, true]) {
      const directory = join(root, String(patched))
      for (const file of liveDisplayFiles(patched)) {
        await mkdir(dirname(join(directory, file.path)), { recursive: true })
        await writeFile(join(directory, file.path), file.text)
      }
      const typed = await checkFunctionAuthorTypes(directory)
      assert.equal(typed.valid, true, JSON.stringify(typed.diagnostics))
      const compiled = await checkFunctionPlugin(directory)
      assert.equal(compiled.valid, true, JSON.stringify(compiled))
      results.push({ patched, typed, compiled })
    }
    const original = liveDisplayFiles(false), patched = liveDisplayFiles(true)
    assert.deepEqual(patched.slice(0, 2), original.slice(0, 2))
    assert.equal(patched[2].text, original[2].text.replace("A21 耗时卡", "A21 累计耗时卡"))
    console.log(JSON.stringify({ passed: true, evidenceScope: "source-preflight-only; no Electron runtime claimed", results }))
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert(basename(root).startsWith("a21-source-preflight-"))
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
