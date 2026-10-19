import { useState } from "react"
import currentAssistantRun from "../../../../../docs/sparks/assets/current-assistant-run.png?url"
import projectStageRun from "../../../../../docs/sparks/assets/project-stage-run.png?url"
import projectLibrary from "../../../../../docs/sparks/assets/project-library.png?url"
import projectCompositionSession from "../../../../../docs/sparks/assets/project-composition-session.png?url"
import projectCompositionCapabilities from "../../../../../docs/sparks/assets/project-composition-capabilities.png?url"

// Only reviewed, bundled assets can become an image URL. Markdown cannot load remote files.
const images: Readonly<Record<string, string>> = {
  "assets/current-assistant-run.png": currentAssistantRun,
  "assets/project-stage-run.png": projectStageRun,
  "assets/project-library.png": projectLibrary,
  "assets/project-composition-session.png": projectCompositionSession,
  "assets/project-composition-capabilities.png": projectCompositionCapabilities
}

export function SparksDocumentationImage({
  src = "",
  alt = "",
  title
}: {
  src?: string
  alt?: string
  title?: string
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const image = Object.hasOwn(images, src) ? images[src] : undefined
  const description = alt.trim() || "说明配图"
  if (!image || failedSource === src) {
    return (
      <span
        role="img"
        aria-label={`${description}（图片无法显示）`}
        className="my-4 block rounded-lg border border-dashed bg-muted/40 p-4 text-muted-foreground"
      >
        图片无法显示：{description}。请继续阅读下方文字说明。
      </span>
    )
  }
  return (
    <img
      src={image}
      alt={description}
      title={title}
      className="my-4 block h-auto max-w-full rounded-lg border"
      loading="lazy"
      decoding="async"
      onError={() => setFailedSource(src)}
    />
  )
}
