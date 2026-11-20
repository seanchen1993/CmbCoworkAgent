import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
  fingerprintDisabledSkillStoreText
} from "./skills/disabled-store-fingerprint"

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: vi.fn() }
}))

describe("atomic disabled-skill persistence", () => {
  let tempRoot: string
  let isolatedHome: string
  const previousOverride = process.env.CMB_COWORK_AGENT_HOME

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "cmb-disabled-skills-"))
    isolatedHome = join(tempRoot, "app-data")
    process.env.CMB_COWORK_AGENT_HOME = isolatedHome
    vi.resetModules()
  })

  afterEach(async () => {
    if (previousOverride === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previousOverride
    vi.restoreAllMocks()
    vi.doUnmock("fs")
    vi.resetModules()
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function createStandaloneSkill(id: string, name = id): Promise<void> {
    const skillDir = join(isolatedHome, "skills", id)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`)
  }

  async function createSameNameStandaloneAndPluginHooks(): Promise<void> {
    await createStandaloneSkill("shared", "shared")
    await writeFile(
      join(isolatedHome, "skills", "shared", "SKILL.md"),
      "---\nname: shared\n---\n\nSTANDALONE_GUIDANCE\n"
    )
    await writeFile(
      join(isolatedHome, "skills", "shared", "hooks.json"),
      JSON.stringify([{ id: "standalone", event: "PreToolUse", type: "command", command: "echo standalone" }])
    )
    const pluginRoot = join(isolatedHome, "plugins", "plugin-a")
    const pluginSkillDir = join(pluginRoot, "skills", "shared")
    await mkdir(pluginSkillDir, { recursive: true })
    await writeFile(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "Plugin A", skills: "skills" })
    )
    await writeFile(
      join(pluginSkillDir, "SKILL.md"),
      "---\nname: shared\n---\n\nPLUGIN_GUIDANCE\n"
    )
    await writeFile(
      join(pluginSkillDir, "hooks.json"),
      JSON.stringify([{ id: "plugin", event: "PreToolUse", type: "command", command: "echo plugin" }])
    )
    await mkdir(isolatedHome, { recursive: true })
    await writeFile(
      join(isolatedHome, "plugins.json"),
      JSON.stringify([{ id: "plugin-a", name: "Plugin A", path: pluginRoot, enabled: true }])
    )
  }

  async function currentDisabledStoreFingerprint(): Promise<string> {
    try {
      return fingerprintDisabledSkillStoreText(
        await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return DISABLED_SKILL_STORE_MISSING_FINGERPRINT
      }
      throw error
    }
  }

  async function currentCatalogGlobalRevision(): Promise<number> {
    const { getHookCatalogGlobalRevision } = await import("./hook-catalog/revision")
    return getHookCatalogGlobalRevision()
  }

  async function writeInvalidDisabledStore(
    kind: "malformed" | "non-array" | "directory" | "too-large" | "too-many" | "overlong"
  ): Promise<void> {
    const storePath = join(isolatedHome, "disabled-skills.json")
    await rm(storePath, { recursive: true, force: true })
    await mkdir(isolatedHome, { recursive: true })
    if (kind === "directory") {
      await mkdir(storePath)
    } else if (kind === "malformed") {
      await writeFile(storePath, '["canonical-review"')
    } else if (kind === "non-array") {
      await writeFile(storePath, '{"disabled":[]}')
    } else if (kind === "too-large") {
      await writeFile(storePath, "x".repeat(2 * 1024 * 1024 + 1))
    } else if (kind === "too-many") {
      await writeFile(storePath, JSON.stringify(Array.from({ length: 20_001 }, () => "x")))
    } else {
      await writeFile(storePath, JSON.stringify(["x".repeat(4_097)]))
    }
  }

  it.each([
    "malformed",
    "non-array",
    "directory",
    "too-large",
    "too-many",
    "overlong"
  ] as const)("reuses canonical LKG for %s stores and denies on cold start", async (kind) => {
    await createStandaloneSkill("canonical-review", "Legacy Review")
    await mkdir(isolatedHome, { recursive: true })
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["Legacy Review"]')
    const storage = await import("./storage")
    const primed = storage.getDisabledSkillRuntimePolicy()
    expect(primed.disabledSkillIds).toContain("canonical-review")
    expect(primed.disabledSkillDirs).toContain(
      join(isolatedHome, "skills", "canonical-review")
    )

    await writeInvalidDisabledStore(kind)
    storage.invalidateEnabledSkillsCache()
    const fallback = storage.getDisabledSkillRuntimePolicy()
    expect(fallback.denyAllStandaloneSkills).toBe(false)
    expect(fallback.disabledSkillIds).toContain("canonical-review")

    vi.resetModules()
    const coldStorage = await import("./storage")
    expect(coldStorage.getDisabledSkillRuntimePolicy().denyAllStandaloneSkills).toBe(true)
    expect(coldStorage.getDisabledSkillDirs()).toEqual(coldStorage.getSkillsSources())
  })

  it("keeps canonical LKG across an unannounced alias edit but denies after topology advances", async () => {
    await createStandaloneSkill("canonical-review", "Legacy Review")
    await mkdir(isolatedHome, { recursive: true })
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["Legacy Review"]')
    const storage = await import("./storage")
    expect(storage.getDisabledSkillRuntimePolicy().disabledSkillIds).toContain(
      "canonical-review"
    )

    await writeFile(
      join(isolatedHome, "skills", "canonical-review", "SKILL.md"),
      "---\nname: Renamed Review\n---\n"
    )
    await writeInvalidDisabledStore("malformed")
    const unchangedRevisionPolicy = storage.getDisabledSkillRuntimePolicy()
    expect(unchangedRevisionPolicy.disabledSkillIds).toContain("canonical-review")
    expect(storage.getDisabledSkillDirs()).toContain(
      join(isolatedHome, "skills", "canonical-review")
    )

    const { bumpHookCatalogGlobalRevision } = await import("./hook-catalog/revision")
    bumpHookCatalogGlobalRevision()
    expect(storage.getDisabledSkillRuntimePolicy().denyAllStandaloneSkills).toBe(true)
    expect(storage.getDisabledSkillDirs()).toEqual(storage.getSkillsSources())
  })

  it("does not let a warmed dirs policy bypass an active topology mutation", async () => {
    await createStandaloneSkill("visible-before-mutation")
    const storage = await import("./storage")
    expect(storage.getDisabledSkillDirs()).toEqual([])
    const topology = await import("./skill-plugin-catalog/topology-mutation-gate")
    const endMutation = topology.beginSkillCatalogTopologyMutation()
    try {
      expect(storage.getDisabledSkillRuntimePolicy().denyAllStandaloneSkills).toBe(true)
      expect(storage.getDisabledSkillDirs()).toEqual(storage.getSkillsSources())
    } finally {
      endMutation()
    }
  })

  it("uses LKG for EACCES and denies without one", async () => {
    await createStandaloneSkill("canonical-review")
    await mkdir(isolatedHome, { recursive: true })
    const storePath = join(isolatedHome, "disabled-skills.json")
    await writeFile(storePath, '["canonical-review"]')
    let denyRead = false
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        readFileSync: (...args: unknown[]) => {
          if (denyRead && String(args[0]) === storePath) {
            const error = new Error("access denied") as NodeJS.ErrnoException
            error.code = "EACCES"
            throw error
          }
          return Reflect.apply(actual.readFileSync, actual, args)
        }
      }
    })
    const storage = await import("./storage")
    expect(storage.getDisabledSkillRuntimePolicy().disabledSkillIds).toContain(
      "canonical-review"
    )
    denyRead = true
    expect(storage.getDisabledSkillRuntimePolicy().disabledSkillIds).toContain(
      "canonical-review"
    )

    vi.resetModules()
    const coldStorage = await import("./storage")
    expect(coldStorage.getDisabledSkillRuntimePolicy().denyAllStandaloneSkills).toBe(true)
  })

  it("keeps plugin hooks and same-name required skill while cold-invalid standalone skills stay denied", async () => {
    await createSameNameStandaloneAndPluginHooks()
    await writeInvalidDisabledStore("malformed")
    const storage = await import("./storage")
    const hooks = storage.getEnabledSkillHookMetadata()
    expect(hooks.some((hook) => hook.pluginId === "plugin-a")).toBe(true)
    expect(hooks.some((hook) => !hook.pluginId)).toBe(false)

    const { enrichHookResultWithRequiredSkill } = await import("./hooks/required-skill")
    const enriched = await enrichHookResultWithRequiredSkill({
      exitCode: 1,
      stdout: "",
      stderr: "",
      blocked: true,
      requiredSkill: "shared"
    })
    expect(enriched?.additionalContext).toContain("PLUGIN_GUIDANCE")
    expect(enriched?.additionalContext).not.toContain("STANDALONE_GUIDANCE")
  })

  it("cleans managed Claude copies and bypasses warmed standalone hook caches while busy", async () => {
    await createSameNameStandaloneAndPluginHooks()
    const storage = await import("./storage")
    expect(storage.getEnabledSkillHookMetadata().some((hook) => !hook.pluginId)).toBe(true)

    const topology = await import("./skill-plugin-catalog/topology-mutation-gate")
    const endMutation = topology.beginSkillCatalogTopologyMutation()
    try {
      const busyHooks = storage.getEnabledSkillHooks()
      expect(busyHooks.some((hook) => !Reflect.has(hook, "pluginId"))).toBe(false)
      expect(busyHooks.some((hook) => Reflect.get(hook, "pluginId") === "plugin-a")).toBe(true)
    } finally {
      endMutation()
    }

    await writeInvalidDisabledStore("malformed")
    vi.resetModules()
    const coldStorage = await import("./storage")
    const workDir = join(tempRoot, "workspace")
    const staleManagedDir = join(workDir, ".claude", "skills", "_cmb_stale")
    await mkdir(staleManagedDir, { recursive: true })
    await writeFile(join(staleManagedDir, "SKILL.md"), "stale")
    await coldStorage.syncSkillsToClaudeDir(workDir)
    const copied = await readdir(join(workDir, ".claude", "skills"))
    expect(copied.filter((name) => name.startsWith("_cmb_"))).toEqual([])
  })

  it("merges single-skill changes from renderers that started with stale snapshots", async () => {
    await createStandaloneSkill("atomic-window-a")
    await createStandaloneSkill("atomic-window-b")
    const storage = await import("./storage")

    const windowASnapshot = storage.getDisabledSkills()
    const windowBSnapshot = storage.getDisabledSkills()
    expect(windowASnapshot).toEqual([])
    expect(windowBSnapshot).toEqual([])

    expect(storage.setSkillDisabledState("atomic-window-a", true)).toEqual([
      "atomic-window-a"
    ])
    expect(storage.setSkillDisabledState("atomic-window-b", true)).toEqual([
      "atomic-window-a",
      "atomic-window-b"
    ])
    expect(storage.setSkillDisabledState("atomic-window-a", false)).toEqual([
      "atomic-window-b"
    ])
    expect(storage.getDisabledSkills()).toEqual(["atomic-window-b"])

    vi.resetModules()
    const restartedStorage = await import("./storage")
    expect(restartedStorage.getDisabledSkills()).toEqual(["atomic-window-b"])
  })

  it("keeps a plugin-owned id isolated from a same-name standalone skill", async () => {
    await createStandaloneSkill("review", "Same name")
    const storage = await import("./storage")

    expect(storage.setSkillDisabledState("plugin:enabled/review", true)).toEqual([])
    expect(storage.setSkillDisabledState("review", true)).toEqual(["review"])
    expect(storage.setSkillDisabledState("plugin:enabled/review", false)).toEqual(["review"])
    expect(storage.getDisabledSkills()).toEqual(["review"])
  })

  it("does not discover or read the full catalog while toggling one canonical id", async () => {
    const bulkRoot = join(isolatedHome, "skills", "bulk")
    for (let offset = 0; offset < 1_024; offset += 128) {
      await Promise.all(
        Array.from({ length: 128 }, async (_, index) => {
          const ordinal = offset + index
          const skillDir = join(bulkRoot, `skill-${String(ordinal).padStart(4, "0")}`)
          await mkdir(skillDir, { recursive: true })
          await writeFile(
            join(skillDir, "SKILL.md"),
            `---\nname: bulk-${ordinal}\n---\n${"x".repeat(4_096)}`
          )
        })
      )
    }

    const discovery = await import("./skills/discovery")
    const discoverSpy = vi.spyOn(discovery, "discoverSkillsSync")
    const storage = await import("./storage")

    expect(storage.setSkillDisabledState("bulk/skill-1023", true)).toEqual([
      "bulk/skill-1023"
    ])
    expect(storage.setSkillDisabledState("bulk/skill-1023", false)).toEqual([])
    expect(
      storage.compareAndSetCanonicalDisabledSkills(
        ["bulk/skill-1023"],
        storage.getDisabledSkillsRevision(),
        await currentDisabledStoreFingerprint(),
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["bulk/skill-1023"] })
    expect(discoverSpy).not.toHaveBeenCalled()
    expect(
      JSON.parse(
        await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")
      )
    ).toEqual(["bulk/skill-1023"])
  }, 30_000)

  it("canonicalizes a raw legacy alias off-main before applying a single mutation", async () => {
    await createStandaloneSkill("canonical-review", "Legacy Review")
    const storage = await import("./storage")

    await mkdir(isolatedHome, { recursive: true })
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["Legacy Review"]')
    expect(
      storage.setSkillDisabledState("canonical-review", false, ["canonical-review"])
    ).toEqual([])
    expect(JSON.parse(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8"))).toEqual(
      []
    )

    await createStandaloneSkill("review-a", "Shared Legacy Name")
    await createStandaloneSkill("review-b", "Shared Legacy Name")
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["Shared Legacy Name"]')
    expect(
      storage.setSkillDisabledState("review-a", false, ["review-a", "review-b"])
    ).toEqual(["review-b"])
    expect(JSON.parse(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8"))).toEqual(
      ["review-b"]
    )
  })

  it("rejects a stale Worker snapshot and preserves every intervening writer", async () => {
    await createStandaloneSkill("cas-a")
    await createStandaloneSkill("cas-b")
    const storage = await import("./storage")
    const staleRevision = storage.getDisabledSkillsRevision()
    const staleFingerprint = await currentDisabledStoreFingerprint()

    expect(storage.setSkillDisabledState("cas-a", true)).toEqual(["cas-a"])
    expect(
      storage.compareAndSetSkillDisabledState(
        "cas-b",
        true,
        [],
        staleRevision,
        staleFingerprint,
        await currentCatalogGlobalRevision()
      )
    ).toBeNull()

    const latestRevision = storage.getDisabledSkillsRevision()
    expect(
      storage.compareAndSetSkillDisabledState(
        "cas-b",
        true,
        ["cas-a"],
        latestRevision,
        await currentDisabledStoreFingerprint(),
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["cas-a", "cas-b"] })
    expect(storage.getDisabledSkills()).toEqual(["cas-a", "cas-b"])
  })

  it("rejects an old alias identity after the catalog topology revision advances", async () => {
    await createStandaloneSkill("old-identity", "Legacy Alias")
    await createStandaloneSkill("new-identity", "Renamed Alias")
    await mkdir(isolatedHome, { recursive: true })
    const storePath = join(isolatedHome, "disabled-skills.json")
    const original = '["Legacy Alias"]'
    await writeFile(storePath, original)
    const storage = await import("./storage")
    const sourceRevision = storage.getDisabledSkillsRevision()
    const sourceFingerprint = await currentDisabledStoreFingerprint()
    const sourceCatalogRevision = await currentCatalogGlobalRevision()
    const { bumpHookCatalogGlobalRevision } = await import("./hook-catalog/revision")
    bumpHookCatalogGlobalRevision()

    expect(
      storage.compareAndSetCanonicalDisabledSkills(
        ["old-identity"],
        sourceRevision,
        sourceFingerprint,
        sourceCatalogRevision
      )
    ).toBeNull()
    expect(await readFile(storePath, "utf-8")).toBe(original)

    expect(
      storage.compareAndSetCanonicalDisabledSkills(
        ["new-identity"],
        storage.getDisabledSkillsRevision(),
        await currentDisabledStoreFingerprint(),
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["new-identity"] })
  })

  it("never writes during a topology mutation and accepts a fresh idle snapshot", async () => {
    await createStandaloneSkill("target")
    const storage = await import("./storage")
    const topology = await import("./skill-plugin-catalog/topology-mutation-gate")
    const storePath = join(isolatedHome, "disabled-skills.json")
    const endMutation = topology.beginSkillCatalogTopologyMutation()
    expect(
      storage.compareAndSetSkillDisabledState(
        "target",
        true,
        [],
        storage.getDisabledSkillsRevision(),
        DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
        await currentCatalogGlobalRevision()
      )
    ).toBeNull()
    await expect(readFile(storePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" })
    endMutation()

    expect(
      storage.compareAndSetSkillDisabledState(
        "target",
        true,
        [],
        storage.getDisabledSkillsRevision(),
        DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["target"] })
  })

  it("rejects external writes that arrive before a delayed fs.watch revision", async () => {
    for (const id of ["snapshot-a", "external-b", "external-c", "target"]) {
      await createStandaloneSkill(id)
    }
    await mkdir(isolatedHome, { recursive: true })
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["snapshot-a"]')
    const storage = await import("./storage")

    const firstRevision = storage.getDisabledSkillsRevision()
    const firstFingerprint = await currentDisabledStoreFingerprint()
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["external-b"]')

    expect(
      storage.compareAndSetSkillDisabledState(
        "target",
        true,
        ["snapshot-a"],
        firstRevision,
        firstFingerprint,
        await currentCatalogGlobalRevision()
      )
    ).toBeNull()
    expect(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")).toBe(
      '["external-b"]'
    )
    expect(storage.getDisabledSkillsRevision()).toBe(firstRevision + 1)

    const secondRevision = storage.getDisabledSkillsRevision()
    const secondFingerprint = await currentDisabledStoreFingerprint()
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["external-c"]')
    expect(
      storage.compareAndSetCanonicalDisabledSkills(
        ["external-b", "target"],
        secondRevision,
        secondFingerprint,
        await currentCatalogGlobalRevision()
      )
    ).toBeNull()
    expect(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")).toBe(
      '["external-c"]'
    )

    expect(
      storage.compareAndSetSkillDisabledState(
        "target",
        true,
        ["external-c"],
        storage.getDisabledSkillsRevision(),
        await currentDisabledStoreFingerprint(),
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["external-c", "target"] })
  })

  it("preserves a late malformed external write for the Worker to reject", async () => {
    await createStandaloneSkill("snapshot-a")
    await createStandaloneSkill("target")
    await mkdir(isolatedHome, { recursive: true })
    await writeFile(join(isolatedHome, "disabled-skills.json"), '["snapshot-a"]')
    const storage = await import("./storage")
    const sourceRevision = storage.getDisabledSkillsRevision()
    const sourceFingerprint = await currentDisabledStoreFingerprint()
    const malformed = '["external-b"'
    await writeFile(join(isolatedHome, "disabled-skills.json"), malformed)

    expect(
      storage.compareAndSetSkillDisabledState(
        "target",
        true,
        ["snapshot-a"],
        sourceRevision,
        sourceFingerprint,
        await currentCatalogGlobalRevision()
      )
    ).toBeNull()
    expect(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")).toBe(
      malformed
    )
    expect(storage.getDisabledSkillsRevision()).toBe(sourceRevision + 1)
  })

  it("never lets direct or cleanup mutations overwrite an invalid store", async () => {
    await createStandaloneSkill("delete-me")
    await createStandaloneSkill("target")
    const storage = await import("./storage")
    storage.setSkillDisabledState("delete-me", true)
    const delayedCleanup = storage.prepareDisabledSkillsCleanupForSkillDir(
      join(isolatedHome, "skills", "delete-me")
    )
    const malformed = '["delete-me"'
    await writeFile(join(isolatedHome, "disabled-skills.json"), malformed)

    expect(() => storage.setSkillDisabledState("target", true)).toThrow(
      "refusing to overwrite"
    )
    storage.clearDisabledSkillsForSkillDir(join(isolatedHome, "skills", "delete-me"))
    delayedCleanup()

    expect(await readFile(join(isolatedHome, "disabled-skills.json"), "utf-8")).toBe(
      malformed
    )
  })

  it("uses the missing-store fingerprint for a first disabled-skill write", async () => {
    await createStandaloneSkill("first-toggle")
    const storage = await import("./storage")

    expect(
      storage.compareAndSetSkillDisabledState(
        "first-toggle",
        true,
        [],
        storage.getDisabledSkillsRevision(),
        DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["first-toggle"] })
  })

  it("merges a stale legacy-window migration with a newer cross-window toggle", async () => {
    await createStandaloneSkill("legacy-y")
    await createStandaloneSkill("window-b-x")
    const storage = await import("./storage")

    // Window A observed the old store before Window B committed x.
    expect(storage.getDisabledSkills()).toEqual([])
    storage.setSkillDisabledState("window-b-x", true)
    const workerSourceRevision = storage.getDisabledSkillsRevision()
    expect(
      storage.compareAndSetCanonicalDisabledSkills(
        ["window-b-x", "legacy-y"],
        workerSourceRevision,
        await currentDisabledStoreFingerprint(),
        await currentCatalogGlobalRevision()
      )
    ).toMatchObject({ disabledSkillIds: ["window-b-x", "legacy-y"] })
    expect(storage.getDisabledSkills()).toEqual(["window-b-x", "legacy-y"])
  })

  it("re-reads the store when a delayed delete cleanup finally executes", async () => {
    await createStandaloneSkill("delete-me")
    await createStandaloneSkill("concurrent-toggle")
    const storage = await import("./storage")
    storage.setSkillDisabledState("delete-me", true)

    const deletedDir = join(isolatedHome, "skills", "delete-me")
    const cleanup = storage.prepareDisabledSkillsCleanupForSkillDir(deletedDir)
    storage.setSkillDisabledState("concurrent-toggle", true)
    await rm(deletedDir, { recursive: true, force: true })
    cleanup()

    expect(storage.getDisabledSkills()).toEqual(["concurrent-toggle"])
  })

  it("rejects malformed, legacy-alias and plugin ids on the synchronous write edge", async () => {
    await createStandaloneSkill("canonical-review", "Legacy Review")
    const storage = await import("./storage")
    expect(storage.setSkillDisabledState("canonical-review", true)).toEqual([
      "canonical-review"
    ])

    for (const invalidId of [
      "plugin:enabled/canonical-review",
      "Canonical-Review",
      " canonical-review",
      "/canonical-review",
      "canonical-review\\child",
      "canonical-review//child",
      "canonical-review/../child",
      "one/two/three/four"
    ]) {
      expect(storage.setSkillDisabledState(invalidId, false)).toEqual(["canonical-review"])
    }

    expect(storage.setSkillDisabledState("legacy review", false)).toEqual([
      "canonical-review"
    ])
    expect(storage.setSkillDisabledState("canonical-review", false)).toEqual([])
  })
})
