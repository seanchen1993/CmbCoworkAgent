import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { types } from "node:util"
import type { AuthoringInstallService } from "../mods/devtools/authoring-install-service"
import type { AuthoringInstallAccess } from "./mods-authoring-install"
import { readRetirementVersionIds } from "../mods/devtools/authoring-retention-state"

/** Global source retirement is a separate, explicitly acknowledged desktop action. */
export function registerAuthoringRetentionHandlers(
  ipc: IpcMain,
  service: Pick<AuthoringInstallService, "inspectRetention" | "retireVersions">,
  access: AuthoringInstallAccess
) {
  let retiring = false
  for (const channel of ["inspect-retention", "retire-versions"] as const) {
    ipc.handle(
      `mods:authoring-install:${channel}`,
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
          const apply = channel === "retire-versions"
          const keys = [
            "threadId",
            "expectedWorkspace",
            ...(apply ? ["expectedFingerprint", "versionIds", "acknowledgeLostRollback"] : [])
          ]
          const descriptors = Object.getOwnPropertyDescriptors(input)
          if (
            Reflect.ownKeys(input).length !== keys.length ||
            keys.some(
              (key) =>
                !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key].enumerable
            )
          )
            throw Error("INVALID")
          const row = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
          if (
            typeof row.threadId !== "string" ||
            !row.threadId ||
            row.threadId.length > 200 ||
            typeof row.expectedWorkspace !== "string" ||
            !row.expectedWorkspace ||
            row.expectedWorkspace.length > 4096
          )
            throw Error("INVALID")
          if (
            apply &&
            (typeof row.expectedFingerprint !== "string" ||
              !/^[0-9a-f]{64}$/.test(row.expectedFingerprint) ||
              row.acknowledgeLostRollback !== true)
          )
            throw Error("INVALID")
          const versionIds = apply ? readRetirementVersionIds(row.versionIds) : []
          const threadId = row.threadId,
            workspace = row.expectedWorkspace
          const sender = event.sender,
            frame = sender.mainFrame,
            assertThread = access.captureThreadFence(threadId)
          const controller = new AbortController()
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
          const scope = { workspace, signal: controller.signal, assertCurrent }
          if (!apply) return { ok: true, value: service.inspectRetention(scope) }
          if (retiring) throw Error("BUSY")
          retiring = true
          acquired = true
          const cancel = () => controller.abort()
          const navigate = (details: { isMainFrame: boolean }) => {
            if (details.isMainFrame) cancel()
          }
          sender.once("destroyed", cancel)
          sender.on("did-start-navigation", navigate)
          const timer = setInterval(() => {
            try {
              assertCurrent()
            } catch {
              cancel()
            }
          }, 250)
          cleanup = () => {
            clearInterval(timer)
            sender.removeListener("destroyed", cancel)
            sender.removeListener("did-start-navigation", navigate)
          }
          const value = await service.retireVersions(
            {
              expectedFingerprint: row.expectedFingerprint,
              versionIds,
              acknowledgeLostRollback: true
            },
            scope
          )
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
                : /INVALID$/.test(message)
                  ? "INVALID"
                  : /LIMIT$|CAPACITY$/.test(message)
                    ? "LIMIT"
                    : error instanceof Error && error.name === "AbortError"
                      ? "CANCELLED"
                      : "FAILED"
          }
        } finally {
          cleanup()
          if (acquired) retiring = false
        }
      }
    )
  }
}
