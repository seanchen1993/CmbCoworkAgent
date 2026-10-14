import type { ModRuntimeAuthority } from "./runtime-instance"
import { ModError } from "./errors"

export interface HostFlowAuthorityInput {
  workspace: string
  threadId: string
  runId: string
  definitionDigest: string
  runtimeAuthority: ModRuntimeAuthority
  signal: AbortSignal
  assertLive(): void
}

/** A host-owned capability, never a plugin grant or a serializable IPC input. */
export interface HostFlowAuthority extends Readonly<HostFlowAuthorityInput> {
  readonly kind: "host-flow"
}

export class HostFlowAuthorities {
  private readonly issued = new WeakSet<HostFlowAuthority>()

  create(input: HostFlowAuthorityInput): HostFlowAuthority {
    if (!input.runId || !/^[a-f0-9]{64}$/.test(input.definitionDigest))
      throw new ModError("FLOW_AUTHORITY_INVALID")
    input.assertLive()
    const authority: HostFlowAuthority = Object.freeze({ ...input, kind: "host-flow" })
    this.issued.add(authority)
    return authority
  }

  assert(authority: HostFlowAuthority): void {
    if (!this.issued.has(authority)) throw new ModError("FLOW_AUTHORITY_INVALID")
    authority.signal.throwIfAborted()
    authority.runtimeAuthority.assertLive()
    authority.assertLive()
  }
}
