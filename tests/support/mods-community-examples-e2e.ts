import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { CommunityExampleId } from "../../src/shared/mods/community-examples"

export const PACKAGED_COMMUNITY_EXAMPLE_IDS: readonly CommunityExampleId[] = [
  "task-workbench-provider",
  "task-workbench-consumer",
  "task-behavior-prefix",
  "task-behavior-compact",
  "edit-reminder",
  "stage-debugger",
  "token-weather",
  "replay-theater",
  "blast-radius"
]

function ownedPluginDirectory(dataRoot: string, directory: string): string {
  const parent = realpathSync(dataRoot),
    child = realpathSync(directory)
  const path = relative(parent, child)
  assert(
    path && !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep),
    "The regression may inspect only its isolated installed plugin files"
  )
  assert(!lstatSync(directory).isSymbolicLink())
  return child
}

function readFiles(directory: string, prefix = ""): Record<string, Buffer> {
  const files: Record<string, Buffer> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Installed example must not contain links")
    const path = join(directory, entry.name),
      name = prefix + entry.name
    if (entry.isDirectory()) Object.assign(files, readFiles(path, name + "/"))
    else {
      assert(entry.isFile(), "Installed example must contain only ordinary files")
      files[name] = readFileSync(path)
    }
  }
  return files
}

function digests(directory: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readFiles(directory)).map(([name, bytes]) => [
      name,
      createHash("sha256").update(bytes).digest("hex")
    ])
  )
}

