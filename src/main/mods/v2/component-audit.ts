import type { ModIdentity } from "../../../shared/mods/types"
import type { ModGrant } from "../control-store"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

type Components = NonNullable<ModIdentity["components"]>
const snapshots = new WeakMap<
  ModGrant,
  { workspace: string; threadId: string; components: Components; assertLive(): void }
>()

/** Attach provenance to this session's real grant object, never to guest arguments. */
export function bindFunctionComponentAudit(
  grant: ModGrant,
  threadId: string,
  components: Components,
  assertLive: () => void
): void {
  if (snapshots.has(grant)) throw new ModFunctionError("CLAW_COMPONENT_AUDIT_ALREADY_BOUND")
  snapshots.set(grant, {
    workspace: grant.workspace,
    threadId,
    components: structuredClone(components),
    assertLive
  })
}

export function functionComponentAudit(
  grant: ModGrant,
  workspace: string,
  threadId: string
): Components | undefined {
  const snapshot = snapshots.get(grant)
  if (!snapshot) return undefined
  if (snapshot.workspace !== workspace || snapshot.threadId !== threadId)
    throw new ModFunctionError("CLAW_COMPONENT_SCOPE_CHANGED")
  snapshot.assertLive()
  return structuredClone(snapshot.components)
}
