import type { DraftAttachmentImage } from "../../../shared/file-attachment"

/** Virtualized rows may be recycled while the main process is still decoding their images. */
export function loadVisibleMessageImages(
  element: Element,
  read: () => Promise<DraftAttachmentImage[]>,
  complete: (images: DraftAttachmentImage[] | null) => void
): () => void {
  let active = true
  let started = false
  let observer: IntersectionObserver | undefined
  const load = async () => {
    if (!active || started) return
    started = true
    observer?.disconnect()
    let images: DraftAttachmentImage[] | null
    try {
      images = await read()
    } catch {
      images = null
    }
    if (active) complete(images)
  }

  if (typeof IntersectionObserver === "undefined") {
    void load()
  } else {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load()
      },
      { rootMargin: "240px" }
    )
    observer.observe(element)
  }
  return () => {
    active = false
    observer?.disconnect()
  }
}
