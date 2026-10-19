import type {
  DevelopmentBusinessStatus,
  DevelopmentProjectTrialRequest
} from "../../../../shared/mods/development"

/** Route observations only. Native actions still check source, scope and approval. */
export function isHostBusinessCreatorReview(
  request: DevelopmentProjectTrialRequest | undefined,
  review: DevelopmentBusinessStatus["review"]
): boolean {
  const origin = request?.origin
  return (
    !!origin &&
    origin.kind === "business-assembly" &&
    !!review &&
    !!origin.planId &&
    !!origin.copyId &&
    !!origin.digest &&
    origin.planId === review.planId &&
    origin.copyId === review.copyId &&
    origin.digest === review.digest
  )
}
