import { join } from "node:path"
import { FunctionRuntimeClient } from "../v2/runtime-client"
import type { AuthoringPreviewBackend } from "./authoring-preview"
import { AuthoringPreflightClient } from "./authoring-preflight-client"

/** A fresh utility process per preview; never reuse the installed Mods runtime. */
export function createAuthoringPreviewBackend(): AuthoringPreviewBackend {
  const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  const preflight = new AuthoringPreflightClient(join(__dirname, "mods-authoring-preflight.js"))
  return {
    preflight: (directory, signal) => preflight.run(directory, signal),
    load: (code, options) => client.load(code, options),
    stop: async () => {
      const results = await Promise.allSettled([client.stopAndDrain(), preflight.stop()])
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    }
  }
}
