import { useCallback, useSyncExternalStore } from "react"
import type { ClawVisualAnnotation, ClawVisualTargetKind } from "./visual-edit-types"

type Listener = () => void

const annotationStore = new Map<string, ClawVisualAnnotation[]>()
const listeners = new Set<Listener>()
const EMPTY_ANNOTATIONS: ClawVisualAnnotation[] = []
const MAX_VISUAL_EDIT_STORE_ENTRIES = 100

function emitChange(): void {
  listeners.forEach((listener) => listener())
}

function pruneStore(): void {
  while (annotationStore.size > MAX_VISUAL_EDIT_STORE_ENTRIES) {
    const oldest = annotationStore.keys().next()
    if (oldest.done) return
    annotationStore.delete(oldest.value)
  }
}

export function getVisualEditStoreKey(params: {
  threadId: string
  targetKind: ClawVisualTargetKind
  targetPath?: string
  targetUrl?: string
}): string {
  return [params.threadId, params.targetKind, params.targetPath ?? "", params.targetUrl ?? ""].join(
    "::"
  )
}

export function setVisualEditAnnotations(
  key: string,
  next: ClawVisualAnnotation[] | ((prev: ClawVisualAnnotation[]) => ClawVisualAnnotation[])
): void {
  const prev = annotationStore.get(key) ?? EMPTY_ANNOTATIONS
  const value = typeof next === "function" ? next(prev) : next
  annotationStore.delete(key)
  if (value.length > 0) {
    annotationStore.set(key, value)
    pruneStore()
  }
  emitChange()
}

export function getVisualEditAnnotationsSnapshot(key: string): ClawVisualAnnotation[] {
  return annotationStore.get(key) ?? EMPTY_ANNOTATIONS
}

export function clearVisualEditAnnotationsForThread(threadId: string): void {
  const prefix = `${threadId}::`
  for (const key of annotationStore.keys()) {
    if (key.startsWith(prefix)) {
      annotationStore.delete(key)
    }
  }
  emitChange()
}

function subscribeVisualEditStore(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVisualEditAnnotations(key: string): {
  annotations: ClawVisualAnnotation[]
  setAnnotations: (
    next: ClawVisualAnnotation[] | ((prev: ClawVisualAnnotation[]) => ClawVisualAnnotation[])
  ) => void
} {
  const annotations = useSyncExternalStore(
    subscribeVisualEditStore,
    () => annotationStore.get(key) ?? EMPTY_ANNOTATIONS,
    () => annotationStore.get(key) ?? EMPTY_ANNOTATIONS
  )

  const setAnnotations = useCallback(
    (next: ClawVisualAnnotation[] | ((prev: ClawVisualAnnotation[]) => ClawVisualAnnotation[])) =>
      setVisualEditAnnotations(key, next),
    [key]
  )

  return { annotations, setAnnotations }
}
