import { dirname, join, resolve, basename } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import type { PluginMetadata } from "../../types"
import type { DevelopmentScope } from "../v2/development-session"
import { compileNativeComposition } from "../../plugins/native-composition"
import { MARKET_CONTENT_MARKER } from "../../services/market-content"
import { ModControlStore } from "../control-store"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { readProjectSource } from "./project-source"
import { projectFromInstalledPlugin } from "./project-from-plugin"
import { packProjectPlugin } from "./project-tooling"
import { PROJECT_PACKAGE_REPORT_PATH, readProjectPackageReport } from "./project-package-report"

const scope: DevelopmentScope = {
  threadId: "installed-project-author",
  workspace: "creator-workspace",
  incarnation: { token: "author-incarnation", legacyCreatedAt: 1 }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-from-plugin-"))
  const installed = join(root, "installed")
  const settings = new ModControlStore(join(root, "control.sqlite"))
  cleanup.push(async () => {
    settings.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("project-from-plugin-")
    )
      throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  const make = () => {
    const sessions = new ProjectAuthoringSessions(async () => [])
    sessions.configurePersistence(settings, join(root, "drafts"))
    return sessions
  }
  const original = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
  const declaration = JSON.parse(
    original.bundle.files.find((file) => file.path === "composition/source.json")!.text
  )
  const resources = [
    { path: "knowledge/policy.md", text: "Preserve original knowledge\r\n" },
    { path: "hooks/verify.py", text: "raise Exception('MUST_NOT_EXECUTE_DURING_IMPORT')\n" }
  ]
  declaration.resources.push(...resources.map((file) => file.path))
  declaration.configuration = {
    userConfig: {
      target: { type: "string", title: "Target", description: "Business target", required: true }
    }
  }
  const compiled = compileNativeComposition(declaration, {
    files: [...original.bundle.files, ...resources].map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.text)
    })),
    actionCatalog: []
  })
  for (const file of compiled.files) {
    await mkdir(dirname(join(installed, file.path)), { recursive: true })
    await writeFile(join(installed, file.path), file.bytes)
  }
  const plugin = {
    id: "installed-native",
    name: declaration.plugin.id,
    version: "1.0.0",
    path: installed,
    enabled: true,
    updatedAt: "initial"
  } as PluginMetadata
  const sessions = make()
  const input = {
    scope,
    pluginId: plugin.id,
    id: "my-native",
    plugins: () => [plugin],
    sessions,
    guard: () => undefined
  }
  return { root, installed, plugin, sessions, make, input, declaration, compiled }
}

