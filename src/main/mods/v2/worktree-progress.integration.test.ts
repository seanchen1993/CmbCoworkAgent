import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import type { FunctionUiElement, FunctionUiNode } from "../../../shared/mods/v2/ui"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const execute = promisify(execFile)
const source = process.env.AUTOBIZ_PROGRESS_SOURCE
const plugins = [
  process.env.AUTOBIZ_PROGRESS_ASSEMBLED,
  process.env.AUTOBIZ_PROGRESS_ASSEMBLED2
].filter(Boolean)

it.skipIf(!source || !plugins.length).each(plugins.length ? plugins : [undefined])(
  "runs actual assembled observer %s against original scheduler/worktrees and retains process approval",
  async (plugin) => {
    const root = await mkdtemp(join(tmpdir(), "worktree-progress-"))
    let session: FunctionSession | undefined
    try {
      const prepared = await execute(
        "python",
        [
          "-B",
          "-X",
          "utf8",
          resolve(source!, "demo/prepare.py"),
          "--plugin-root",
          resolve(plugin!),
          "--target",
          join(root, "demo")
        ],
        { maxBuffer: 1024 * 1024 }
      )
      const demo = JSON.parse(prepared.stdout)
      const compiled = await compileFunctionPlugin(resolve(plugin!))
      const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
      const calls: unknown[] = []
      let denied = false
      session = new FunctionSession(
        [
          {
            name: compiled.name,
            root: compiled.root,
            tier: "user",
            guest,
            capabilities: [...SESSION_CAPABILITIES]
          }
        ],
        {
          workspace: demo.workspace,
          threadId: "real-worktree-progress",
          assertLive() {
            // This isolated guest fixture has no concurrent source/grant mutation.
          },
          publish: async (value) => value,
          async authorizeProcess(owner, request, signal, method) {
            calls.push({ name: owner.name, argv: request.argv, cwd: request.cwd, method })
            expect(owner.name).toBe(compiled.name)
            expect(method).toBe("process.run")
            expect(request.argv.slice(0, 4)).toEqual(["python", "-B", "-X", "utf8"])
            expect(resolve(request.argv[4])).toBe(
              resolve(plugin!, "mods/business/autobiz.worktree-progress/inspect.py")
            )
            expect(request.cwd).toBe(demo.workspace)
            signal.throwIfAborted()
            if (denied) throw Error("EXPLICIT_APPROVAL_DENIED")
          }
        }
      )
      const catalog = session.platformSurfaces.list()
      expect(catalog.entries).toHaveLength(1)
      expect(catalog.entries[0].ref.provider).toBe(compiled.name)
      const frame = await session.platformSurfaces.open(
        { key: catalog.entries[0].key, revision: catalog.revision },
        new AbortController().signal
      )
      expect(frame.pane).not.toBeNull()
      expect(calls).toHaveLength(0)
      const controls = (tree: FunctionUiElement) => {
        const nodes: FunctionUiNode[] = []
        const visit = (value: FunctionUiElement | string) => {
          if (typeof value === "string" || value.type === "engine" || value.type === "Markdown")
            return
          if (value.type !== "fragment") nodes.push(value)
          value.children?.forEach(visit)
        }
        visit(tree)
        return nodes
      }
      const snapshot = async () => (await session!.panes.snapshot())[0]
      const refresh = async () => {
        const pane = await snapshot()
        const button = controls(pane.tree).find((node) => node.props.key === "refresh-worktrees")!
        expect(button.press).toBeDefined()
        await session!.panes.act({
          pane: pane.key,
          generation: pane.generation,
          intentId: randomUUID(),
          plugin: button.press!.plugin,
          handle: button.press!.handle,
          kind: "press"
        })
      }
      await refresh()
      expect(calls).toHaveLength(1)
      const pane = await snapshot()
      const table = controls(pane.tree).find((node) => node.type === "Table")!
      expect(table.props.rows).toHaveLength(2)
      const text = JSON.stringify(pane.tree)
      expect(text).toContain(demo.runId)
      expect(text).toContain("B001")
      expect(text).toContain("B002")
      expect(text).toContain("prepare:passed (bytes_match)")
      expect(text).toContain("implement:running")
      expect(text).toContain("review:pending")
      expect(text).toContain("test:pending")
      expect(text).toContain("autodev/alpha/")
      expect(text).toContain("todo:1")
      expect(text).not.toContain("100%")
      const originalBytes = await readFile(join(demo.worktrees[0].worktreePath, "existing.txt"))
      const advanced = await execute(
        "python",
        [
          "-B",
          "-X",
          "utf8",
          resolve(source!, "demo/advance.py"),
          "--demo",
          join(root, "demo/demo.json")
        ],
        { maxBuffer: 1024 * 1024 }
      )
      expect(JSON.parse(advanced.stdout).taskStatus).toBe("started")
      await refresh()
      expect(calls).toHaveLength(2)
      const updated = await snapshot()
      const updatedTable = controls(updated.tree).find((node) => node.type === "Table")!
      expect(JSON.stringify(updatedTable.props.rows)).toContain("in_progress:1")
      expect(JSON.stringify(updatedTable.props.rows)).toContain("todo:1")
      expect(await readFile(join(demo.worktrees[0].worktreePath, "existing.txt"))).not.toEqual(
        originalBytes
      )
      const manifest = JSON.parse(
        await readFile(
          join(
            demo.workspace,
            ".autobizdevops/features/alpha/.parallel-runs",
            demo.runId,
            "manifest.json"
          ),
          "utf8"
        )
      )
      expect(manifest.batches.B001.stageStates.implement.status).toBe("running")
      expect(manifest.batches.B001.stageStates.review.status).toBe("pending")
      denied = true
      await refresh()
      const failed = await snapshot()
      expect(JSON.stringify(failed.tree)).toContain("EXPLICIT_APPROVAL_DENIED")
      expect(controls(failed.tree).find((node) => node.type === "Table")!.props.rows).toHaveLength(
        0
      )
      expect(calls).toHaveLength(3)
      const evidence = resolve("output/demo-readiness-20261016")
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, `worktree-progress-guest-${compiled.name}.json`),
        JSON.stringify(
          {
            plugin: compiled.root,
            name: compiled.name,
            compiledDigest: compiled.digest,
            checks: {
              discoveryDoesNotReadOrExecute: true,
              actualOriginalRunAndTwoGitWorktrees: true,
              nativeProcessApprovalRetained: true,
              before: table.props.rows,
              after: updatedTable.props.rows,
              originalTaskRunnerAdvancedToInProgress: true,
              actualTrackedBytesChanged: true,
              deniedRefreshClearsOldFacts: true
            },
            limits:
              "Controlled original kernel/real Git/real QuickJS/real Python. No full model Code, Review, UTest, merge or business acceptance."
          },
          null,
          2
        )
      )
    } finally {
      await session?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)
