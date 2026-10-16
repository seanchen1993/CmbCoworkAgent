import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { ModControlStore } from "../control-store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { FlowStore, flowDigest, type FlowSettingsStore } from "./store"
import type { RecoveryHistoryRun, FlowRecoveryCandidate } from "./recovery-history"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const key = JSON.stringify(["diy-flow-v1", "runs", "workspace", "thread"])
function rootRun(): RecoveryHistoryRun {
  const definition = parseFlowDefinition({
    schemaVersion: 2,
    execution: { kind: "host" },
    id: "flow",
    name: "flow",
    goal: "test",
    timeoutMs: 60000,
    maxExecutions: 16,
    steps: [
      { id: "edit", name: "edit", kind: "agent", enabled: true, prompt: "edit" },
      { id: "review", name: "review", kind: "agent", enabled: true, prompt: "review" }
    ]
  })
  return {
    id: "root",
    workspace: "workspace",
    threadId: "thread",
    status: "running",
    startedAt: 1000,
    epoch: 0,
    failureCounts: {},
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 },
    attempts: [
      {
        executionId: "edit-execution",
        stepId: "edit",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: 1001,
        finishedAt: 1002,
        inputFingerprint: "before",
        outputFingerprint: "after",
        result: { source: "agent", passed: true, summary: "done" }
      }
    ]
  }
}
function request(root: RecoveryHistoryRun): FlowRecoveryCandidate {
  return {
    schemaVersion: 1,
    sourceRunId: root.id,
    sourceDigest: flowDigest(root),
    hostInactive: true,
    prefix: structuredClone(root.attempts)
  }
}
function reserve(
  store: FlowStore,
  root: RecoveryHistoryRun,
  childRunId = "child",
  assertCurrent = () => {}
) {
  return store.reserveRecovery("workspace", "thread", request(root), {
    childRunId,
    now: 2000,
    assertCurrent
  })
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-recovery-store-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "control.sqlite")
  const settings = new ModControlStore(path)
  cleanup.push(() => settings.close())
  const other = new ModControlStore(path)
  cleanup.push(() => other.close())
  const store = new FlowStore(settings),
    second = new FlowStore(other)
  const root = rootRun()
  store.put(root)
  return { path, settings, other, store, second, root }
}
function adapter(
  settings: ModControlStore,
  compareAndSetSetting?: FlowSettingsStore["compareAndSetSetting"]
): FlowSettingsStore {
  return {
    getSetting: settings.getSetting.bind(settings),
    setSetting: settings.setSetting.bind(settings),
    compareAndSetSetting
  }
}

