import type { CompletionEvidenceReferences } from "../v2/completion-evidence"

/** AutoBiz owns its workspace layout. Generic evidence capture never guesses these paths. */
export const AUTOBIZ_COMPLETION_EVIDENCE: CompletionEvidenceReferences = Object.freeze({
  paths: Object.freeze([".autobizdevops"]),
  statePaths: Object.freeze([".autobizdevops/state.json"])
})

export function autobizFeatureEvidencePaths(feature: string): string[] {
  if (
    !feature ||
    feature.length > 512 ||
    /[\\:]/u.test(feature) ||
    [...feature].some((character) => character.charCodeAt(0) < 32) ||
    feature.startsWith("/") ||
    feature.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("AUTOBIZ_FEATURE_INVALID")
  return [`.autobizdevops/features/${feature}`]
}
