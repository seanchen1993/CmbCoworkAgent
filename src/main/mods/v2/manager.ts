import { join } from "node:path"
import { FunctionModsManager as SharedManager } from "./manager-core"
import { FunctionRuntimeClient } from "./runtime-client"
export * from "./manager-core"
type Inputs = ConstructorParameters<typeof SharedManager>
export class FunctionModsManager extends SharedManager {
  constructor(
    store: Inputs[0],
    host: Inputs[1],
    createClient: Inputs[2] = () =>
      new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  ) {
    super(store, host, createClient)
  }
}
