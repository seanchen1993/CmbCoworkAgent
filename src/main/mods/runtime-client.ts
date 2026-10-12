import { join } from "node:path"
import { launchDesktopModProcess } from "./desktop-process"
import { ModRuntimeClient as SharedClient } from "./runtime-client-core"

/** Desktop adapter; protocol, limits and recovery live in the shared client. */
export class ModRuntimeClient extends SharedClient {
  constructor(entry = join(__dirname, "mod-host.js")) {
    super(entry, launchDesktopModProcess)
  }
}
