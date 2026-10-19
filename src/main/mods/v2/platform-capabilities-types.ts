import type { ModJson, ModObject } from "../../../shared/mods/types"
import type {
  PlatformCapabilityActionResult,
  PlatformCapabilityDescriptor,
  PlatformCapabilityRef,
  PlatformCapabilitySource
} from "../../../shared/mods/v2/platform-capabilities"

export interface NativePlatformCaller extends PlatformCapabilitySource {
  name: string
}
/** Main-only native context. Never serialized to or accepted from a guest. */
export interface NativePlatformCallContext {
  readonly workspace: string
  readonly threadId: string
  readonly incarnation: string
  readonly generation: string
  readonly caller: NativePlatformCaller
  readonly signal: AbortSignal
  assertCurrent(): void
  publish(value: ModJson): void
  /** Retains the original caller chain for every nested effect and native permission check. */
  invoke(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    requestKey: string
  ): Promise<PlatformCapabilityActionResult>
}
export interface NativePlatformCapabilityProvider {
  readonly provider: string
  readonly descriptor: PlatformCapabilityDescriptor
  /** Stable implementation identity, supplied only by the main process. */
  readonly digest?: string
  read?(context: NativePlatformCallContext): Promise<ModJson> | ModJson
  /** Attach to original business events; no timer or observer is started by discovery. */
  watch?(context: NativePlatformCallContext): () => void
  act(context: NativePlatformCallContext, action: string, input: ModObject): Promise<ModJson>
  /** Native cleanup must settle actual work; a cancellation request alone is not cleanup. */
  close?(): Promise<void> | void
}
export interface NativeHostFileEdit {
  workspace: string
  threadId: string
  incarnation: string
  path: string
  operation: "write_file" | "edit_file" | "fs.write"
  requestId: string
}
