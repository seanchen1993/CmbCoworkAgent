import { useEffect, useState } from "react"
import type {
  HarnessProjectUseApproval,
  HarnessProjectUseReview,
  HarnessProjectUseReviewInput
} from "../../../../shared/project-use-authorization"
import { useAppStore } from "@/lib/store"

/** Selection reads the scope only. The existing form submission records consent. */
export function useProjectUseReview(input?: HarnessProjectUseReviewInput) {
  const account = useAppStore((state) => state.accountRevision)
  const key = input ? JSON.stringify([account, input]) : ""
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    key: string
    review?: HarnessProjectUseReview
    error?: string
  }>()
  useEffect(() => {
    if (!input) {
      setResult(undefined)
      return
    }
    let current = true
    let expiry: ReturnType<typeof setTimeout> | undefined
    setResult({ key })
    // Folder names also follow the project name while typing. Review the settled target once.
    const request = setTimeout(() => {
      void window.api.harnessBoard
        .reviewProjectUse(input)
        .then((review) => {
          if (!current) return
          if (review.expiresAt <= Date.now()) throw Error("expired")
          setResult({ key, review })
          expiry = setTimeout(
            () => {
              if (current) setResult({ key, error: "核对已过期，请重新核对后提交。" })
            },
            Math.min(review.expiresAt - Date.now(), 2_147_483_647)
          )
        })
        .catch(() => {
          if (current)
            setResult({
              key,
              error: "无法核对插件。请确认目录可用后重试；若插件已更新，请取消后重新选择插件。"
            })
        })
    }, 300)
    return () => {
      current = false
      clearTimeout(request)
      if (expiry) clearTimeout(expiry)
    }
    // The serialized key includes every input field and the active account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  const active = result?.key === key ? result : undefined
  const review = active?.review && active.review.expiresAt > Date.now() ? active.review : undefined
  const approval: HarnessProjectUseApproval | undefined = review
    ? { reviewId: review.reviewId, reviewDigest: review.reviewDigest }
    : undefined
  return {
    review,
    approval,
    error: active?.error,
    pending: !!input && !review && !active?.error,
    refresh: () => {
      setResult({ key })
      setAttempt((value) => value + 1)
    }
  }
}