describe("installed native project author source", () => {
  it("derives a real packed ZIP and recompiles/repackages without recursive reports or inherited authority", async () => {
    const f = await fixture()
    const original = (await readProjectSource(f.installed)).bundle
    const zip = join(f.root, "first.zip")
    await packProjectPlugin(f.installed, zip)
    const installed = join(f.root, "installed-zip")
    new AdmZip(zip).extractAllTo(installed, false)
    const reportFile = join(installed, PROJECT_PACKAGE_REPORT_PATH)
    const reportBytes = await readFile(reportFile)
    const reportHash = createHash("sha256").update(reportBytes).digest("hex")
    expect((await readProjectSource(installed)).excluded).toEqual([PROJECT_PACKAGE_REPORT_PATH])
    const selected = { ...f.plugin, id: "packed-installation", path: installed }
    const derived = await projectFromInstalledPlugin({
      ...f.input,
      pluginId: selected.id,
      plugins: () => [selected],
      sourceDigest: original.digest
    })
    expect(derived.origin).toMatchObject({
      sourceDigest: original.digest,
      packageReport: {
        path: PROJECT_PACKAGE_REPORT_PATH,
        sha256: reportHash,
        sourceDigest: original.digest,
        executing: false
      }
    })
    expect(derived.draft.source).toEqual(original)
    expect(
      derived.draft.source.files.some((file) => file.path === PROJECT_PACKAGE_REPORT_PATH)
    ).toBe(false)
    expect(derived).toMatchObject({
      grantsAuthority: false,
      requiresFreshTrial: true,
      executed: false
    })
    expect(f.sessions.trialRequest(scope)).toBeUndefined()
    const compiled = await f.sessions.compile(
      scope,
      derived.draft.id,
      derived.draft.revision,
      () => {}
    )
    const repacked = join(f.root, "derived.zip")
    await packProjectPlugin(compiled.directory, repacked)
    const next = JSON.parse(new AdmZip(repacked).readAsText(PROJECT_PACKAGE_REPORT_PATH))
    expect(next.files).not.toContain(PROJECT_PACKAGE_REPORT_PATH)
    expect(next.sourceDigest).toBe(compiled.source.digest)
    expect(next.tests.digest).toBe(compiled.source.digest)
    expect(await readFile(reportFile)).toEqual(reportBytes)

    const historical = JSON.parse(reportBytes.toString("utf8"))
    historical.excluded = ["old-development.log"]
    await writeFile(reportFile, JSON.stringify(historical))
    const oldReport = await readFile(reportFile)
    const direct = join(f.root, "repacked-installation.zip")
    await packProjectPlugin(installed, direct)
    const current = JSON.parse(new AdmZip(direct).readAsText(PROJECT_PACKAGE_REPORT_PATH))
    expect(current.excluded).toEqual([])
    expect(current.files).not.toContain(PROJECT_PACKAGE_REPORT_PATH)
    expect(current.sourceDigest).toBe(original.digest)
    expect(await readFile(reportFile)).toEqual(oldReport)
    expect(readProjectPackageReport(installed, original)?.report.excluded).toEqual([
      "old-development.log"
    ])
  })

  it("never uses historical exclusions to discard an actual undeclared resource", async () => {
    const f = await fixture()
    const zip = join(f.root, "first.zip")
    await packProjectPlugin(f.installed, zip)
    const report = JSON.parse(new AdmZip(zip).readAsText(PROJECT_PACKAGE_REPORT_PATH))
    report.excluded = ["scripts/extra.py"]
    await writeFile(join(f.installed, PROJECT_PACKAGE_REPORT_PATH), JSON.stringify(report))
    await mkdir(join(f.installed, "scripts"))
    await writeFile(join(f.installed, "scripts/extra.py"), "NEVER_EXECUTE")
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_UNSUPPORTED"
    )
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("pins report raw bytes through draft save even if equivalent metadata is rewritten", async () => {
    const f = await fixture()
    const zip = join(f.root, "first.zip")
    await packProjectPlugin(f.installed, zip)
    const reportFile = join(f.installed, PROJECT_PACKAGE_REPORT_PATH)
    const raw = new AdmZip(zip).readAsText(PROJECT_PACKAGE_REPORT_PATH)
    await writeFile(reportFile, raw)
    const save = f.sessions.save.bind(f.sessions)
    const sessions = {
      save: (...args: Parameters<typeof save>) => {
        writeFileSync(reportFile, raw + " ")
        return save(...args)
      }
    }
    await expect(projectFromInstalledPlugin({ ...f.input, sessions })).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_CHANGED"
    )
    expect(f.sessions.list(scope)).toEqual([])
    expect(f.make().list(scope)).toEqual([])
  })

  it("copies the exact installed package into a persistent independent draft, then uses ordinary authoring", async () => {
    const f = await fixture()
    const original = (await readProjectSource(f.installed)).bundle
    const prepared = await projectFromInstalledPlugin(f.input)
    expect(prepared).toMatchObject({
      originalPreserved: true,
      executed: false,
      grantsAuthority: false,
      requiresFreshTrial: true,
      origin: { pluginId: f.plugin.id, version: "1.0.0", sourceDigest: original.digest }
    })
    expect(prepared.origin.installedIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.draft.source).toEqual(original)
    expect(prepared.draft.directory).not.toBe(f.installed)
    expect(prepared.draft.development).toBeUndefined()
    expect(f.sessions.trialRequest(scope)).toBeUndefined()
    const restored = f.make()
    expect(restored.read(scope, "my-native").source).toEqual(original)
    expect(restored.trialRequest(scope)).toBeUndefined()
    expect(restored.list({ ...scope, threadId: "other" })).toEqual([])
    const patched = await restored.patch(
      scope,
      {
        id: "my-native",
        revision: 1,
        sourceDigest: original.digest,
        sourcePatch: [
          { op: "replace", path: "/plugin/title", value: "My independent native plugin" }
        ]
      },
      () => {}
    )
    const compiled = await restored.compile(scope, patched.id, patched.revision, () => {})
    expect(compiled.source.files).toContainEqual(
      original.files.find((file) => file.path === "hooks/verify.py")
    )
    expect(compiled.source.files).toContainEqual(
      original.files.find((file) => file.path === "knowledge/policy.md")
    )
    expect(
      JSON.parse(
        compiled.source.files.find((file) => file.path === "composition/source.json")!.text
      ).configuration
    ).toEqual(f.declaration.configuration)
    expect((await readProjectSource(f.installed)).bundle).toEqual(original)
    expect(restored.trialRequest(scope)).toBeUndefined()
  })

  it("does not overwrite an existing draft id or original installed bytes", async () => {
    const f = await fixture()
    const first = await projectFromInstalledPlugin(f.input)
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_DRAFT_REVISION_CHANGED"
    )
    expect(f.sessions.read(scope, "my-native")).toEqual(first.draft)
  })

  it("rejects a missing installation and rejects legacy packages without manufacturing source", async () => {
    const f = await fixture()
    await expect(projectFromInstalledPlugin({ ...f.input, plugins: () => [] })).rejects.toThrow(
      "PROJECT_PLUGIN_NOT_INSTALLED"
    )
    await rm(join(f.installed, "composition/source.json"))
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_NATIVE_SOURCE_REQUIRED"
    )
    expect(f.sessions.list(scope)).toEqual([])
  })

  it.each([".mcp.json", "scripts/extra.py", "hooks/extra.py"])(
    "rejects unsupported %s rather than dropping executable configuration or resources",
    async (path) => {
      const f = await fixture()
      await mkdir(dirname(join(f.installed, path)), { recursive: true })
      await writeFile(join(f.installed, path), "NEVER_READ_OR_EXECUTE")
      await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
        "PROJECT_PLUGIN_SOURCE_UNSUPPORTED"
      )
      expect(f.sessions.list(scope)).toEqual([])
    }
  )

  it("preserves protected-source boundaries", async () => {
    const f = await fixture()
    await writeFile(join(f.installed, MARKET_CONTENT_MARKER), "{}")
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_PROTECTED"
    )
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("rejects extra manifest registrations and configuration not represented in native source", async () => {
    const f = await fixture()
    const file = join(f.installed, "plugin.json")
    const metadata = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...metadata, hooks: "hooks/verify.py" }))
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_UNSUPPORTED"
    )
    await writeFile(file, JSON.stringify({ ...metadata, userConfig: {} }))
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_UNSUPPORTED"
    )
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("reports malformed retained source without exposing its bytes", async () => {
    const f = await fixture()
    await writeFile(join(f.installed, "composition/source.json"), "PRIVATE_BROKEN_SOURCE")
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow(
      "PROJECT_PLUGIN_SOURCE_INVALID"
    )
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("rejects a missing declared resource and a mismatched expected digest", async () => {
    const f = await fixture()
    await expect(
      projectFromInstalledPlugin({ ...f.input, sourceDigest: "0".repeat(64) })
    ).rejects.toThrow("PROJECT_PLUGIN_SOURCE_CHANGED")
    await rm(join(f.installed, "knowledge/policy.md"))
    await expect(projectFromInstalledPlugin(f.input)).rejects.toThrow("PROJECT_RESOURCE_MISSING")
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("rejects installation identity changes before saving", async () => {
    const f = await fixture()
    let reads = 0
    await expect(
      projectFromInstalledPlugin({
        ...f.input,
        plugins: () => {
          if (++reads > 1) f.plugin.version = "2.0.0"
          return [f.plugin]
        }
      })
    ).rejects.toThrow("PROJECT_PLUGIN_SOURCE_CHANGED")
    expect(f.sessions.list(scope)).toEqual([])
  })

  it("detects source hot changes inside the draft write guards before publishing", async () => {
    const f = await fixture()
    let writing = false
    let guards = 0
    const save = f.sessions.save.bind(f.sessions)
    const sessions = {
      save: (...args: Parameters<typeof save>) => {
        writing = true
        return save(...args)
      }
    }
    await expect(
      projectFromInstalledPlugin({
        ...f.input,
        sessions,
        guard: () => {
          if (writing && ++guards === 4)
            writeFileSync(join(f.installed, "knowledge/policy.md"), "Changed during write")
        }
      })
    ).rejects.toThrow("PROJECT_PLUGIN_SOURCE_CHANGED")
    expect(f.sessions.list(scope)).toEqual([])
    expect(f.make().list(scope)).toEqual([])
  })

  it("honors creator scope invalidation during source preparation", async () => {
    const f = await fixture()
    let calls = 0
    await expect(
      projectFromInstalledPlugin({
        ...f.input,
        guard: () => {
          if (++calls > 1) throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      })
    ).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(f.sessions.list(scope)).toEqual([])
    expect(await readFile(join(f.installed, "knowledge/policy.md"), "utf8")).toBe(
      "Preserve original knowledge\r\n"
    )
  })
})
