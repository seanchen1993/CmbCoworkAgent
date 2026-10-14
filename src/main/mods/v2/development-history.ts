import { createHash } from "node:crypto"
import type { ModControlStore } from "../control-store"
import type { ModJson } from "../../../shared/mods/types"
import {
  DEVELOPMENT_CAPABILITIES,
  type DevelopmentScope,
  type DevelopmentStatus
} from "./development-session"

const namespace = "host:development-status:v1"
function identity(scope: DevelopmentScope) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.workspace,
        scope.threadId,
        scope.incarnation.token,
        scope.incarnation.token === null ? scope.incarnation.legacyCreatedAt : null
      ])
    )
    .digest("hex")
}

/** Durable observation only. Records can never reconstruct an approval or live generation. */
export class DevelopmentHistory {
  constructor(private readonly store: ModControlStore) {}
  write(scope: DevelopmentScope, status: DevelopmentStatus): void {
    this.store.functionState.set(namespace, identity(scope), status as unknown as ModJson)
  }
  read(scope: DevelopmentScope): DevelopmentStatus | undefined {
    const value = this.store.functionState.get(namespace, identity(scope))
    if (value === undefined) return undefined
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.componentId !== "string" ||
      value.componentId.length > 200 ||
      typeof value.draftId !== "string" ||
      value.draftId.length > 200 ||
      typeof value.turnId !== "string" ||
      value.turnId.length > 200 ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      typeof value.bundleDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.bundleDigest) ||
      typeof value.compiledDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.compiledDigest) ||
      !Array.isArray(value.capabilities) ||
      value.capabilities.length > DEVELOPMENT_CAPABILITIES.length ||
      value.capabilities.some(
        (item) => typeof item !== "string" || !DEVELOPMENT_CAPABILITIES.includes(item)
      ) ||
      typeof value.phase !== "string" ||
      ![
        "needs-approval",
        "queued",
        "preflight",
        "retiring",
        "active",
        "stopped",
        "failed",
        "unknown"
      ].includes(value.phase)
    )
      throw Error("MODS_DEVELOPMENT_HISTORY_INVALID")
    const uncertain = ["retiring", "active", "unknown"].includes(value.phase)
    return {
      componentId: value.componentId,
      draftId: value.draftId,
      turnId: value.turnId,
      revision: value.revision,
      bundleDigest: value.bundleDigest,
      compiledDigest: value.compiledDigest,
      capabilities: value.capabilities as string[],
      phase: uncertain ? "unknown" : "stopped",
      error: uncertain
        ? "MODS_DEVELOPMENT_RESTART_UNCONFIRMED"
        : "MODS_DEVELOPMENT_RESTART_APPROVAL_REQUIRED"
    }
  }
}
