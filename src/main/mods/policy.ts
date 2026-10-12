import { ModRuntimeClient } from "./runtime-client"
import { ManagedModPolicy as SharedPolicy, DEFAULT_MOD_POLICY } from "./policy-core"
export * from "./policy-core"

export class ManagedModPolicy extends SharedPolicy {
  constructor(deployment = DEFAULT_MOD_POLICY, hostEntry?: string) {
    super(deployment, new ModRuntimeClient(hostEntry))
  }
}
