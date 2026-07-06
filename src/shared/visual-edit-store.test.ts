import { describe, expect, it } from "vitest"
import {
  clearVisualEditAnnotationsForThread,
  getVisualEditAnnotationsSnapshot,
  getVisualEditStoreKey,
  setVisualEditAnnotations
} from "../renderer/src/components/visual-edit/visual-edit-store"
import type { ClawVisualAnnotation } from "../renderer/src/components/visual-edit/visual-edit-types"

function annotation(id: string): ClawVisualAnnotation {
  return {
    id,
    kind: "comment",
    pageX: 1,
    pageY: 1,
    text: `annotation ${id}`,
    status: "pending",
    createdAt: 1
  }
}

describe("visual-edit-store", () => {
  it("isolates annotations by thread and target", () => {
    const keyA = getVisualEditStoreKey({
      threadId: "store-test-a",
      targetKind: "html-preview",
      targetPath: "index.html"
    })
    const keyB = getVisualEditStoreKey({
      threadId: "store-test-a",
      targetKind: "html-preview",
      targetPath: "about.html"
    })

    setVisualEditAnnotations(keyA, [annotation("A1")])
    setVisualEditAnnotations(keyB, [annotation("A2")])

    expect(getVisualEditAnnotationsSnapshot(keyA).map((item) => item.id)).toEqual(["A1"])
    expect(getVisualEditAnnotationsSnapshot(keyB).map((item) => item.id)).toEqual(["A2"])

    clearVisualEditAnnotationsForThread("store-test-a")
  })

  it("deletes empty annotation entries", () => {
    const key = getVisualEditStoreKey({
      threadId: "store-test-empty",
      targetKind: "html-preview",
      targetPath: "index.html"
    })

    setVisualEditAnnotations(key, [annotation("A1")])
    setVisualEditAnnotations(key, [])

    expect(getVisualEditAnnotationsSnapshot(key)).toEqual([])
  })
})
