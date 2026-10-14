import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModIdentity } from "../../../shared/mods/types"

export interface IndependentPromptFrame {
  active: boolean
  readonly request?: Readonly<ModIdentity>
}
const frames = new AsyncLocalStorage<IndependentPromptFrame>()

/** Host-only scope: nested model preparation cannot recursively compose another request. */
export function assertIndependentModelEntry(): void {
  const frame = frames.getStore()
  if (frame)
    throw new ModFunctionError(
      frame.active ? "MODS_MODEL_COMPOSE_REENTRANT" : "MODS_PROMPT_COMPOSE_UNAVAILABLE"
    )
}

export function independentPromptFrame() {
  return frames.getStore()
}

export async function withIndependentPromptFrame<T>(
  run: () => Promise<T>,
  request?: ModIdentity
): Promise<T> {
  assertIndependentModelEntry()
  const frame: IndependentPromptFrame = {
    active: true,
    ...(request ? { request: Object.freeze({ ...request }) } : {})
  }
  try {
    return await frames.run(frame, run)
  } finally {
    frame.active = false
  }
}
