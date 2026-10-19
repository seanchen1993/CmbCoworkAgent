import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { expect, it, vi } from "vitest"
const processSpawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: processSpawn
}))
import { LocalSandbox } from "./local-sandbox"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import type { PluginMetadata } from "../types"

it.each([undefined, "legacy", "host"] as const)(
  "shell Python environment is scoped to %s runtime",
  (mode) => {
    const root = process.cwd()
    const token =
      mode === undefined
        ? undefined
        : issueRuntimePluginSourceToken({
            mode,
            threadId: "thread",
            incarnationKey: "incarnation",
            projectId: "composition-legacy:run:unit",
            operationId: "run",
            workspace: root,
            packageDigest: "c".repeat(64),
            stageId: "review",
            plugin: { id: "plugin", path: root } as PluginMetadata
          })
    const inherited = { PYTHONDONTWRITEBYTECODE: "", PATH: process.env.PATH ?? "" }
    const sandbox = withRuntimePluginSource(
      token,
      () => new LocalSandbox({ rootDir: root, env: inherited })
    )
    const env = (sandbox as unknown as { env: Record<string, string> }).env
    expect(env.PYTHONDONTWRITEBYTECODE).toBe(mode === "legacy" ? "1" : "")
    expect(inherited.PYTHONDONTWRITEBYTECODE).toBe("")
  }
)

it("rechecks the captured source after approval or queue waits and before spawning", async () => {
  let changed = false
  const root = process.cwd()
  const token = issueRuntimePluginSourceToken(
    {
      mode: "legacy",
      threadId: "thread",
      incarnationKey: "incarnation",
      projectId: "composition-legacy:run:unit",
      operationId: "run",
      workspace: root,
      packageDigest: "c".repeat(64),
      stageId: "stage",
      plugin: { id: "plugin", path: root } as PluginMetadata
    },
    () => {
      if (changed) throw Error("SOURCE_CHANGED_AFTER_APPROVAL")
    }
  )
  const sandbox = withRuntimePluginSource(token, () => new LocalSandbox({ rootDir: root, env: {} }))
  await Promise.resolve()
  changed = true
  // The approved callback may run in a fresh async scope; it must retain the admitted source fence.
  await expect(
    withRuntimePluginSource(undefined, () => sandbox.executeRaw("echo never-run", "none"))
  ).rejects.toThrow("SOURCE_CHANGED_AFTER_APPROVAL")
  expect(processSpawn).not.toHaveBeenCalled()
})

it.each(["write-approval", "edit-approval", "write-lock", "edit-lock", "upload-await"])(
  "rejects changed retained source after %s without committing file bytes",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "retained-write-fence-"))
    try {
      const installed = join(root, "installed"),
        workspace = join(root, "workspace")
      mkdirSync(installed)
      mkdirSync(workspace)
      writeFileSync(join(installed, "plugin.json"), '{"name":"fixture"}')
      const snapshots = new RetainedPackageSnapshots(join(root, "snapshots"))
      const snapshot = snapshots.capture(installed)
      const guard = await snapshots.captureGuardAsync(snapshot.digest)
      const token = issueRuntimePluginSourceToken(
        {
          mode: "legacy",
          threadId: "thread",
          incarnationKey: "incarnation",
          projectId: "composition-legacy:run:unit",
          operationId: "run",
          workspace,
          packageDigest: snapshot.digest,
          stageId: "stage",
          plugin: { id: "plugin", path: snapshot.root } as PluginMetadata
        },
        guard
      )
      const mutated = vi.fn()
      const sandbox = withRuntimePluginSource(
        token,
        () => new LocalSandbox({ rootDir: workspace, env: {}, onFileMutation: mutated })
      )
      const target = join(workspace, "report.md")
      const editing = scenario.startsWith("edit")
      if (editing) writeFileSync(target, "original")
      let entered!: () => void, release!: () => void
      const approvalEntered = new Promise<void>((done) => {
        entered = done
      })
      const approvalRelease = new Promise<void>((done) => {
        release = done
      })
      sandbox.setOrchestrator({
        approveFileOp: async () => {
          entered()
          if (scenario.endsWith("approval")) await approvalRelease
          return true
        }
      } as never)
      let releaseLock!: () => void
      const lockRelease = new Promise<void>((done) => {
        releaseLock = done
      })
      const holder = scenario.endsWith("lock")
        ? (
            sandbox as unknown as {
              withFileLock(path: string, work: () => Promise<void>): Promise<void>
            }
          ).withFileLock(target, () => lockRelease)
        : Promise.resolve()
      const pending = withRuntimePluginSource(undefined, () =>
        scenario === "upload-await"
          ? sandbox
              .uploadFiles([[target, Buffer.from("replacement")]])
              .then((results) => results[0])
          : editing
            ? sandbox.edit(target, "original", "replacement")
            : sandbox.write(target, "replacement")
      )
      const resultPromise = pending.catch((error) => ({ error: String(error) }))
      if (scenario !== "upload-await") await approvalEntered
      writeFileSync(join(snapshot.root, "plugin.json"), '{"name":"changed"}')
      release()
      releaseLock()
      const result = await resultPromise
      await holder
      expect(result.error).toContain("PACKAGE_CHANGED")
      expect(editing ? readFileSync(target, "utf8") : existsSync(target)).toBe(
        editing ? "original" : false
      )
      expect(mutated).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