describe("SQLite recovery history reservation (storage contract only)", () => {
  it("allows one source consumption across two stores and rejects every subsequent reservation", () => {
    const f = fixture()
    reserve(f.store, f.root)
    expect(() => reserve(f.second, f.root, "other")).toThrow("FLOW_RECOVERY_SOURCE_CONSUMED")
    expect(() => reserve(f.store, f.root, "third")).toThrow("FLOW_RECOVERY_SOURCE_CONSUMED")
    const rows = f.second.runs("workspace", "thread") as RecoveryHistoryRun[]
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === "root")?.recovery?.consumedBy).toBe("child")
    expect(rows.find((row) => row.id === "child")?.recovery?.parentRunId).toBe("root")
  })

  it("rejects an external writer between planning and CAS without losing the external value", () => {
    const f = fixture()
    const changed = { ...f.root, summary: "external" }
    const racing = new FlowStore(
      adapter(f.settings, (key, expected, value) => {
        f.second.put(changed)
        return f.settings.compareAndSetSetting(key, expected, value)
      })
    )
    expect(() => reserve(racing, f.root)).toThrow("FLOW_RECOVERY_STALE")
    expect(f.store.runs("workspace", "thread")).toEqual([changed])
  })

  it("prevents a stale ordinary put from erasing a reservation committed after its read", () => {
    const f = fixture()
    const racing = new FlowStore(
      adapter(f.settings, (key, expected, value) => {
        reserve(f.second, f.root)
        return f.settings.compareAndSetSetting(key, expected, value)
      })
    )
    expect(() => racing.put({ ...f.root, summary: "late old owner" })).toThrow(
      "FLOW_RECOVERY_STALE"
    )
    expect(f.store.runs("workspace", "thread")).toHaveLength(2)
    expect(
      (f.store.run("workspace", "thread", "root") as RecoveryHistoryRun).recovery?.consumedBy
    ).toBe("child")
  })

  it("requires an atomic adapter and never falls back to a history overwrite", () => {
    const f = fixture()
    const raw = f.settings.getSetting(key)
    expect(() => reserve(new FlowStore(adapter(f.settings)), f.root)).toThrow(
      "FLOW_RECOVERY_ATOMIC_STORE_REQUIRED"
    )
    expect(f.settings.getSetting(key)).toBe(raw)
  })

  it("cannot overwrite a newly created and consumed history after initially reading no row", () => {
    const f = fixture()
    const sql = new DatabaseSync(f.path)
    cleanup.push(() => sql.close())
    sql.prepare("DELETE FROM mods_meta WHERE key=?").run(key)
    const racing = new FlowStore(
      adapter(f.settings, (key, expected, value) => {
        expect(expected).toBeUndefined()
        f.second.put(f.root)
        reserve(f.second, f.root)
        return f.settings.compareAndSetSetting(key, expected, value)
      })
    )
    expect(() => racing.put(f.root)).toThrow("FLOW_RECOVERY_STALE")
    expect(f.store.runs("workspace", "thread")).toHaveLength(2)
  })

  it("keeps both rows absent on a real SQLite statement failure and commits both after retry", () => {
    const f = fixture()
    const db = new DatabaseSync(f.path)
    cleanup.push(() => db.close())
    db.exec(
      "CREATE TRIGGER block_recovery BEFORE UPDATE ON mods_meta BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    )
    const raw = f.settings.getSetting(key)
    expect(() => reserve(f.store, f.root)).toThrow("injected failure")
    expect(f.settings.getSetting(key)).toBe(raw)
    db.exec("DROP TRIGGER block_recovery")
    reserve(f.store, f.root)
    expect(f.second.runs("workspace", "thread")).toHaveLength(2)
  })

  it.each([1, 2])("rejects scope revocation at authority check %i before commit", (revokeAt) => {
    const f = fixture()
    const raw = f.settings.getSetting(key)
    let checks = 0
    expect(() =>
      reserve(f.store, f.root, "child", () => {
        if (++checks === revokeAt) throw Error("scope revoked")
      })
    ).toThrow("scope revoked")
    expect(f.settings.getSetting(key)).toBe(raw)
  })

  it("rejects old source writes and preserves the entire chain during child updates", () => {
    const f = fixture()
    const child = reserve(f.store, f.root)
    expect(() => f.second.put({ ...f.root, status: "complete" })).toThrow(
      "FLOW_RECOVERY_SOURCE_CONSUMED"
    )
    const source = f.store.run("workspace", "thread", "root")!
    f.second.put(source)
    f.store.put({ ...child, status: "running" })
    expect(f.second.runs("workspace", "thread")).toHaveLength(2)
    expect(f.second.run("workspace", "thread", "root")).toEqual(source)
    const withoutLineage = { ...child, recovery: undefined }
    expect(() => f.store.put(withoutLineage)).toThrow("FLOW_RECOVERY_LINEAGE_INVALID")
  })

  it("persists a copied receipt invalidation but rejects changes to its result or fingerprints", () => {
    const f = fixture()
    const child = reserve(f.store, f.root)
    child.attempts[0].invalidated = true
    f.store.put(child)
    expect(f.second.run("workspace", "thread", child.id)?.attempts[0].invalidated).toBe(true)
    const forged = structuredClone(child)
    forged.attempts[0].result!.summary = "forged"
    expect(() => f.store.put(forged)).toThrow("FLOW_RECOVERY_REUSE_INVALID")
    const fingerprint = structuredClone(child)
    fingerprint.attempts[0].outputFingerprint = "forged"
    expect(() => f.store.put(fingerprint)).toThrow("FLOW_RECOVERY_REUSE_INVALID")
  })

  it("persists consumption across actual Node exit and a fresh process opening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-recovery-process-"))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    symlinkSync(
      join(process.cwd(), "node_modules"),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    )
    // Bundle the real source modules independently, so fresh processes share no test objects.
    const modulePath = join(directory, "store-process.mjs")
    const sourcePath = (relative: string) =>
      fileURLToPath(new URL(relative, import.meta.url)).replaceAll("\\", "/")
    await build({
      stdin: {
        contents: `export { ModControlStore } from ${JSON.stringify(sourcePath("../control-store.ts"))};
          export { FlowStore } from ${JSON.stringify(sourcePath("./store.ts"))}`,
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        loader: "ts"
      },
      outfile: modulePath,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      packages: "external"
    })
    const module = pathToFileURL(modulePath).href
    const path = join(directory, "process.sqlite")
    const source = rootRun()
    const code = `import { ModControlStore, FlowStore } from ${JSON.stringify(module)}
      const settings = new ModControlStore(process.argv[1])
      const store = new FlowStore(settings)
      const root = JSON.parse(process.argv[3])
      const request = JSON.parse(process.argv[4])
      if(process.argv[2] === 'consume') {
        store.put(root)
        store.reserveRecovery('workspace','thread',request,{childRunId:'child',now:2000,assertCurrent(){}})
        process.exit(0)
      }
      const rows = store.runs('workspace','thread')
      if(rows.length !== 2 || rows.find(r=>r.id==='root')?.recovery?.consumedBy !== 'child') process.exit(2)
      try {
        store.reserveRecovery('workspace','thread',request,{childRunId:'second',now:2000,assertCurrent(){}})
        process.exit(3)
      } catch(error) {
        if(error.message !== 'FLOW_RECOVERY_SOURCE_CONSUMED') throw error
      }
      settings.close()
      console.log('durable-consumption')`
    for (const phase of ["consume", "reopen"]) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          code,
          path,
          phase,
          JSON.stringify(source),
          JSON.stringify(request(source))
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true }
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      if (phase === "reopen") expect(result.stdout).toContain("durable-consumption")
    }
  })
})
