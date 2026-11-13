import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { HostProjectOperation } from "../../../shared/project-runtime/host-types"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectService, type HostProjectServiceDependencies } from "./host-service"
import { HostProjectStore } from "./host-store"
import { acquireSnapshotPathLeases, collectSnapshotGarbage } from "./snapshot-retention"

const cleanup: Array<() => void> = []
const releaseHeld = new Set<() => void>()
const running: Array<Promise<unknown>> = []
type Outcome = { value?: HostProjectOperation; error?: unknown }

function gate() {
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  const release = (): void => { releaseHeld.delete(release); finish() }
  releaseHeld.add(release)
  return { promise, release }
}

async function waitForPhase(entered: ReturnType<typeof gate>, outcome: Promise<Outcome>): Promise<void> {
  await Promise.race([entered.promise, outcome.then(result => {
    throw result.error ?? Error(`PHASE_FINISHED_BEFORE_ENTRY:${result.value?.status}`)
  })])
}

afterEach(async () => {
  for (const release of [...releaseHeld]) release()
  await Promise.allSettled(running.splice(0))
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) close()
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-provider-retention-"))
  cleanup.push(() => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || lstatSync(root).isSymbolicLink())
      throw Error("OWNED_TEST_ROOT_REQUIRED")
    rmSync(root, { recursive: true, force: true })
  })
  const plugin = join(root, "installed")
  mkdirSync(plugin)
  const manifest = hostProjectFixture(join(root, "unused")).manifest
  for (const stage of manifest.stages) {
    stage.approval = "none"
    mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
    writeFileSync(join(plugin, stage.skill!), "Original instructions")
  }
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  const store = new HostProjectStore(join(root, "host.sqlite"))
  cleanup.push(() => store.close())
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  let authority = 0
  const dependencies: HostProjectServiceDependencies = {
    resolveInstalledPlugin: async () => ({ installedPluginId: "docs", root: plugin,
      packageId: "docs", packageVersion: "1.0.0", enabled: true }),
    authorize: async () => {},
    captureInputAuthorityIdentity: () => () => String(authority),
    executeSkill: async context => {
      writeFileSync(join(context.project.workspace, "document.md"), "Verified document")
      return "succeeded"
    }
  }
  const service = new HostProjectService(store, snapshots, dependencies)
  const create = async (projectId: string) => {
    const workspace = join(root, projectId)
    mkdirSync(workspace)
    return service.localCreate({ projectId, name: projectId, workspace,
      installedPluginId: "docs", goal: "Write a document" })
  }
  const project = await create("first")
  const prepare = (projectId = "first") => service.prepare({ projectId,
    expectedVersion: service.get(projectId)!.version,
    idempotencyKey: `run-${service.operations(projectId).length}` })
  const start = (operationId: string, options?: { assertInputsCurrent: () => void }) => {
    let work: Promise<HostProjectOperation>
    try { work = service.start(operationId, options) }
    catch (error) { work = Promise.reject(error) }
    const observed: Promise<Outcome> = work.then(value => ({ value }), error => ({ error }))
    running.push(observed)
    return observed
  }
  const readers = () => readdirSync(join(snapshots.root, ".snapshot-retention", "readers"))
    .filter(name => name.endsWith(".json")).sort()
  const lock = join(snapshots.root, ".snapshot-retention", "maintenance.lock")
  const collect = () => collectSnapshotGarbage(snapshots.root,
    () => ({ complete: true, digests: new Set<string>(), blockers: [] }))
  return { root, plugin, project, store, snapshots, dependencies, service, create,
    prepare, start, readers, lock, collect, revoke: () => { authority++ } }
}

