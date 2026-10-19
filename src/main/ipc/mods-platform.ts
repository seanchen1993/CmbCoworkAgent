import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type {
  PlatformSurfaceAddress,
  PlatformSurfaceCatalog,
  PlatformSurfaceFrame
} from "../../shared/mods/v2/platform-surfaces"
import type {
  PlatformBehaviorCatalog,
  PlatformBehaviorPreview
} from "../../shared/mods/v2/platform-behaviors"
import type { FunctionUiAction } from "../../shared/mods/v2/ui"
import { ModFunctionError, isModObject } from "../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"

interface Scope {
  workspace: string
  assertCurrent(): void
}
interface Controller {
  platformSurfaceList(workspace: string, threadId: string): PlatformSurfaceCatalog
  platformSurfaceRead(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress
  ): PlatformSurfaceFrame | Promise<PlatformSurfaceFrame>
  platformSurfaceOpen(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress,
    intentId: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<PlatformSurfaceFrame>
  platformSurfaceAct(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress,
    action: FunctionUiAction,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<void>
  platformSurfaceDisable(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress
  ): void | Promise<void>
  platformSurfaceEnable(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress
  ): void | Promise<void>
  platformSurfaceClose(
    workspace: string,
    threadId: string,
    address: PlatformSurfaceAddress
  ): void | Promise<void>
  platformBehaviorList(workspace: string, threadId: string): PlatformBehaviorCatalog
  platformBehaviorPreview(
    workspace: string,
    threadId: string,
    selected: string[]
  ): PlatformBehaviorPreview
  platformBehaviorApply(
    workspace: string,
    threadId: string,
    previewId: string,
    revision: number
  ): void
  platformBehaviorDisable(workspace: string, threadId: string): void
}
interface Access {
  capture(event: IpcMainInvokeEvent, threadId: string, writable: boolean): Scope
  view<T>(workspace: string, threadId: string, work: () => Promise<T>): Promise<T>
  userAction<T>(
    workspace: string,
    threadId: string,
    signal: AbortSignal,
    assertCurrent: () => void,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T>
}
const invalid = (): never => {
  throw new ModFunctionError("MODS_PLATFORM_ARGUMENTS")
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isModObject(value) || Object.keys(value).some((key) => !fields.includes(key)))
    return invalid()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) return invalid()
  return value
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid()
  return Number(value)
}
function address(value: unknown): PlatformSurfaceAddress {
  const input = record(value, ["key", "revision", "openId"])
  return {
    key: text(input.key, 2048),
    revision: revision(input.revision),
    ...(input.openId === undefined ? {} : { openId: text(input.openId, 100) })
  }
}

export function registerPlatformHandlers(
  ipc: IpcMain,
  controller: Controller,
  access: Access
): void {
  const capture = (
    event: IpcMainInvokeEvent,
    input: Record<string, unknown>,
    writable: boolean
  ) => {
    const threadId = text(input.threadId, 200)
    const scope = access.capture(event, threadId, writable)
    scope.assertCurrent()
    return { ...scope, threadId }
  }
  const action = async <T>(
    event: IpcMainInvokeEvent,
    scope: Scope & { threadId: string },
    leased: boolean,
    work: (signal: AbortSignal, guard: () => void) => Promise<T>
  ): Promise<T> => {
    const abort = new AbortController()
    let operationSignal = abort.signal
    const lost = () => abort.abort(new ModFunctionError("MODS_PLATFORM_SCOPE_CHANGED"))
    event.sender.once("destroyed", lost)
    const guard = () => {
      operationSignal.throwIfAborted()
      scope.assertCurrent()
    }
    try {
      guard()
      const invoke = (signal: AbortSignal) => {
        operationSignal = signal
        guard()
        return work(signal, guard)
      }
      const result = leased
        ? await access.userAction(scope.workspace, scope.threadId, abort.signal, guard, invoke)
        : await access.view(scope.workspace, scope.threadId, () => invoke(abort.signal))
      guard()
      return result
    } finally {
      event.sender.removeListener("destroyed", lost)
    }
  }
  ipc.handle("mods:platform-surface-list", (event, value: unknown) => {
    const input = record(value, ["threadId"]),
      scope = capture(event, input, false)
    return controller.platformSurfaceList(scope.workspace, scope.threadId)
  })
  ipc.handle("mods:platform-surface-read", async (event, value: unknown) => {
    const input = record(value, ["threadId", "address"]),
      scope = capture(event, input, false)
    const result = await controller.platformSurfaceRead(
      scope.workspace,
      scope.threadId,
      address(input.address)
    )
    scope.assertCurrent()
    return result
  })
  ipc.handle("mods:platform-surface-open", (event, value: unknown) => {
    const input = record(value, ["threadId", "address", "intentId"]),
      scope = capture(event, input, true)
    const target = address(input.address),
      intentId = text(input.intentId, 200)
    return action(event, scope, false, (signal, guard) =>
      controller.platformSurfaceOpen(
        scope.workspace,
        scope.threadId,
        target,
        intentId,
        signal,
        guard
      )
    )
  })
  ipc.handle("mods:platform-surface-act", (event, value: unknown) => {
    const input = record(value, ["threadId", "address", "action"]),
      scope = capture(event, input, true)
    const target = address(input.address)
    if (!isModObject(input.action) || encodeModJson(input.action).length > 256 * 1024)
      return invalid()
    const uiAction = parseModJson(encodeModJson(input.action)) as unknown as FunctionUiAction
    return action(event, scope, true, (signal, guard) =>
      controller.platformSurfaceAct(
        scope.workspace,
        scope.threadId,
        target,
        uiAction,
        signal,
        guard
      )
    )
  })
  for (const control of ["enable", "disable", "close"] as const)
    ipc.handle(`mods:platform-surface-${control}`, async (event, value: unknown) => {
      const input = record(value, ["threadId", "address"]),
        scope = capture(event, input, true)
      const method =
        control === "enable"
          ? controller.platformSurfaceEnable
          : control === "disable"
            ? controller.platformSurfaceDisable
            : controller.platformSurfaceClose
      await method.call(controller, scope.workspace, scope.threadId, address(input.address))
      scope.assertCurrent()
    })
  ipc.handle("mods:platform-behavior-list", (event, value: unknown) => {
    const input = record(value, ["threadId"]),
      scope = capture(event, input, false)
    return controller.platformBehaviorList(scope.workspace, scope.threadId)
  })
  ipc.handle("mods:platform-behavior-preview", (event, value: unknown) => {
    const input = record(value, ["threadId", "selected"]),
      scope = capture(event, input, true)
    if (!Array.isArray(input.selected) || input.selected.length > 32) return invalid()
    const selected = input.selected.map((item) => text(item, 320))
    if (new Set(selected).size !== selected.length) return invalid()
    return controller.platformBehaviorPreview(scope.workspace, scope.threadId, selected)
  })
  ipc.handle("mods:platform-behavior-apply", (event, value: unknown) => {
    const input = record(value, ["threadId", "previewId", "revision"]),
      scope = capture(event, input, true)
    return controller.platformBehaviorApply(
      scope.workspace,
      scope.threadId,
      text(input.previewId, 200),
      revision(input.revision)
    )
  })
  ipc.handle("mods:platform-behavior-disable", (event, value: unknown) => {
    const input = record(value, ["threadId"]),
      scope = capture(event, input, true)
    return controller.platformBehaviorDisable(scope.workspace, scope.threadId)
  })
}
