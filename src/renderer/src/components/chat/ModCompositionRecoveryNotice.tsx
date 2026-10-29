import { MODS_COMPOSITION_REVIEW_MESSAGE } from "../../../../shared/mods/v2/contracts"

/** Review navigation changes no source, selection or permission. */
export function ModCompositionRecoveryNotice({ onReview }: { onReview: () => void }) {
  return (
    <div role="alert" className="mt-1 space-y-2 text-sm">
      <p>{MODS_COMPOSITION_REVIEW_MESSAGE}</p>
      <button type="button" className="text-xs underline" onClick={onReview}>
        重新核对组合
      </button>
    </div>
  )
}
