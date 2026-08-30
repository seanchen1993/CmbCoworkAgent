import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { SkillPluginCatalogPage } from "../types"
import {
  commitCanonicalDisabledSkillMutation,
  DisabledSkillMutationQueue,
  normalizeDisabledSkillMigrationEntries,
  readCanonicalDisabledSkillSnapshot
} from "./disabled-state-mutation"
import { fingerprintDisabledSkillStoreText } from "./disabled-store-fingerprint"

const DEFAULT_STORE_FINGERPRINT = fingerprintDisabledSkillStoreText("[]")

function page(
  disabledSkillIds: string[],
  cursor: string | null,
  options: {
    truncated?: boolean
    reasons?: string[]
    sourceKey?: string
    catalogGlobalRevision?: number
    sourceRevision?: number
    storeFingerprint?: string
  } = {}
): SkillPluginCatalogPage {
  return {
    kind: "disabled",
    sourceKey: options.sourceKey ?? "source-a",
    catalogGlobalRevision: options.catalogGlobalRevision ?? 0,
    disabledSkillsRevision: options.sourceRevision ?? 0,
    disabledStoreFingerprint: options.storeFingerprint ?? DEFAULT_STORE_FINGERPRINT,
    skills: [],
    plugins: [],
    disabledSkillIds,
    cursor,
    total: disabledSkillIds.length,
    enabledSkillCount: 0,
    truncated: options.truncated ?? false,
    truncatedReasons: options.reasons ?? [],
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 }
  }
}

describe("disabled skill mutation worker bridge", () => {
  it("collects every canonical page and rejects incomplete snapshots", async () => {
    const inputs: Array<string | null | undefined> = []
    await expect(
      readCanonicalDisabledSkillSnapshot(async (input) => {
        inputs.push(input.cursor)
        return input.cursor ? page(["canonical-b"], null) : page(["canonical-a"], "next")
      })
    ).resolves.toEqual({
      disabledSkillIds: ["canonical-a", "canonical-b"],
      sourceKey: "source-a",
      catalogGlobalRevision: 0,
      sourceRevision: 0,
      storeFingerprint: DEFAULT_STORE_FINGERPRINT
    })
    expect(inputs).toEqual([null, "next"])

    await expect(
      readCanonicalDisabledSkillSnapshot(async () =>
        page(["partial"], null, { truncated: true, reasons: ["read-byte-budget"] })
      )
    ).rejects.toThrow("扫描不完整")

    await expect(
      readCanonicalDisabledSkillSnapshot(async () => ({
        ...page([], null),
        disabledStoreFingerprint: undefined
      }))
    ).rejects.toThrow("store fingerprint")
  })

  it("serializes worker resolution and persistence across windows", async () => {
    const queue = new DisabledSkillMutationQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = queue.run(async () => {
      order.push("first-start")
      await firstBlocked
      order.push("first-end")
    })
    const second = queue.run(async () => {
      order.push("second")
    })
    await Promise.resolve()
    expect(order).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  it("rejects mixed paging sources instead of combining stale and fresh ids", async () => {
    await expect(
      readCanonicalDisabledSkillSnapshot(async (input) =>
        input.cursor
          ? page(["fresh-b"], null, { sourceKey: "fresh", sourceRevision: 2 })
          : page(["stale-a"], "next", { sourceKey: "stale", sourceRevision: 1 })
      )
    ).rejects.toThrow("source changed")

    await expect(
      readCanonicalDisabledSkillSnapshot(async (input) =>
        input.cursor
          ? page(["fresh-b"], null, { catalogGlobalRevision: 2 })
          : page(["stale-a"], "next", { catalogGlobalRevision: 1 })
      )
    ).rejects.toThrow("source changed")

    await expect(
      readCanonicalDisabledSkillSnapshot(async (input) =>
        input.cursor
          ? page(["fresh-b"], null, {
              storeFingerprint: fingerprintDisabledSkillStoreText('["fresh-b"]')
            })
          : page(["stale-a"], "next", {
              storeFingerprint: fingerprintDisabledSkillStoreText('["stale-a"]')
            })
      )
    ).rejects.toThrow("source changed")
  })

  it("rescans after a CAS conflict and commits only the latest Worker source", async () => {
    let scan = 0
    const committedRevisions: number[] = []
    await expect(
      commitCanonicalDisabledSkillMutation(
        async () => {
          scan += 1
          return page([`canonical-${scan}`], null, {
            sourceKey: `source-${scan}`,
            sourceRevision: scan
          })
        },
        (snapshot) => {
          committedRevisions.push(snapshot.sourceRevision)
          return snapshot.sourceRevision === 1 ? null : snapshot.disabledSkillIds
        }
      )
    ).resolves.toEqual(["canonical-2"])
    expect(committedRevisions).toEqual([1, 2])
  })

  it("does not start a Worker scan until the topology becomes idle", async () => {
    const {
      beginSkillCatalogTopologyMutation,
      getSkillCatalogTopologyRevision
    } = await import("../skill-plugin-catalog/topology-mutation-gate")
    const endMutation = beginSkillCatalogTopologyMutation()
    let scans = 0
    const committed = commitCanonicalDisabledSkillMutation(
      async () => {
        scans += 1
        return page(["fresh"], null, {
          catalogGlobalRevision: getSkillCatalogTopologyRevision()
        })
      },
      (snapshot) => snapshot.disabledSkillIds
    )
    await Promise.resolve()
    expect(scans).toBe(0)
    endMutation()

    await expect(committed).resolves.toEqual(["fresh"])
    expect(scans).toBe(1)
  })

  it("bounds legacy migration input and wires it through the Worker/CAS path", () => {
    expect(normalizeDisabledSkillMigrationEntries(["Legacy Name", 42, "canonical"])).toEqual([
      "Legacy Name",
      "canonical"
    ])
    expect(() => normalizeDisabledSkillMigrationEntries(["x".repeat(4_097)])).toThrow(
      "too long"
    )

    const ipcSource = readFileSync(new URL("../ipc/skills.ts", import.meta.url), "utf8")
    const migrationBlock = ipcSource.slice(
      ipcSource.indexOf('ipcMain.handle("skills:setDisabled"'),
      ipcSource.indexOf('"skills:setDisabledState"')
    )
    expect(migrationBlock).toContain("mergeDisabledSkillIds: migrationEntries")
    expect(migrationBlock).toContain("compareAndSetCanonicalDisabledSkills")
    expect(migrationBlock).not.toContain("discoverSkills")
  })
})
