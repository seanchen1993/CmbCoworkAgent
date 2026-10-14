import type {
  FunctionUiResolveWireDrawing,
  FunctionUiResolveWireResponse
} from "../../../shared/mods/v2/ui-resolve-wire"
import type { FunctionUiResolveDrawing } from "./ui-resolve-drawing"
import type { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"

/** Exact native assembly attached to one actual physical RuntimeClient incarnation. */
export interface FunctionUiResolveTransportAdapter {
  readonly assembly: string
  readonly physical: FunctionUiResolveHostLifetime
  ownsRuntime(runtimeId: string): boolean
  bindDrawing(runtimeId: string, drawing: FunctionUiResolveDrawing): FunctionUiResolveWireDrawing
  receive(message: FunctionUiResolveWireResponse): void
  close(): void
}
