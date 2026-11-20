import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { HarnessKnowledgePreviewResult } from "@/types"
import type { KnowledgeBaseListResult } from "../../../../shared/knowledge-base-types"

export function useKnowledgePreviews(
  active: boolean,
  result: KnowledgeBaseListResult | null,
  formatError: (error: unknown) => string
) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [previews, setPreviews] = useState<Record<string, HarnessKnowledgePreviewResult>>({})
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string | null>>({})
  const mounted = useRef(true)
  const loading = useRef(new Set<string>())
  const attemptedRevisions = useRef(new Map<string, number>())
  const latestResult = useRef(result)

  useEffect(() => {
    latestResult.current = result
  }, [result])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (idKey: string): Promise<void> => {
      if (loading.current.has(idKey)) return
      loading.current.add(idKey)
      const revision = latestResult.current?.knowledgeBases.find(
        (item) => item.idKey === idKey
      )?.previewRevision
      if (revision !== undefined) attemptedRevisions.current.set(idKey, revision)
      setLoadingIds(new Set(loading.current))
      try {
        const preview = await window.api.harnessBoard.getKnowledgePreview(idKey)
        if (mounted.current) setPreviews((current) => ({ ...current, [idKey]: preview }))
      } catch (error) {
        const message = formatError(error)
        if (mounted.current && !/superseded|cancelled|aborted/i.test(message)) toast.error(message)
      } finally {
        loading.current.delete(idKey)
        if (mounted.current) setLoadingIds(new Set(loading.current))
      }
    },
    [formatError]
  )

  const toggle = useCallback(
    (idKey: string): void => {
      const expanded = expandedIds.has(idKey)
      setExpandedIds((current) => {
        const next = new Set(current)
        if (expanded) next.delete(idKey)
        else next.add(idKey)
        return next
      })
      if (!expanded) void load(idKey)
    },
    [expandedIds, load]
  )

  useEffect(() => {
    if (!active || !result) return
    for (const item of result.knowledgeBases) {
      if (
        expandedIds.has(item.idKey) &&
        !loadingIds.has(item.idKey) &&
        attemptedRevisions.current.get(item.idKey) !== item.previewRevision
      ) {
        void load(item.idKey)
      }
    }
  }, [active, result, expandedIds, loadingIds, load])

  const forget = useCallback((idKey: string): void => {
    attemptedRevisions.current.delete(idKey)
    setExpandedIds((current) => {
      const next = new Set(current)
      next.delete(idKey)
      return next
    })
    setPreviews((current) => {
      const next = { ...current }
      delete next[idKey]
      return next
    })
    setSelectedPaths((current) => {
      const next = { ...current }
      delete next[idKey]
      return next
    })
  }, [])

  return { expandedIds, loadingIds, previews, selectedPaths, setSelectedPaths, toggle, forget }
}
