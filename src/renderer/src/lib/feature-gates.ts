import { useCallback, useEffect, useState } from "react"
import type {
  FeatureGateCheckOptions,
  FeatureGateCheckResult,
  FeatureGateKey
} from "../../../shared/feature-gates"

const DISABLED_RESULT: FeatureGateCheckResult = {
  enabled: false,
  reason: "feature-gate-client-error"
}
const featureGateResultCache = new Map<FeatureGateKey, FeatureGateCheckResult>()

interface FeatureGateState extends FeatureGateCheckResult {
  loading: boolean
}

export function useFeatureGate(name: FeatureGateKey): FeatureGateState & {
  refresh: (options?: FeatureGateCheckOptions) => Promise<FeatureGateCheckResult>
} {
  const [state, setState] = useState<FeatureGateState>(() => {
    const cached = featureGateResultCache.get(name)
    return cached ? { ...cached, loading: false } : { ...DISABLED_RESULT, loading: true }
  })

  const refresh = useCallback(
    async (options?: FeatureGateCheckOptions): Promise<FeatureGateCheckResult> => {
      setState((prev) => ({ ...prev, loading: true }))
      try {
        const result = await window.api.featureGates.isEnabled(name, options)
        featureGateResultCache.set(name, result)
        setState({ ...result, loading: false })
        return result
      } catch {
        const fallback = featureGateResultCache.get(name) ?? DISABLED_RESULT
        setState({ ...fallback, loading: false })
        return DISABLED_RESULT
      }
    },
    [name]
  )

  useEffect(() => {
    let canceled = false
    const cached = featureGateResultCache.get(name)
    setState((prev) => (cached ? { ...cached, loading: false } : { ...prev, loading: true }))
    window.api.featureGates
      .isEnabled(name)
      .then((result) => {
        featureGateResultCache.set(name, result)
        if (!canceled) setState({ ...result, loading: false })
      })
      .catch(() => {
        const fallback = featureGateResultCache.get(name) ?? DISABLED_RESULT
        if (!canceled) setState({ ...fallback, loading: false })
      })

    return () => {
      canceled = true
    }
  }, [name])

  return { ...state, refresh }
}