it.each(["authorize", "execute"] as const)(
  "holds one real reader throughout the asynchronous %s phase", async phase => {
    const f = await fixture(), entered = gate(), held = gate()
    const inspect = async () => {
      const original = f.readers()
      expect(original).toHaveLength(1)
      f.snapshots.read(f.project.pluginDigest)
      await Promise.resolve()
      f.snapshots.read(f.project.pluginDigest)
      expect(f.readers()).toEqual(original)
      entered.release()
      await held.promise
    }
    if (phase === "authorize") f.dependencies.authorize = inspect
    else f.dependencies.executeSkill = async context => {
      await inspect()
      writeFileSync(join(context.project.workspace, "document.md"), "Verified document")
      return "succeeded"
    }
    const operation = f.prepare(), outcome = f.start(operation.operationId)
    await waitForPhase(entered, outcome)
    const collection = f.collect()
    expect(collection.removed).not.toContain(f.project.pluginDigest)
    expect(readFileSync(join(f.snapshots.root, f.project.pluginDigest,
      "package/skills/draft/SKILL.md"), "utf8")).toBe("Original instructions")
    expect(f.readers()).toHaveLength(1)
    held.release()
    expect((await outcome).value?.status).toBe("succeeded")
    expect(f.readers()).toEqual([])
  }
)

it.each(["authorize", "execute", "validate"] as const)(
  "preserves the original %s first-acquire failure classification", async phase => {
    const f = await fixture(), operation = f.prepare()
    let startChecks = 0, skillEnded = false, validationScheduled = false
    let finalReadCompleted = false, lockSawFinalRead = false
    const originalRead = f.snapshots.read.bind(f.snapshots)
    if (phase === "validate") vi.spyOn(f.snapshots, "read").mockImplementation(digest => {
      const snapshot = originalRead(digest)
      if (skillEnded && validationScheduled && !existsSync(f.lock)) finalReadCompleted = true
      return snapshot
    })
    const execute = f.dependencies.executeSkill
    f.dependencies.executeSkill = async context => {
      const result = await execute(context)
      skillEnded = true
      return result
    }
    f.dependencies.assertCommand = (_project, kind) => {
      if (phase === "authorize" && kind === "start" && ++startChecks === 2)
        writeFileSync(f.lock, "owned test maintenance")
      if (phase === "validate" && kind === "validate" && skillEnded) {
        validationScheduled = true
        queueMicrotask(() => {
          lockSawFinalRead = finalReadCompleted
          writeFileSync(f.lock, "owned test maintenance")
        })
      }
    }
    if (phase === "execute") {
      const original = f.store.start.bind(f.store)
      vi.spyOn(f.store, "start").mockImplementation((...args) => {
        const ticket = original(...args)
        writeFileSync(f.lock, "owned test maintenance")
        return ticket
      })
    }
    try {
      const outcome = await f.start(operation.operationId, { assertInputsCurrent: () => {} })
      if (phase === "authorize") {
        expect(outcome.error).toBeInstanceOf(Error)
        expect((outcome.error as Error).message).toBe("SNAPSHOT_MAINTENANCE_BUSY")
        expect(f.store.getOperation(operation.operationId)?.status).toBe("failed")
        expect(skillEnded).toBe(false)
      } else {
        expect(outcome.error).toBeUndefined()
        expect(outcome.value?.status).toBe("unknown")
        expect(outcome.value?.receipts).toEqual([])
        expect(skillEnded).toBe(phase === "validate")
        if (phase === "validate") {
          expect(lockSawFinalRead).toBe(true)
          expect(f.snapshots.read).toHaveBeenCalledTimes(10)
        }
      }
      expect(f.readers()).toEqual([])
    } finally { if (existsSync(f.lock)) rmSync(f.lock) }
    // A failed acquisition cannot leave the options guard or coordinator slot poisoned.
    if (phase === "authorize")
      expect(((await f.start(operation.operationId, { assertInputsCurrent: () => {} })).error as Error)
        .message).toBe("PROJECT_HOST_OPERATION_NOT_PREPARED")
  }
)

it.each([false, true])("retains the original duplicate-start boundary with options=%s", async options => {
  const f = await fixture(), entered = gate(), held = gate()
  const execute = f.dependencies.executeSkill
  let invocations = 0
  f.dependencies.executeSkill = async context => {
    invocations++
    entered.release()
    await held.promise
    return execute(context)
  }
  const operation = f.prepare(), config = options ? { assertInputsCurrent: () => {} } : undefined
  const first = f.start(operation.operationId, config)
  await waitForPhase(entered, first)
  const originalReaders = f.readers()
  expect(originalReaders).toHaveLength(1)
  expect(((await f.start(operation.operationId, config)).error as Error).message).toBe("PROJECT_HOST_OPERATION_BUSY")
  expect(invocations).toBe(1)
  expect(f.readers()).toEqual(originalReaders)
  held.release()
  expect((await first).value?.status).toBe("succeeded")
  expect(f.readers()).toEqual([])
})

