import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import AdmZip from "adm-zip"
import { readBundledBusinessModExample } from "../src/main/plugins/business-mod-examples"
import { assembleBusinessMods } from "../src/main/plugins/business-mod-assembler"
import { parseBusinessModCatalog } from "../src/main/plugins/business-mod-manifest"
import { derivationDigest, type DerivationFile } from "../src/main/plugins/derivation-source"
import type { BusinessModAssemblyRequest } from "../src/shared/business-mods"
import {
  creatorBusinessTrialAuthoringStep as step,
  creatorBusinessTrialModel,
  creatorTrialWorkspaceIdentity as workspaceKey
} from "./support/creator-business-trial-model"

type Row = Record<string, unknown>
const reply = (result: Row) => ({ ok: true, result })
const labelId = "custom.trial-label"
const labelPath = `mods/business/${labelId}/register.ts`
const library = resolve("output/deliveries/mods-creator-utest-library-20261018-v104")
const archive = new AdmZip(resolve(library, "10-完整AutoBiz+并行进度+知识版-1.0.4.zip"))
const assembled = JSON.parse(archive.readAsText("mods/business/manifest.json")) as {
  modules: Array<{ id: string }>
  extensions: Array<{ id: string; kind: string }>
}
const source = JSON.parse(
  readFileSync(
    resolve(
      "output/deliveries/mods-creator-utest-literal-20261018-v104/Mods来源/AutoBiz/mods/business/manifest.json"
    ),
    "utf8"
  )
) as { modules: Array<{ id: string }>; extensions?: Array<{ id: string; kind: string }> }
const inspection = (catalog: typeof source): Row => ({
  id: "actual-source-inspection",
  kernel: { id: "autobiz.python-kernel", version: "1.0.4" },
  mods: [
    ...catalog.modules.map(({ id }) => ({ id })),
    ...(catalog.extensions ?? []).map(({ id }) => ({ id, kind: "function" }))
  ]
})
const ready = (base: Row) => [reply({ sources: [] }), reply(base)]
function saved(input: Row, revision = 1) {
  return reply({
    id: input.id,
    revision,
    modIds: (input.extensions as Array<{ id: string }>).map(({ id }) => id)
  })
}
const selected = (preview: Row, name: "sources" | "drafts") =>
  (preview[name] as Array<{ modIds: string[] }>)[0].modIds

test("assembled v104 source keeps every original extension and adds only the label draft", () => {
  assert(assembled.extensions.some(({ id }) => id === "autobiz.knowledge"))
  assert(assembled.extensions.some(({ id }) => id === "autobiz.worktree-progress"))
  const base = inspection(assembled)
  // A future original extension must also survive selection without a hardcoded allowlist.
  const mods = base.mods as Row[]
  mods.push({ id: "future.observer", kind: "function" })
  const replies = ready(base)
  const save = step(replies, "native-source-id", false)!
  assert.equal(save.action, "save", "Existing knowledge does not request a duplicate example")
  assert.deepEqual(
    (save.extensions as Row[]).map(({ id }) => id),
    [labelId]
  )
  assert.deepEqual(
    (save.files as Row[]).map(({ path }) => path),
    [labelPath]
  )
  replies.push(saved(save))
  const preview = step(replies, "native-source-id", false)!
  assert.equal(preview.action, "preview")
  assert.deepEqual(
    selected(preview, "sources"),
    (base.mods as Row[]).map(({ id }) => id)
  )
  assert.deepEqual(selected(preview, "drafts"), [labelId])
  const originalIds = (base.mods as Row[]).map(({ id }) => id)
  const draftIds = (save.extensions as Row[]).map(({ id }) => id)
  assert.equal(new Set([...originalIds, ...draftIds]).size, originalIds.length + draftIds.length)
})

