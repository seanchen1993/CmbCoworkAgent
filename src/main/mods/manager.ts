import { ModsManager as SharedManager } from "./manager-core"
import { ManagedModPolicy, DEFAULT_MOD_POLICY } from "./policy"
import { ModRuntimeClient } from "./runtime-client"
export * from "./manager-core"
export * from "./manager-context"

type Inputs = ConstructorParameters<typeof SharedManager>
/** Original desktop construction, using the shared domain and authority checks. */
export class ModsManager extends SharedManager {
  constructor(
    controlPath: Inputs[0],
    plugins: Inputs[1],
    confirmOperation: Inputs[2],
    notifyCards: Inputs[3],
    hostEntry?: string,
    deployment = DEFAULT_MOD_POLICY,
    globalEnabled: () => boolean = () => true
  ) {
    super(
      controlPath,
      plugins,
      confirmOperation,
      notifyCards,
      hostEntry,
      deployment,
      globalEnabled,
      {
        client: (entry) => new ModRuntimeClient(entry),
        policy: (policy, entry) => new ManagedModPolicy(policy, entry)
      }
    )
  }
}
