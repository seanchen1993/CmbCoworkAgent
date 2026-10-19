import type {
  PlatformSurfaceAddress,
  PlatformSurfaceCatalog,
  PlatformSurfaceFrame
} from "./platform-surfaces"
import type { PlatformBehaviorCatalog, PlatformBehaviorPreview } from "./platform-behaviors"
import type { FunctionUiAction } from "./ui"

/** Trusted desktop controls. These methods are not part of the guest SDK. */
export interface PlatformUiApi {
  platformSurfaceList(threadId: string): Promise<PlatformSurfaceCatalog>
  platformSurfaceOpen(
    threadId: string,
    address: PlatformSurfaceAddress,
    intentId: string
  ): Promise<PlatformSurfaceFrame>
  platformSurfaceRead(
    threadId: string,
    address: PlatformSurfaceAddress
  ): Promise<PlatformSurfaceFrame>
  platformSurfaceClose(threadId: string, address: PlatformSurfaceAddress): Promise<void>
  platformSurfaceAct(
    threadId: string,
    address: PlatformSurfaceAddress,
    action: FunctionUiAction
  ): Promise<void>
  platformSurfaceDisable(threadId: string, address: PlatformSurfaceAddress): Promise<void>
  platformSurfaceEnable(threadId: string, address: PlatformSurfaceAddress): Promise<void>
  platformBehaviorList(threadId: string): Promise<PlatformBehaviorCatalog>
  platformBehaviorPreview(threadId: string, selected: string[]): Promise<PlatformBehaviorPreview>
  platformBehaviorApply(threadId: string, previewId: string, revision: number): Promise<void>
  platformBehaviorDisable(threadId: string): Promise<void>
}
