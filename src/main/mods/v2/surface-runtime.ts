import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { SURFACE_BOOTSTRAP } from "./surface-bootstrap"

export interface ModSurfaceSnapshot {
  tree: ModObject
  dirty: boolean
  message?: ModJson
  timers: Array<{ id: string; ms: number }>
}

/** One instance per mounted Client key. No $, Node, DOM or production credentials in its VM. */
export class ModSurfaceRuntime {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private readonly guest: FunctionGuestRuntime) {}

  static async create(code: string): Promise<ModSurfaceRuntime> {
    return new ModSurfaceRuntime(await FunctionGuestRuntime.create(SURFACE_BOOTSTRAP + "\n" + code))
  }

  update(event: ModObject): Promise<ModSurfaceSnapshot> {
    const operation = this.queue.then(async () => {
      const result = await this.guest.invoke(
        "0",
        event,
        async () => {
          throw new ModFunctionError("MODS_CLIENT_CAPABILITY_DENIED")
        },
        {
          event: "surface.update",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "client", root: "" }
        }
      )
      const value = result.value
      if (
        !isModObject(value) ||
        !isModObject(value.tree) ||
        !Array.isArray(value.timers) ||
        typeof value.dirty !== "boolean"
      )
        throw new ModFunctionError("MODS_CLIENT_RESULT")
      return value as unknown as ModSurfaceSnapshot
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  dispose(): void {
    this.guest.dispose()
  }
}
