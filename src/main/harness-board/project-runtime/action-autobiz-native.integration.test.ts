/** Real local AutoBiz + QuickJS + Python + host validation. No model or UI approval claim. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "./host-service"
import type { ModObject } from "../../../shared/mods/types"
import { resolveClawActionInput } from "../../../shared/mods/claw-actions"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import { createProjectActionBinding } from "./action-input"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { withFunctionExecution } from "../../mods/v2/execution-context"
import { ModControlStore } from "../../mods/control-store"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"
import { HostProjectStore } from "./host-store"
import { HostProjectService } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { setProjectActionRuntime } from "../project-action-runtime"

const mock = vi.hoisted(() => ({ metadata: {} as Record<string, unknown>, skill: vi.fn() }))
vi.mock("../../db", () => ({
  getThreadCore: () => ({ created_at: 1, metadata: JSON.stringify(mock.metadata) })
}))
vi.mock("../host-skill-executor", () => ({ executeHostProjectSkill: mock.skill }))
import { executeHostProjectStage } from "../project-action-executor"

const execute = promisify(execFile)
const source = process.env.CMB_AUTOBIZ_SOURCE ?? "C:/ai/autobiz_kanban"
const fixtureScript = resolve("tests/support/autobiz-delivery-original-fixture.py")

it.skipIf(!existsSync(source) || !existsSync(fixtureScript))(
  "reads an honestly unfinished original AutoBiz feature through Mods and requires host review",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "autobiz-native-project-actions-"))
    const workspace = join(root, "project")
    const threadId = "real-autobiz-host-thread"
    const providerName = "AutobizDevOps_Plugin_Kanban_latest"
    const control = new ModControlStore(join(root, "mods.sqlite"))
    const projects = new HostProjectStore(join(root, "projects.sqlite"))
    const guests: FunctionGuestRuntime[] = []
    const processes: string[][] = [],
      writes: string[] = []
    let disposed = 0
    // These callbacks are explicit test approvals. SDK admission, source checks,
    // process execution and the file bytes remain the production implementations.
    const functions = new FunctionModsManager(
      control,
      {
        plugins: () => [
          { id: "real-autobiz-installation", name: providerName, path: source, enabled: true }
        ],
        enabled: () => true,
        clawApplicable: () => true,
        changed: () => {},
        publish: async (_workspace, value) => value,
        cwd: () => workspace,
        authorizeProcess: async (actualWorkspace, actualThread, _grant, request, signal) => {
          expect([actualWorkspace, actualThread]).toEqual([workspace, threadId])
          signal.throwIfAborted()
          expect(request.argv[0]).toBe("python")
          expect(resolve(request.argv[4])).toBe(resolve(source, "hooks/mods_delivery_report.py"))
          expect(request.cwd).toBe(workspace)
          processes.push([...request.argv])
        },
        runEffect: async (_workspace, _thread, _grant, method, _input, signal, run) => {
          expect(method).toBe("process.run")
          signal.throwIfAborted()
          return run()
        },
        callTool: async (actualWorkspace, actualThread, _grant, input, signal) => {
          expect([actualWorkspace, actualThread]).toEqual([workspace, threadId])
          signal.throwIfAborted()
          expect(input.tool).toBe("write_file")
          const path = resolve(workspace, String(input.file_path))
          const scoped = relative(workspace, path)
          expect(scoped.startsWith("..")).toBe(false)
          expect(typeof input.content).toBe("string")
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, String(input.content), { flag: "wx" })
          writes.push(scoped.replace(/\\/g, "/"))
          return { result: { path } }
        }
      },
      () => ({
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          guests.forEach((guest) => guest.dispose())
        },
        async stopAndDrain() {
          guests.forEach((guest) => guest.dispose())
        }
      })
    )
    try {
      const initialized = await execute(
        "python",
        [
          "-B",
          "-X",
          "utf8",
          fixtureScript,
          "--source",
          source,
          "--workspace",
          root,
          "--project",
          basename(workspace),
          "--feature",
          "demo"
        ],
        { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      const original = JSON.parse(initialized.stdout)
      expect(original.feature).toBe("demo")
      expect(original.checkpoint).toBe("specs_done")
      expect(original.selectedNodes).toEqual(["dev.specs", "dev.code", "ops.archive"])
      expect(original.gates.missing.ok).toBe(false)
      expect(original.gates.beforeSeedTransition.exitCode).not.toBe(0)
      expect(original.gates.seeded.ok).toBe(true)
      expect(original.gates.lawfulTransition.exitCode).toBe(0)
      const statePath = join(workspace, ".autobizdevops/state.json")
      const stateBefore = readFileSync(statePath, "utf8")

      const [status] = await functions.status(workspace)
      expect(status.digest).toMatch(/^[0-9a-f]{64}$/)
      await functions.approve(workspace, status.pluginId, status.digest!)
      const catalog = await functions.actionCatalog(workspace, threadId)
      const collect = catalog.find((item) => item.actionId === "collect-evidence")!
      const generate = catalog.find((item) => item.actionId === "generate-report")!
      expect(collect.platform?.action).toBe("collect")
      expect(generate.platform?.action).toBe("generate")
      const bindings = [
        createProjectActionBinding("collect-evidence", collect, { feature: "demo" }),
        createProjectActionBinding(
          "generate-report",
          generate,
          { feature: "demo", receiptPath: "delivery-report.json" },
          {},
          { kind: "action", actionId: "collect-evidence", pointer: "" }
        )
      ]
      const consumer = join(root, "consumer")
      cpSync(resolve("examples/autobiz-delivery-project"), consumer, { recursive: true })
      const manifestPath = join(consumer, "devclaw.project-runtime.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.actions = bindings.map(({ id, ref }) => ({ id, ref }))
      manifest.stages[0].actionIds = bindings.map(({ id }) => id)
      writeFileSync(manifestPath, JSON.stringify(manifest))
      writeFileSync(
        join(consumer, PROJECT_ACTION_LOCK_PATH),
        JSON.stringify({
          apiVersion: "devclaw.project-actions-lock/v1",
          bindings
        })
      )
      const settings = new Map<string, string>()
      const flows = new FlowManager(
        new FlowStore({
          getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
          setSetting: (key, value) => {
            settings.set(key, value)
          }
        }),
        {
          assertScope() {
            /* Scope is checked by the real project-action adapter. */
          },
          changed() {
            /* No renderer is attached to this native fixture. */
          },
          prepare: async () => ({
            assertLive() {
              /* Installation and grants are checked by prepareAction/runAction. */
            },
            fingerprint: async () => "fixed-native-test-scope",
            execute: async (step, context) => {
              if (step.kind !== "plugin-action") throw Error("unexpected step")
              const prior =
                step.inputFrom &&
                context.run.attempts.findLast(
                  (attempt) => attempt.stepId === step.inputFrom!.stepId && attempt.result?.output
                )
              const input = step.inputFrom
                ? resolveClawActionInput(step.input, prior!.result!.output!, step.inputFrom.path)
                : step.input
              const prepared = await functions.prepareAction(
                workspace,
                threadId,
                step,
                context.signal
              )
              const result = await withFunctionExecution(
                { workspace, threadId, userInitiated: true, leased: true, immediate: false },
                () =>
                  functions.runAction(
                    workspace,
                    threadId,
                    prepared,
                    {
                      version: 1,
                      input,
                      config: step.config ?? {},
                      task: "核对真实 AutoBiz 交付证据",
                      runId: context.run.id,
                      stepId: step.id,
                      executionId: context.executionId
                    },
                    context.signal
                  )
              )
              return {
                passed: result.passed ?? true,
                summary: result.text,
                source: "plugin-action",
                output: result.output
              }
            },
            finalize: async (_context, confirm) => {
              await confirm()
              return { passed: true, source: "native-check", summary: "Actions physically settled" }
            },
            dispose: async () => {
              disposed++
            }
          })
        }
      )
      setProjectActionRuntime({
        flows,
        catalog: () => functions.actionCatalog(workspace, threadId),
        prepareSelection: async () => {}
      })
      mock.skill.mockImplementation(async (context: HostSkillExecutionContext) => {
        context.bindThread(threadId)
        await context.prepareThread?.(threadId)
        // Controlled model fixture writes only the input note, never a report or receipt.
        if (context.operation.stageId === "delivery")
          writeFileSync(
            join(workspace, "input-check.md"),
            "Controlled input note: original feature is unfinished."
          )
        context.recordTerminal({ outcome: "success", code: "controlled_input_note" })
        return "succeeded"
      })
      const service = new HostProjectService(
        projects,
        new HostPackageSnapshots(join(root, "snapshots")),
        {
          resolveInstalledPlugin: async () => ({
            installedPluginId: "host-consumer",
            root: consumer,
            packageId: "autobiz-delivery-project",
            packageVersion: "1.0.0",
            enabled: true
          }),
          authorize: async () => {},
          executeSkill: async (context) => {
            mock.metadata = {
              workspacePath: workspace,
              cmb_thread_incarnation: root,
              hostProjectRuntime: {
                projectId: context.project.projectId,
                operationId: context.operation.operationId,
                stageId: context.operation.stageId,
                pluginDigest: context.project.pluginDigest
              }
            }
            return executeHostProjectStage(context, {} as BrowserWindow, () => {})
          }
        }
      )
      await service.localCreate({
        projectId: "delivery-review",
        name: "真实 AutoBiz 交付报告",
        workspace,
        installedPluginId: "host-consumer",
        goal: "读取原项目证据；不宣称开发已完成"
      })
      const operation = service.prepare({
        projectId: "delivery-review",
        expectedVersion: 1,
        idempotencyKey: "real-auto-delivery"
      })
      const settled = await service.start(operation.operationId)
      expect(
        settled.status,
        JSON.stringify({ settled, runs: flows.runs(workspace, threadId) })
      ).toBe("succeeded")
      expect(settled.receipts.map((item) => item.result)).toEqual(["passed", "passed"])
      expect(processes).toHaveLength(2)
      expect(writes).toHaveLength(3)
      expect(disposed).toBe(1)
      const receipt = JSON.parse(
        readFileSync(join(workspace, "delivery-report.json"), "utf8")
      ) as ModObject
      expect(receipt.qualityStatus).toBe("needs_review")
      expect(receipt.checkpoint).not.toBe("archived")
      expect(receipt.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(writes).toContain(receipt.reportPath)
      expect(writes).toContain(receipt.jsonPath)
      expect(readFileSync(join(workspace, String(receipt.reportPath)), "utf8")).toContain(
        "needs_review"
      )
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore)
      const reviewProject = service.transition(operation.operationId)
      expect(reviewProject.status).toBe("active")
      const review = service.prepare({
        projectId: "delivery-review",
        expectedVersion: 2,
        idempotencyKey: "explicit-human-review"
      })
      await expect(service.start(review.operationId)).rejects.toThrow()
      expect(mock.skill).toHaveBeenCalledOnce()
      service.approve(review.operationId, {
        expectedVersion: 2,
        inputFingerprint: review.inputFingerprint,
        decision: "approved",
        actorId: "test-reviewer"
      })
      expect((await service.start(review.operationId)).status).toBe("succeeded")
      expect(service.transition(review.operationId).status).toBe("completed")
      // Completing this review never changes the original AutoBiz development status.
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore)
      const evidenceOutput = process.env.CMB_AUTOBIZ_NATIVE_EVIDENCE
      if (evidenceOutput) {
        mkdirSync(evidenceOutput)
        for (const path of writes) {
          const destination = join(evidenceOutput, path)
          mkdirSync(dirname(destination), { recursive: true })
          cpSync(join(workspace, path), destination, { errorOnExist: true, force: false })
        }
        writeFileSync(
          join(evidenceOutput, "validation.json"),
          JSON.stringify(
            {
              source,
              compiledDigest: status.digest,
              original,
              processes,
              writes: writes.map((path) => ({
                path,
                digest: createHash("sha256")
                  .update(readFileSync(join(workspace, path)))
                  .digest("hex")
              })),
              originalStateDigest: createHash("sha256").update(stateBefore).digest("hex"),
              originalStateUnchanged: readFileSync(statePath, "utf8") === stateBefore,
              hostOperation: settled,
              reportReceipt: receipt,
              disposed,
              limitations: [
                "Controlled specification and input-note fixtures; no model invocation",
                "Native approval callbacks and reviewer are test providers, not UI human approval",
                "Actual QuickJS, Python subprocess and files; original code/archive remain unfinished",
                "This is not a terminal AutoBiz handoff or business quality acceptance"
              ]
            },
            null,
            2
          ) + "\n",
          { flag: "wx" }
        )
      }
    } finally {
      functions.close()
      guests.forEach((guest) => guest.dispose())
      projects.close()
      control.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  90_000
)