it("verifies each distinct snapshot boundary and retains one reader throughout validation", async () => {
  const f = await fixture(), operation = f.prepare()
  const originalRead = f.snapshots.read.bind(f.snapshots)
  const tail: Array<{ before: string[]; after: string[] }> = []
  let skillEnded = false, afterSkillValidation = false
  const execute = f.dependencies.executeSkill
  f.dependencies.executeSkill = async context => {
    const result = await execute(context)
    skillEnded = true
    return result
  }
  f.dependencies.assertCommand = (_project, kind) => {
    if (kind === "validate" && skillEnded) afterSkillValidation = true
  }
  const read = vi.spyOn(f.snapshots, "read").mockImplementation(digest => {
    const before = f.readers()
    const snapshot = originalRead(digest)
    if (afterSkillValidation) tail.push({ before, after: f.readers() })
    return snapshot
  })
  expect((await f.start(operation.operationId)).value?.status).toBe("succeeded")
  expect(read).toHaveBeenCalledTimes(12)
  // Execute settlement precedes the fingerprint and final input checks for this no-action stage.
  expect(tail).toHaveLength(3)
  const validation = tail.slice(1)
  expect(validation[0].before).toHaveLength(1)
  for (const entry of validation) {
    expect(entry.before).toEqual(validation[0].before)
    expect(entry.after).toEqual(validation[0].before)
  }
  expect(f.readers()).toEqual([])

  read.mockClear()
  expect(f.service.transition(operation.operationId).stageIndex).toBe(f.project.stageIndex + 1)
  expect(read).toHaveBeenCalledTimes(2)
  expect(f.readers()).toEqual([])
})

it("does not release a cancelled phase before the held Skill physically returns", async () => {
  const f = await fixture(), entered = gate(), held = gate()
  f.dependencies.executeSkill = async context => {
    entered.release()
    await held.promise
    return context.signal.aborted ? "cancelled" : "succeeded"
  }
  const operation = f.prepare(), outcome = f.start(operation.operationId)
  let settled = false
  void outcome.then(() => { settled = true })
  await waitForPhase(entered, outcome)
  const original = f.readers()
  expect(original).toHaveLength(1)
  f.service.cancel(operation.operationId)
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.readers()).toEqual(original)
  expect(f.collect().removed).not.toContain(f.project.pluginDigest)
  held.release()
  expect((await outcome).value?.status).toBe("cancelled")
  expect(f.readers()).toEqual([])
})

it("keeps the shared physical reader until both same-digest operations really settle", async () => {
  const f = await fixture()
  const second = await f.create("second")
  expect(second.pluginDigest).toBe(f.project.pluginDigest)
  const enteredFirst = gate(), enteredSecond = gate(), heldFirst = gate(), heldSecond = gate()
  f.dependencies.executeSkill = async context => {
    const first = context.project.projectId === "first"
    const entered = first ? enteredFirst : enteredSecond
    entered.release()
    await (first ? heldFirst : heldSecond).promise
    if (context.signal.aborted) return "cancelled"
    writeFileSync(join(context.project.workspace, "document.md"), "Verified document")
    return "succeeded"
  }
  const one = f.prepare(), oneRun = f.start(one.operationId)
  await waitForPhase(enteredFirst, oneRun)
  const originalReaders = f.readers()
  expect(originalReaders).toHaveLength(1)
  const two = f.prepare("second"), twoRun = f.start(two.operationId)
  await waitForPhase(enteredSecond, twoRun)
  expect(f.readers()).toEqual(originalReaders)
  f.service.cancel(one.operationId)
  expect(f.readers()).toEqual(originalReaders)
  expect(f.collect().removed).not.toContain(f.project.pluginDigest)
  heldFirst.release()
  expect((await oneRun).value?.status).toBe("cancelled")
  expect(f.readers()).toEqual(originalReaders)
  heldSecond.release()
  expect((await twoRun).value?.status).toBe("succeeded")
  expect(f.readers()).toEqual([])
})

