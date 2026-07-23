import type { LocalGenAdoptionLines } from "../../../../shared/adoption-trace-types"

export function shouldShowSupersededFallback(
  verdict: string | null,
  fetched: boolean,
  source: LocalGenAdoptionLines["source"]
): boolean {
  return verdict === "superseded" && fetched && source !== "stored_gen"
}