test("second dialogue uses the saved label revision and preserves original source selection", () => {
  const base = inspection(assembled)
  const first = step(ready(base), "native-source-id", false)!
  const draft = {
    id: "trial-label",
    revision: 1,
    files: first.files,
    catalog: { extensions: first.extensions }
  }
  assert.deepEqual(step([], "native-source-id", true), { action: "read", id: "trial-label" })
  const replies = [reply(draft)]
  assert.deepEqual(step(replies, "native-source-id", true), {
    action: "inspect",
    pluginId: "native-source-id"
  })
  replies.push(reply(base))
  const patch = step(replies, "native-source-id", true)!
  assert.equal(patch.revision, 1)
  assert.deepEqual(patch.extensions, first.extensions)
  const files = patch.files as Array<{ path: string; text: string }>
  assert.equal(files.length, 1)
  assert(files[0].text.includes("业务试用审阅标识：修订版"))
  assert(!files[0].text.includes("业务试用审阅标识：初版"))
  replies.push(saved(patch, 2))
  const preview = step(replies, "native-source-id", true)!
  assert.equal(preview.version, "1.0.1")
  assert.equal((preview.drafts as Row[])[0].revision, 2)
  assert.deepEqual(
    selected(preview, "sources"),
    (base.mods as Row[]).map(({ id }) => id)
  )
  assert.deepEqual(selected(preview, "drafts"), [labelId])
})

test("original source without knowledge still copies all real bundled knowledge resources", async () => {
  assert.equal(source.extensions?.length ?? 0, 0)
  const base = inspection(source)
  const replies = ready(base)
  assert.deepEqual(step(replies, "native-source-id", false), {
    action: "example",
    exampleId: "autobiz-knowledge"
  })
  const example = await readBundledBusinessModExample("autobiz-knowledge", resolve("tests"))
  replies.push(reply(example))
  const save = step(replies, "native-source-id", false)!
  assert.deepEqual(
    (save.extensions as Row[]).map(({ id }) => id),
    ["autobiz.knowledge", labelId]
  )
  assert.deepEqual((save.extensions as Row[])[0], example.draft.extensions![0])
  assert.deepEqual((save.files as Row[]).slice(0, -1), example.draft.files)
  replies.push(saved(save))
  const preview = step(replies, "native-source-id", false)!
  assert.deepEqual(
    selected(preview, "sources"),
    source.modules.map(({ id }) => id)
  )
  assert.deepEqual(selected(preview, "drafts"), ["autobiz.knowledge", labelId])
})

test("paginated knowledge reads retain exact source bytes and native revision on later dialogue", async () => {
  const base = inspection(source)
  const example = await readBundledBusinessModExample("autobiz-knowledge", resolve("tests"))
  const firstReplies = [...ready(base), reply(example)]
  const initial = step(firstReplies, "native-source-id", false)!
  const draft = {
    id: "trial-label",
    revision: 3,
    files: initial.files,
    catalog: { extensions: initial.extensions }
  }
  const json = JSON.stringify(draft)
  const halfway = Math.floor(json.length / 2)
  const replies = [
    reply({ format: "json-pages", jsonChunk: json.slice(0, halfway), nextCursor: 1 })
  ]
  assert.deepEqual(step(replies, "native-source-id", true), {
    action: "read",
    id: "trial-label",
    cursor: 1
  })
  replies.push(reply({ format: "json-pages", jsonChunk: json.slice(halfway) }))
  assert.equal(step(replies, "native-source-id", true)!.action, "inspect")
  replies.push(reply(base))
  const patch = step(replies, "native-source-id", true)!
  assert.equal(patch.revision, 3)
  assert.deepEqual((patch.files as Row[]).slice(0, -1), example.draft.files)
  assert.deepEqual(patch.extensions, initial.extensions)
  replies.push(saved(patch, 4))
  const preview = step(replies, "native-source-id", true)!
  assert.equal((preview.drafts as Row[])[0].revision, 4)
  assert.deepEqual(selected(preview, "drafts"), ["autobiz.knowledge", labelId])
})

