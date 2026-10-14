import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { types } from "node:util"
import type { AuthoringInstallService } from "../mods/devtools/authoring-install-service"
import type { AuthoringInstallAccess } from "./mods-authoring-install"

/** Reads never replay side effects; both recovery commands require an explicit fresh observation. */
export function registerAuthoringReconcileHandlers(
  ipc: IpcMain,
  service: Pick<
    AuthoringInstallService,
    "inspectUncertain" | "reconcile" | "inspectPreparation" | "recoverPreparation"
  >,
  access: AuthoringInstallAccess
) {
  let reconciling = false
  for (const channel of [
    "inspect-uncertain",
    "reconcile",
    "inspect-preparation",
    "recover-preparation"
  ] as const) {
    const preparation = channel.endsWith("preparation"),
      apply = channel === "reconcile" || channel === "recover-preparation"
    ipc.handle(
      "mods:authoring-install:" + channel,
      async (event: IpcMainInvokeEvent, input: unknown) => {
        let cleanup = () => {},
          acquired = false
        try {
          access.trusted(event)
          if (
            !input ||
            typeof input !== "object" ||
            types.isProxy(input) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(input))
          )
            throw Error("INVALID")
          const keys = [
            "threadId",
            "expectedWorkspace",
            ...(!preparation ? ["operationId"] : []),
            ...(apply ? [preparation ? "expectedFingerprint" : "expectedInspectionDigest"] : [])
          ]
          const descriptors = Object.getOwnPropertyDescriptors(input)
          if (
            Reflect.ownKeys(input).length !== keys.length ||
            keys.some((key) => !descriptors[key] || !("value" in descriptors[key]))
          )
            throw Error("INVALID")
          const row = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
          if (
            typeof row.threadId !== "string" ||
            !row.threadId ||
            row.threadId.length > 200 ||
            typeof row.expectedWorkspace !== "string" ||
            !row.expectedWorkspace ||
            row.expectedWorkspace.length > 4096 ||
            (!preparation &&
              (typeof row.operationId !== "string" || !/^[0-9a-f-]{36}$/.test(row.operationId)))
          )
            throw Error("INVALID")
          const expected = row[preparation ? "expectedFingerprint" : "expectedInspectionDigest"]
          if (apply && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)))
            throw Error("INVALID")
          const threadId = row.threadId,
            workspace = row.expectedWorkspace,
            operationId = row.operationId
          const sender = event.sender,
            frame = sender.mainFrame,
            assertThread = access.captureThreadFence(threadId),
            controller = new AbortController()
          const assertCurrent = () => {
            controller.signal.throwIfAborted()
            access.trusted(event)
            assertThread()
            if (
              sender.isDestroyed() ||
              sender.mainFrame !== frame ||
              event.senderFrame !== frame ||
              access.threadScope(threadId) !== workspace
            )
              throw Error("STALE")
            controller.signal.throwIfAborted()
          }
          assertCurrent()
          if (apply && reconciling) throw Error("BUSY")
          const scope = { workspace, signal: controller.signal, assertCurrent }
          if (!apply) {
            const value = preparation
              ? service.inspectPreparation(scope)
              : service.inspectUncertain({ operationId }, scope)
            assertCurrent()
            return { ok: true, value }
          }
          reconciling = true
          acquired = true
          const cancel = () => controller.abort()
          const navigate = (details: { isMainFrame: boolean }) => {
            if (details.isMainFrame) cancel()
          }
          const timer = setInterval(() => {
            try {
              assertCurrent()
            } catch {
              cancel()
            }
          }, 250)
          sender.once("destroyed", cancel)
          sender.on("did-start-navigation", navigate)
          cleanup = () => {
            clearInterval(timer)
            sender.removeListener("destroyed", cancel)
            sender.removeListener("did-start-navigation", navigate)
          }
          const value = preparation
            ? await service.recoverPreparation({ expectedFingerprint: expected }, scope)
            : await service.reconcile({ operationId, expectedInspectionDigest: expected }, scope)
          assertCurrent()
          return { ok: true, value }
        } catch (error) {
          const message = error instanceof Error ? error.message : ""
          return {
            ok: false,
            code: /BUSY$/.test(message)
              ? "BUSY"
              : /CHANGED$|STALE$/.test(message)
                ? "STALE"
                : message === "INVALID"
                  ? "INVALID"
                  : error instanceof Error && error.name === "AbortError"
                    ? "CANCELLED"
                    : "FAILED"
          }
        } finally {
          cleanup()
          if (acquired) reconciling = false
        }
      }
    )
  }
}
