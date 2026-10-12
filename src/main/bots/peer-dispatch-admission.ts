import { createHash } from "node:crypto"
import type { BotStore } from "./store"
import {
  inspectBotOwnedShellMaintenance,
  assertBotOwnedShellMaintenanceOwner,
  type OwnedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { canonicalJson } from "./validation"

export interface BotPeerAdmissionPlan {
  runId: string
  botId: string
  revision: number
  dataEpoch: string
  fingerprint: string
  scopeRunIds: readonly string[]
  coexistingRunIds: readonly string[]
  blocked: boolean
}
export interface BotPeerAdmissionFailure {
  runId: string
  fingerprint: string
  scopeRunIds: readonly string[]
  dataEpoch: string
}
declare const permitBrand: unique symbol
export type BotPeerClaimPermit = { readonly [permitBrand]: true }
const permits = new WeakMap<
  object,
  { store: BotStore; fingerprint: string; assertCurrent: () => void }
>()
export interface BotPeerDispatchAdmission {
  check(plan: BotPeerAdmissionPlan, signal: AbortSignal): Promise<BotPeerClaimPermit | null>
}
export const peerAdmissionFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")

/** Host bootstrap supplies its already-held stable owner. No RPC, model, test
 * flag, stored boolean or PID can manufacture this physical-closure permit. */
export function createBotPeerDispatchAdmission(
  store: BotStore,
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  assertCurrent: () => void
): BotPeerDispatchAdmission {
  return {
    async check(plan, signal) {
      signal.throwIfAborted()
      if (plan.blocked) return null
      await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
      const review = await inspectBotOwnedShellMaintenance(directory, owner, signal)
      signal.throwIfAborted()
      await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
      if (review.reason === "invalid-resource-evidence") return null
      const scope = new Set(plan.scopeRunIds),
        coexisting = new Set(plan.coexistingRunIds)
      for (const entry of review.entries) {
        if (entry.status !== "effect-unproven") continue
        if (scope.has(entry.runId)) return null
        if (coexisting.has(entry.runId)) continue
        // A late user/background turn may have completed after this message was
        // committed. It cannot make an unresolved same-Bot resource disappear.
        try {
          if (store.getRun(entry.runId).botId === plan.botId) return null
        } catch {
          return null
        }
      }
      if (store.peerDispatch.admissionPlan(plan.runId)?.fingerprint !== plan.fingerprint)
        return null
      const permit = Object.freeze({}) as BotPeerClaimPermit
      permits.set(permit, {
        store,
        fingerprint: plan.fingerprint,
        assertCurrent
      })
      return permit
    }
  }
}

/** Only the original synchronous Store.claim calls this. Invalid attempts also
 * consume a permit, so a stale read can never be retried against another run. */
export function consumeBotPeerClaimPermit(
  permit: BotPeerClaimPermit | undefined,
  store: BotStore,
  plan: BotPeerAdmissionPlan
): boolean {
  if (!permit) return false
  const record = permits.get(permit)
  permits.delete(permit)
  if (!record || record.store !== store || record.fingerprint !== plan.fingerprint || plan.blocked)
    return false
  record.assertCurrent()
  return true
}
