import { launchDesktopModProcess } from "../desktop-process"
import { FunctionRuntimeClient as SharedClient } from "./runtime-client-core"

/** Desktop adapter; protocol, limits and recovery live in the shared client. */
export class FunctionRuntimeClient extends SharedClient {
  constructor(entry: string) {
    super(entry, launchDesktopModProcess)
  }
}