test("native valid preview remains required before preparing a trial request", () => {
  const replies = ready(inspection(assembled))
  const save = step(replies, "native-source-id", false)!
  replies.push(saved(save))
  assert.equal(step(replies, "native-source-id", false)!.action, "preview")
  replies.push(reply({ valid: false, previewId: "rejected-preview" }))
  assert.throws(() => step(replies, "native-source-id", false))
  replies[replies.length - 1] = reply({ valid: true, previewId: "native-checked-preview" })
  const trial = step(replies, "native-source-id", false)!
  assert.equal(trial.action, "request_trial")
  assert.equal(trial.previewId, "native-checked-preview")
  assert.match(String(trial.goal), /TRIAL_PRD/)
})

test("the real assembler accepts the model plan without replacing original knowledge or checks", () => {
  const base = inspection(assembled)
  const replies = ready(base)
  const save = step(replies, "native-source-id", false)!
  replies.push(saved(save))
  const preview = step(replies, "native-source-id", false)!
  const file = (path: string, bytes: Buffer): DerivationFile => ({
    path,
    bytes,
    mode: 0o666,
    digest: createHash("sha256").update(bytes).digest("hex")
  })
  const originalFiles = archive
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => file(entry.entryName, entry.getData()))
  const draftCatalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.4" },
    modules: [],
    extensions: save.extensions
  })
  const draftFiles = (save.files as Array<{ path: string; text: string }>).map(({ path, text }) =>
    file(path, Buffer.from(text))
  )
  const snapshot = (name: string, files: DerivationFile[]) => ({
    root: name,
    name,
    files,
    digest: derivationDigest(files, []),
    excluded: [],
    totalBytes: files.reduce((total, item) => total + item.bytes.length, 0),
    manifests: ["plugin.json"]
  })
  const originalMetadata = JSON.parse(archive.readAsText("plugin.json")) as { name: string }
  const request: BusinessModAssemblyRequest = {
    name: preview.name as string,
    version: preview.version as string,
    sources: preview.sources as BusinessModAssemblyRequest["sources"]
  }
  const result = assembleBusinessMods(
    [
      {
        snapshot: snapshot(originalMetadata.name, originalFiles),
        catalog: parseBusinessModCatalog(assembled),
        modIds: selected(preview, "sources")
      },
      {
        snapshot: snapshot("creator-trial-label", draftFiles),
        catalog: draftCatalog,
        modIds: selected(preview, "drafts")
      }
    ],
    request
  )
  assert.equal(result.missingProviders.length, 0)
  assert.equal(result.requiresFixedWorkflowAcknowledgement, false)
  assert(result.extensions, "The real assembled candidate retains its function extensions")
  assert.deepEqual(
    result.extensions.map(({ id }) => id),
    [...assembled.extensions.map(({ id }) => id), labelId]
  )
  const byPath = new Map(result.files.map((item) => [item.path, item.bytes]))
  for (const path of [
    "hooks/hooks.json",
    "mods/business/autobiz.knowledge/provider.py",
    "mods/business/autobiz.knowledge/register.ts",
    "mods/business/autobiz.worktree-progress/register.ts"
  ]) {
    assert(byPath.get(path)?.equals(archive.readFile(path)!), `Original bytes retained: ${path}`)
  }
})

test("Windows observation keys find native case aliases without changing values or merging trials", () => {
  const raw = "C:\\tmp\\NativeTrial\\trial-AbC\\workspace"
  const native = "c:\\tmp\\nativetrial\\trial-abc\\workspace"
  const value = { source: "C:\\Retained\\Package-AbC", firstHttpAt: 123, feature: "trial-one" }
  const completed = new Set(["chosen-knowledge"])
  const runtime = new Map([[workspaceKey(raw, "win32"), value]])
  const completion = new Map([[workspaceKey(raw, "win32"), completed]])
  assert.equal(runtime.get(workspaceKey(native, "win32")), value)
  assert.equal(completion.get(workspaceKey(native, "win32")), completed)
  assert(runtime.has(workspaceKey("c:/TMP/NativeTrial/trial-AbC/workspace/.", "win32")))
  assert(!runtime.has(workspaceKey("C:/tmp/NativeTrial/trial-Other/workspace", "win32")))
  assert.equal(value.source, "C:\\Retained\\Package-AbC")
  assert.equal(value.firstHttpAt, 123)
})