/** Public production preload IPC only. Never grants source permissions or starts a guest action. */
export async function verifyPackagedCommunityExamples(
  page: Page,
  workspace: string,
  isolatedDataRoot: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "packaged-community-examples")
  mkdirSync(project, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const created: string[] = [],
    checks: string[] = [],
    failures: unknown[] = []
  let threadId: string | undefined
  const checked = (label: string) => {
    checks.push(label)
    pass(label)
  }
  const list = () => page.evaluate(() => window.api.plugins.list())
  const catalogue = () => page.evaluate(() => window.api.mods.communityExamples.list())
  try {
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), true)
    const before = await list()
    assert(
      !before.some((row) => PACKAGED_COMMUNITY_EXAMPLE_IDS.some((id) => id === row.name)),
      "Run this acceptance in the isolated packaged profile before any community example installation"
    )
    const initial = await catalogue()
    assert.deepEqual(
      initial.examples.map((example) => example.id).sort(),
      [...PACKAGED_COMMUNITY_EXAMPLE_IDS].sort()
    )
    assert(initial.examples.every((example) => example.installation?.state === "missing"))
    assert.deepEqual(await list(), before, "Reading the catalogue must not install anything")
    threadId = await page.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Packaged community examples acceptance",
        workspacePath: project,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      const current = await window.api.mods.status(id)
      await window.api.mods.configure(id, true, true, current.workspace)
      return id
    }, project)
    const installed = new Map<CommunityExampleId, string>()
    for (const exampleId of PACKAGED_COMMUNITY_EXAMPLE_IDS) {
      const result = await page.evaluate(
        (exampleId) => window.api.mods.communityExamples.install({ exampleId }),
        exampleId
      )
      created.push(result.pluginId)
      assert.equal(result.pluginName, exampleId)
      assert.equal(result.alreadyInstalled, false)
      assert.equal(result.requiresApproval, true)
      assert(!installed.has(exampleId))
      installed.set(exampleId, result.pluginId)
    }
    assert.equal(new Set(created).size, 9)
    const after = await list()
    assert.equal(after.length, before.length + 9)
    const approvedCatalogue = await catalogue()
    for (const example of approvedCatalogue.examples) {
      assert.equal(example.installation?.state, "installed", example.id)
      assert.equal(example.installation?.pluginId, installed.get(example.id))
    }
    await until(async () => {
      const rows =
        (await page.evaluate((id) => window.api.mods.status(id), threadId!)).functionMods ?? []
      return created.every((id) =>
        rows.some((row) => row.pluginId === id && row.state === "needs-approval" && row.digest)
      )
    }, "all nine materialized packages compile without receiving approval")
    checked(
      "Packaged ASAR catalogue installs and verifies all nine real packages; each starts unapproved"
    )

    const snapshots = new Map<string, Record<string, string>>()
    for (const row of after.filter((row) => created.includes(row.id))) {
      snapshots.set(row.id, digests(ownedPluginDirectory(isolatedDataRoot, row.path)))
    }
    for (const exampleId of PACKAGED_COMMUNITY_EXAMPLE_IDS) {
      const result = await page.evaluate(
        (exampleId) => window.api.mods.communityExamples.install({ exampleId }),
        exampleId
      )
      assert.equal(result.alreadyInstalled, true)
      assert.equal(result.requiresApproval, true)
      assert.equal(result.pluginId, installed.get(exampleId))
    }
    assert.deepEqual(
      await list(),
      after,
      "Same-version installation must not duplicate or rewrite catalogue metadata"
    )
    for (const row of after.filter((row) => created.includes(row.id)))
      assert.deepEqual(
        digests(ownedPluginDirectory(isolatedDataRoot, row.path)),
        snapshots.get(row.id)
      )
    checked(
      "Reinstalling all nine examples reuses their original IDs, catalogue metadata and exact installed bytes"
    )

    // Create a harmless personal same-name revision through the ordinary public ZIP importer.
    // The acceptance never edits the app archive, its unpacked assets, or another user's package.
    const personal = after.find((row) => row.id === installed.get("token-weather"))!
    const personalDirectory = ownedPluginDirectory(isolatedDataRoot, personal.path)
    const originalFiles = readFiles(personalDirectory)
    const source = "hooks/token-weather.mjs"
    assert(originalFiles[source])
    const zip = new AdmZip()
    for (const [name, bytes] of Object.entries(originalFiles))
      zip.addFile(
        name,
        name === source
          ? Buffer.concat([bytes, Buffer.from("\n// packaged acceptance personal revision\n")])
          : bytes
      )
    const changed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "token-weather-personal.zip",
          "local",
          undefined,
          true
        ),
      [...zip.toBuffer()]
    )
    assert.equal(changed.success, true, changed.error)
    assert.equal(changed.pluginId, personal.id)
    const personalMetadata = await list()
    const personalBytes = digests(personalDirectory)
    assert.notDeepEqual(personalBytes, snapshots.get(personal.id))
    const conflict = (await catalogue()).examples.find((example) => example.id === "token-weather")!
    assert.equal(conflict.installation?.state, "conflict")
    const error = await page.evaluate(async () => {
      try {
        await window.api.mods.communityExamples.install({ exampleId: "token-weather" })
        return ""
      } catch (cause) {
        return String(cause)
      }
    })
    assert(error.includes("MODS_COMMUNITY_EXISTING_CONFLICT"), error)
    assert.deepEqual(await list(), personalMetadata)
    assert.deepEqual(digests(personalDirectory), personalBytes)
    const final = await page.evaluate((id) => window.api.mods.status(id), threadId)
    assert(
      created.every((id) =>
        final.functionMods?.some((row) => row.pluginId === id && row.state === "needs-approval")
      )
    )
    checked(
      "A personal same-name ZIP revision remains untouched when bundled reinstall rejects its conflict; no approval is granted"
    )
  } catch (cause) {
    failures.push(cause)
  } finally {
    for (const id of created.reverse()) {
      try {
        const removed = await page.evaluate((id) => window.api.plugins.delete(id), id)
        assert.equal(removed.success, true, removed.error)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (threadId) {
      try {
        await page.evaluate((id) => window.api.threads.delete(id), threadId)
      } catch (cause) {
        failures.push(cause)
      }
    }
    try {
      writeFileSync(
        resolve(artifacts, "packaged-community-examples.json"),
        JSON.stringify(
          {
            complete: failures.length === 0,
            exampleIds: PACKAGED_COMMUNITY_EXAMPLE_IDS,
            checks,
            errorCount: failures.length
          },
          null,
          2
        )
      )
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Packaged community example acceptance failed")
}
