import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionUiResolveComponent } from "./ui-resolve-private-types"

const admitted = new WeakSet<FunctionUiResolveDrawing>()
const drawings = new AsyncLocalStorage<FunctionUiResolveDrawing>()

/** Candidate/committed generation lifetime, independent of a normally ended invoke frame. */
export class FunctionUiResolveDrawing {
  readonly identity = Object.freeze({})
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal

  constructor(
    readonly component: FunctionUiResolveComponent,
    readonly generation: string,
    readonly requestId: string,
    private readonly guard: () => void
  ) {
    admitted.add(this)
  }

  assertCurrent(): void {
    this.signal.throwIfAborted()
    this.guard()
    this.signal.throwIfAborted()
  }

  close(reason: unknown = new ModFunctionError("MODS_UI_DRAWING_STALE")): void {
    this.controller.abort(reason)
  }
}

/** Private host propagation only. Nothing is inserted into public FunctionInvocation metadata. */
export function withFunctionUiResolveDrawing<T>(
  drawing: FunctionUiResolveDrawing,
  run: () => Promise<T>
): Promise<T> {
  if (!admitted.has(drawing)) throw new ModFunctionError("MODS_UI_RESOLVE_DRAWING_IDENTITY")
  drawing.assertCurrent()
  return drawings.run(drawing, run)
}

export function currentFunctionUiResolveDrawing(): FunctionUiResolveDrawing | undefined {
  const drawing = drawings.getStore()
  drawing?.assertCurrent()
  return drawing
}