it.each(["different-root", "different-digest"] as const)(
  "does not merge physical readers for %s", async difference => {
    const first = await fixture()
    let second = first, secondId = "second"
    if (difference === "different-root") {
      second = await fixture()
      secondId = "first"
    } else {
      writeFileSync(join(first.plugin, "variant.txt"), "Different retained package")
      const project = await first.create(secondId)
      expect(project.pluginDigest).not.toBe(first.project.pluginDigest)
    }
    const enteredOne = gate(), enteredTwo = gate(), heldOne = gate(), heldTwo = gate()
    const execute = async (which: "one" | "two", context: Parameters<
      HostProjectServiceDependencies["executeSkill"]>[0]) => {
      const entered = which === "one" ? enteredOne : enteredTwo
      entered.release()
      await (which === "one" ? heldOne : heldTwo).promise
      writeFileSync(join(context.project.workspace, "document.md"), "Verified document")
      return "succeeded" as const
    }
    if (first === second) first.dependencies.executeSkill = context =>
      execute(context.project.projectId === "first" ? "one" : "two", context)
    else {
      first.dependencies.executeSkill = context => execute("one", context)
      second.dependencies.executeSkill = context => execute("two", context)
    }
    const runOne = first.start(first.prepare().operationId)
    await waitForPhase(enteredOne, runOne)
    const runTwo = second.start(second.prepare(secondId).operationId)
    await waitForPhase(enteredTwo, runTwo)
    expect(first.readers()).toHaveLength(first === second ? 2 : 1)
    expect(second.readers()).toHaveLength(first === second ? 2 : 1)
    heldOne.release()
    expect((await runOne).value?.status).toBe("succeeded")
    expect(second.readers()).toHaveLength(1)
    heldTwo.release()
    expect((await runTwo).value?.status).toBe("succeeded")
    expect(first.readers()).toEqual([])
    expect(second.readers()).toEqual([])
  }
)

it.each(["bytes", "authority", "root-junction"] as const)(
  "does not cache away %s revocation while a phase reader is held", async change => {
    const f = await fixture(), entered = gate(), held = gate()
    let rejected = false
    f.dependencies.executeSkill = async context => {
      entered.release()
      await held.promise
      expect(() => context.assertInputsCurrent!()).toThrow()
      rejected = true
      return "succeeded"
    }
    const operation = f.prepare(), outcome = f.start(operation.operationId)
    await waitForPhase(entered, outcome)
    let moved: string | undefined
    if (change === "bytes")
      writeFileSync(join(f.snapshots.root, f.project.pluginDigest,
        "package/skills/draft/SKILL.md"), "Substituted instructions")
    else if (change === "authority") f.revoke()
    else {
      moved = join(f.root, "original-snapshots")
      renameSync(f.snapshots.root, moved)
      symlinkSync(moved, f.snapshots.root, process.platform === "win32" ? "junction" : "dir")
    }
    try {
      held.release()
      expect((await outcome).value?.status).toBe("unknown")
      expect(rejected).toBe(true)
    } finally {
      if (moved) {
        unlinkSync(f.snapshots.root)
        renameSync(moved, f.snapshots.root)
      }
    }
  }
)

it("does not release an independent external-engine reader with the provider phase", async () => {
  const f = await fixture(), entered = gate(), held = gate()
  const execute = f.dependencies.executeSkill
  f.dependencies.executeSkill = async context => {
    entered.release()
    await held.promise
    return execute(context)
  }
  const operation = f.prepare(), outcome = f.start(operation.operationId)
  await waitForPhase(entered, outcome)
  const external = acquireSnapshotPathLeases([
    join(f.snapshots.root, f.project.pluginDigest, "package")
  ], "test-external-engine", true)
  try {
    expect(f.readers()).toHaveLength(2)
    held.release()
    expect((await outcome).value?.status).toBe("succeeded")
    expect(f.readers()).toHaveLength(1)
    expect(f.collect().removed).not.toContain(f.project.pluginDigest)
  } finally { external.release() }
  expect(f.readers()).toEqual([])
  expect(existsSync(join(f.snapshots.root, f.project.pluginDigest))).toBe(true)
})