test("POSIX observation keys retain case-sensitive workspace separation", () => {
  const runtime = new Map([[workspaceKey("/tmp/trial-AbC/workspace", "linux"), "one"]])
  assert.equal(runtime.get(workspaceKey("/tmp/trial-AbC/workspace/.", "linux")), "one")
  assert(!runtime.has(workspaceKey("/tmp/trial-abc/workspace", "linux")))
  assert(!runtime.has(workspaceKey("/tmp/trial-Other/workspace", "linux")))
})

test("real model HTTP keeps completed observations and the original 90s anchor across aliases", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-trial-observation-"))
  const trials = join(isolated, "trials")
  const workspace = join(trials, "trial-AbC", "workspace")
  const source = join(trials, "packages", "Package-AbC")
  const skill = join(source, "skills", "autobiz", "SKILL.md")
  mkdirSync(join(workspace, ".autobizdevops"), { recursive: true })
  mkdirSync(join(source, "skills", "autobiz"), { recursive: true })
  writeFileSync(skill, "# Original fixture skill\n")
  writeFileSync(
    join(workspace, ".autobizdevops", "state.json"),
    JSON.stringify({ features: { "trial-one": {} } })
  )
  const knowledgeRule = "OBSERVATION_TEST_FULL_RULE"
  const model = creatorBusinessTrialModel({
    baseId: () => "unchanged-source-id",
    knowledgeFile: join(isolated, "rules.md"),
    knowledgeRule,
    privateTrialRoot: trials
  })
  await new Promise<void>((done) => model.server.listen(0, "127.0.0.1", done))
  const address = model.server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/v1/chat/completions`
  const messages = (input: string, tool?: { id: string; body: string }) => [
    {
      role: "system",
      content: `The workspace root is: ${input}\nCREATOR_TRIAL_KNOWLEDGE_FULL_BODY`
    },
    { role: "user", content: `<name>autobiz-requirement-discuss</name><path>${skill}</path>` },
    ...(tool ? [{ role: "tool", tool_call_id: tool.id, content: tool.body }] : [])
  ]
  const send = (input: string, tool?: { id: string; body: string }) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "trial-observation",
        messages: messages(input, tool),
        tools: [{ function: { name: "read_file" } }, { function: { name: "execute" } }]
      })
    })
  try {
    const first = await send(workspace)
    assert.equal(first.status, 200)
    const firstSse = await first.text()
    const firstChunk = firstSse.split("\n").find((line) => line.startsWith("data: {"))!
    const callId = JSON.parse(firstChunk.slice(6)).choices[0].delta.tool_calls[0].id as string
    const key = workspaceKey(workspace)
    const entry = model.runtime.get(key)!
    const originalStarted = entry.firstHttpAt
    const completed = model.completed.get(key)!
    const alias = process.platform === "win32" ? workspace.toLowerCase() : join(workspace, ".")
    const second = await send(alias, { id: callId, body: knowledgeRule })
    assert.equal(second.status, 200)
    await second.text()
    assert.equal(model.runtime.get(workspaceKey(alias)), entry)
    assert.equal(entry.firstHttpAt, originalStarted)
    assert.equal(model.completed.get(workspaceKey(alias)), completed)
    assert(completed.has("chosen-knowledge"))
    assert.equal(model.runtime.size, 1)
    assert.equal(model.completed.size, 1)
    assert.equal(model.requests[0].workspace, workspace, "Recorded evidence retains the raw path")
    assert.deepEqual(model.errors, [])
    // Only the test's observation timestamp is aged; no clock, native limit or HTTP wrapper changes.
    entry.firstHttpAt = Date.now() - 90_001
    const expired = await send(alias)
    assert.equal(expired.status, 500)
    await expired.text()
    assert.equal(model.runtime.get(key), entry)
    assert.equal(model.runtime.size, 1, "A case alias cannot create a fresh 90 second budget")
    assert.equal(model.errors.length, 1)
    assert.match(model.errors[0], /Original per-session 90 second gate/)
  } finally {
    model.releaseHeld()
    await new Promise<void>((done, reject) =>
      model.server.close((error) => (error ? reject(error) : done()))
    )
  }
})
