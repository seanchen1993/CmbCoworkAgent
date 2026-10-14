import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, cp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PluginDerivationService } from "./derivation-service"
import { renameDerivation, snapshotDerivationSource } from "./derivation-source"
import {
  setDerivationFamilies,
  derivationVisibility,
  derivationFamilyFor,
  observeDerivationInstallation
} from "./derivation-scope"
import type { PluginMetadata } from "../types"
import type { PluginDerivationCopy } from "../../shared/plugin-derivation"

const roots: string[] = []
afterEach(async () => {
  setDerivationFamilies([])
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "derivation-test-"))
  roots.push(root)
  const source = join(root, "original")
  await mkdir(join(source, "skills", "build"), { recursive: true })
  await mkdir(join(source, "hooks"))
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "original",
      version: "1.0.0",
      author: "test",
      skills: "skills",
      hooks: "hooks/hooks.json",
      mcpServers: ".mcp.json",
      custom: { preserved: true }
    })
  )
  await writeFile(
    join(source, "skills/build/SKILL.md"),
    "# Original skill\nRun the real validator.\n"
  )
  await writeFile(join(source, "hooks/hooks.json"), '{"hooks": {}}')
  await writeFile(join(source, "hooks/validator.py"), "print('actual validation')\n")
  await writeFile(join(source, ".mcp.json"), '{"mcpServers":{}}')
  const plugins: PluginMetadata[] = [
    {
      id: "original-id",
      name: "original",
      path: source,
      version: "1.0.0",
      enabled: true,
      author: "test",
      description: "",
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  const install = vi.fn(
    async (
      directory: string,
      name: string,
      id: string,
      guard: () => void,
      verify: (directory: string) => Promise<void>
    ) => {
      const target = join(root, `installed-${id}`)
      await cp(directory, target, { recursive: true })
      await verify(target)
      guard()
      plugins.push({ ...plugins[0], name, id, path: target, enabled: false })
      return { success: true }
    }
  )
  const deps = { plugins: () => plugins, install, invalidate: vi.fn() }
  const service = new PluginDerivationService(join(root, "copies"), deps)
  const inspect = await service.inspect(source, "workspace", () => {}, "original-id")
  const create = () =>
    service.create("workspace", inspect.inspectionId, "my-plugin", randomUUID(), () => {})
  return { root, source, service, inspect, create, install, deps }
}

describe("complete plugin derivation", () => {
  it("revises the installed version as a new disabled family member without mutating old files", async () => {
    const f = await fixture()
    const copy = await f.create()
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    const installed = await f.service.install("workspace", copy.copyId, checked.digest, () => {})
    const oldPlugin = f.deps.plugins().find((plugin) => plugin.id === installed.pluginId)!
    const oldSnapshot = await snapshotDerivationSource(oldPlugin.path)
    // The editable source folder is not the authority for a previously installed version.
    await writeFile(
      join(f.service.sourcePath(copy.copyId, "workspace"), "skills/build/SKILL.md"),
      "tampered draft"
    )
    const requestId = randomUUID()
    const draft = await f.service.revise("workspace", copy.copyId, requestId, () => {})
    expect(draft.parentCopyId).toBe(copy.copyId)
    expect(draft.name).toBe("my-plugin-v2")
    expect(draft.status).toBe("created")
    expect(await f.service.revise("workspace", copy.copyId, requestId, () => {})).toEqual(draft)
    expect(
      (await f.service.readFile("workspace", draft.copyId, "skills/build/SKILL.md", () => {})).text
    ).not.toContain("tampered")
    await expect(
      f.service.saveNotes("workspace", copy.copyId, "change", copy.digest, () => {})
    ).rejects.toThrow("不能覆盖")
    const next = await f.service.check("workspace", draft.copyId, () => {})
    const published = await f.service.install("workspace", draft.copyId, next.digest, () => {})
    expect(published.pluginId).not.toBe(installed.pluginId)
    expect(f.deps.plugins().find((plugin) => plugin.id === published.pluginId)?.enabled).toBe(false)
    expect(derivationFamilyFor(published.pluginId!)?.familyId).toBe(
      derivationFamilyFor(installed.pluginId!)?.familyId
    )
    expect((await snapshotDerivationSource(oldPlugin.path)).digest).toBe(oldSnapshot.digest)
    await expect(
      f.service.revise("other-workspace", copy.copyId, randomUUID(), () => {})
    ).rejects.toThrow("找不到")
  })

  it("detects upstream content changes after restart and carries the original baseline through revisions", async () => {
    const f = await fixture()
    const copy = await f.create()
    expect((await f.service.inspectUpstream("workspace", copy.copyId, () => {})).state).toBe(
      "unchanged"
    )
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    await f.service.install("workspace", copy.copyId, checked.digest, () => {})
    const revision = await f.service.revise("workspace", copy.copyId, randomUUID(), () => {})
    await writeFile(join(f.source, "skills/build/SKILL.md"), "# Updated upstream\n")
    const restarted = new PluginDerivationService(join(f.root, "copies"), f.deps)
    const latest = await restarted.inspectUpstream("workspace", revision.copyId, () => {}, true)
    expect(latest.state).toBe("changed")
    expect(latest.inspection?.sourceName).toBe("original")
    const fresh = await restarted.create(
      "workspace",
      latest.inspection!.inspectionId,
      latest.inspection!.suggestedName,
      randomUUID(),
      () => {}
    )
    expect(
      (await restarted.readFile("workspace", fresh.copyId, "skills/build/SKILL.md", () => {})).text
    ).toContain("Updated upstream")
    f.deps.plugins().splice(0, 1)
    expect((await restarted.inspectUpstream("workspace", revision.copyId, () => {})).state).toBe(
      "unavailable"
    )
  })
  it("checks legacy copies using only their verified original identity and retained digest", async () => {
    const f = await fixture()
    const copy = await f.create()
    const ledgerPath = join(f.root, "copies", "ledger.json")
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"))
    delete ledger.copies[0].upstream
    await writeFile(ledgerPath, JSON.stringify(ledger))
    const restarted = new PluginDerivationService(join(f.root, "copies"), f.deps)
    expect((await restarted.inspectUpstream("workspace", copy.copyId, () => {})).state).toBe(
      "unchanged"
    )
    await writeFile(join(f.source, "skills/build/SKILL.md"), "# Upstream changed\n")
    expect((await restarted.inspectUpstream("workspace", copy.copyId, () => {})).state).toBe(
      "changed"
    )
  })
  it("keeps repeated automatic upstream reads free of source inspection capabilities", async () => {
    const f = await fixture()
    const copy = await f.create()
    for (let index = 0; index < 70; index++) {
      expect(await f.service.inspectUpstream("workspace", copy.copyId, () => {})).toEqual({
        state: "unchanged"
      })
    }
    const prepared = await f.service.inspectUpstream("workspace", copy.copyId, () => {}, true)
    expect(prepared.inspection?.inspectionId).toBeTruthy()
  })
  it("bounds concurrent upstream scans and releases the slot after completion", async () => {
    const f = await fixture()
    const copy = await f.create()
    const reading = f.service.inspectUpstream("workspace", copy.copyId, () => {})
    await expect(f.service.inspectUpstream("workspace", copy.copyId, () => {})).rejects.toThrow(
      "正在检查来源"
    )
    await reading
    expect((await f.service.inspectUpstream("workspace", copy.copyId, () => {})).state).toBe(
      "unchanged"
    )
  })
  it("reuses verified directory lineage and associates late installed and reinstalled originals", async () => {
    const f = await fixture()
    f.deps.plugins().splice(0)
    f.service = new PluginDerivationService(join(f.root, "directory-copies"), f.deps)
    await mkdir(join(f.source, ".git"))
    await mkdir(join(f.source, "__pycache__"))
    await writeFile(join(f.source, ".git", "HEAD"), "owned fixture")
    const packagedSource = join(f.root, "packaged-source")
    await cp(f.source, packagedSource, {
      recursive: true,
      filter: (path) => !path.endsWith(".git") && !path.endsWith("__pycache__")
    })
    expect((await snapshotDerivationSource(f.source)).digest).not.toBe(
      (await snapshotDerivationSource(packagedSource)).digest
    )
    const first = await f.service.inspect(f.source, "workspace", () => {})
    const second = await f.service.inspect(f.source, "workspace", () => {})
    const a = await f.service.create(
      "workspace",
      first.inspectionId,
      "copy-a",
      randomUUID(),
      () => {}
    )
    const b = await f.service.create(
      "workspace",
      second.inspectionId,
      "copy-b",
      randomUUID(),
      () => {}
    )
    const installed: PluginDerivationCopy[] = []
    for (const copy of [a, b]) {
      const checked = await f.service.check("workspace", copy.copyId, () => {})
      installed.push(await f.service.install("workspace", copy.copyId, checked.digest, () => {}))
    }
    const family = derivationFamilyFor(installed[0].pluginId!)!
    expect(family.members).toContain(installed[1].pluginId)
    await observeDerivationInstallation("late-original", packagedSource, "original")
    expect(derivationVisibility("late-original")).toEqual({
      derivationFamilyMembers: [...family.members, "late-original"],
      isDerivedPlugin: false
    })
    // Restart reloads only the host ledger; no package-authored identity is trusted.
    new PluginDerivationService(join(f.root, "directory-copies"), f.deps)
    await observeDerivationInstallation("reinstalled-original", packagedSource, "original")
    expect(derivationFamilyFor("reinstalled-original")?.familyId).toBe(family.familyId)
    expect(derivationVisibility("reinstalled-original").isDerivedPlugin).toBe(false)
    await writeFile(join(f.source, "hooks/validator.py"), "different source")
    await observeDerivationInstallation("impostor", f.source, "original")
    expect(derivationFamilyFor("impostor")).toBeUndefined()
  })
  it("refuses a current-source change after staging while the installer owns the catalog lock", async () => {
    const f = await fixture()
    const copy = await f.create()
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    f.install.mockImplementationOnce(async (directory, _name, _id, _guard, verify) => {
      await writeFile(
        join(f.service.sourcePath(copy.copyId, "workspace"), "hooks/validator.py"),
        "changed after staging"
      )
      await verify(directory)
      return { success: true }
    })
    await expect(
      f.service.install("workspace", copy.copyId, checked.digest, () => {})
    ).rejects.toThrow("源码已变化")
    expect(f.deps.plugins()).toHaveLength(1)
    expect(f.service.get(copy.copyId, "workspace").pluginId).toBeUndefined()
  })
  it("rechecks and retries a failed installation without treating its reserved UUID as installed", async () => {
    const f = await fixture()
    const copy = await f.create()
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    f.install.mockRejectedValueOnce(Error("temporary install failure"))
    await expect(
      f.service.install("workspace", copy.copyId, checked.digest, () => {})
    ).rejects.toThrow("temporary install failure")
    expect(f.service.get(copy.copyId, "workspace").pluginId).toBeUndefined()
    const rechecked = await f.service.check("workspace", copy.copyId, () => {})
    expect(rechecked.status).toBe("checked")
    expect(
      (await f.service.install("workspace", copy.copyId, rechecked.digest, () => {})).status
    ).toBe("installed")
    expect(f.deps.plugins()).toHaveLength(2)
  })
  it("preserves scripts, MCP, unknown manifest fields and makes idempotent independent source", async () => {
    const f = await fixture()
    const before = await snapshotDerivationSource(f.source)
    const request = randomUUID()
    const copy = await f.service.create(
      "workspace",
      f.inspect.inspectionId,
      "my-plugin",
      request,
      () => {}
    )
    expect(
      (await f.service.create("workspace", f.inspect.inspectionId, "my-plugin", request, () => {}))
        .copyId
    ).toBe(copy.copyId)
    const target = f.service.sourcePath(copy.copyId, "workspace")
    expect(JSON.parse(await readFile(join(target, "plugin.json"), "utf8"))).toMatchObject({
      name: "my-plugin",
      version: "1.0.0",
      custom: { preserved: true },
      mcpServers: ".mcp.json"
    })
    expect(await readFile(join(target, "hooks/validator.py"))).toEqual(
      await readFile(join(f.source, "hooks/validator.py"))
    )
    expect((await snapshotDerivationSource(f.source)).digest).toBe(before.digest)
    expect(f.install).not.toHaveBeenCalled()
    expect(
      new PluginDerivationService(join(f.root, "copies"), f.deps).get(copy.copyId, "workspace")
    ).toMatchObject({ status: "created", name: "my-plugin" })
  })
  it("rejects changed sources, duplicate names and wrong owners without installation", async () => {
    const f = await fixture()
    await expect(
      f.service.create("other", f.inspect.inspectionId, "mine", randomUUID(), () => {})
    ).rejects.toThrow("来源检查")
    await expect(
      f.service.create("workspace", f.inspect.inspectionId, "original", randomUUID(), () => {})
    ).rejects.toThrow("已存在")
    await writeFile(join(f.source, "hooks/validator.py"), "changed")
    await expect(f.create()).rejects.toThrow("来源已变化")
    expect(f.install).not.toHaveBeenCalled()
  })
  it("edits a real Skill with package digest CAS and installs once disabled with host lineage", async () => {
    const f = await fixture()
    const copy = await f.create()
    const path = "skills/build/SKILL.md"
    const file = await f.service.readFile("workspace", copy.copyId, path, () => {})
    const changed = await f.service.saveFile(
      "workspace",
      copy.copyId,
      path,
      "# New business rules\n",
      file.digest,
      () => {}
    )
    expect(changed.status).toBe("changed")
    await expect(
      f.service.saveFile("workspace", copy.copyId, path, "stale", file.digest, () => {})
    ).rejects.toThrow("源码已变化")
    expect(await readFile(join(f.source, path), "utf8")).toContain("Original skill")
    await expect(
      f.service.readFile("workspace", copy.copyId, "../plugin.json", () => {})
    ).rejects.toThrow("不能")
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    const installed = await f.service.install("workspace", copy.copyId, checked.digest, () => {})
    expect(installed.status).toBe("installed")
    expect(f.deps.plugins().find((plugin) => plugin.id === installed.pluginId)?.enabled).toBe(false)
    expect(derivationVisibility(installed.pluginId!)).toEqual({
      isDerivedPlugin: true,
      derivationFamilyMembers: ["original-id", installed.pluginId]
    })
    await f.service.install("workspace", copy.copyId, checked.digest, () => {})
    expect(f.install).toHaveBeenCalledOnce()
  })
  it("rejects source changes after check and late window guards", async () => {
    const f = await fixture()
    const copy = await f.create()
    const checked = await f.service.check("workspace", copy.copyId, () => {})
    await writeFile(
      join(f.service.sourcePath(copy.copyId, "workspace"), "hooks/validator.py"),
      "changed"
    )
    await expect(
      f.service.install("workspace", copy.copyId, checked.digest, () => {})
    ).rejects.toThrow("源码已变化")
    await expect(
      f.service.check("workspace", copy.copyId, () => {
        throw Error("scope changed")
      })
    ).rejects.toThrow("scope changed")
    expect(f.install).not.toHaveBeenCalled()
  })
  it("excludes credential names and state, but rejects a declared excluded dependency", async () => {
    const f = await fixture()
    await writeFile(join(f.source, ".env"), "fake fixture only")
    await mkdir(join(f.source, ".autobizdevops"))
    await writeFile(join(f.source, ".autobizdevops/state.json"), "{}")
    const snapshot = await snapshotDerivationSource(f.source)
    expect(snapshot.excluded).toEqual(expect.arrayContaining([".env", ".autobizdevops"]))
    expect(snapshot.files.some((file) => file.path === ".env")).toBe(false)
    await writeFile(
      join(f.source, "plugin.json"),
      JSON.stringify({ name: "original", hooks: ".env" })
    )
    await expect(snapshotDerivationSource(f.source)).rejects.toThrow("依赖缺失")
  })
  it("rejects hardlinks and directory junctions rather than silently omitting dependencies", async () => {
    const f = await fixture()
    await link(join(f.source, "hooks/validator.py"), join(f.source, "hard.py"))
    await expect(snapshotDerivationSource(f.source)).rejects.toThrow("链接")
    await rm(join(f.source, "hard.py"))
    await symlink(join(f.source, "hooks"), join(f.source, "linked"), "junction")
    await expect(snapshotDerivationSource(f.source)).rejects.toThrow("链接")
  })
  it("updates supported identities but rejects disagreeing manifests", async () => {
    const f = await fixture()
    await writeFile(
      join(f.source, "devclaw.project-runtime.json"),
      JSON.stringify({
        plugin: { id: "original", version: "1.0.0" },
        mode: "legacy"
      })
    )
    const snapshot = await snapshotDerivationSource(f.source)
    const files = renameDerivation(snapshot, "new-name")
    expect(
      JSON.parse(
        files.find((file) => file.path === "devclaw.project-runtime.json")!.bytes.toString()
      ).plugin
    ).toEqual({ id: "new-name", version: "1.0.0" })
    await mkdir(join(f.source, ".codex-plugin"))
    await writeFile(join(f.source, ".codex-plugin/plugin.json"), '{"name":"different"}')
    await expect(snapshotDerivationSource(f.source)).rejects.toThrow("身份不一致")
  })
})
