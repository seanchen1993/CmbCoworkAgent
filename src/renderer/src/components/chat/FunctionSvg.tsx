import { useMemo } from "react"
import type { ModObject } from "../../../../shared/mods/types"
import { scrubFunctionSvg, functionSvgDocument } from "../../lib/function-svg"

/** SVG never enters the application's DOM; interactive drawings retain a script-less opaque origin. */
export function FunctionSvg({ props: values }: { props: ModObject }): React.JSX.Element {
  const source = String(values.source)
  const svg = useMemo(() => scrubFunctionSvg(source), [source])
  const alt = String(values.alt)
  const width = values.width as number | undefined
  const height = values.height as number | undefined
  if (!svg)
    return (
      <span role="img" aria-label={alt}>
        {alt}
      </span>
    )
  return values.isInteractive ? (
    <iframe
      title={alt}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={functionSvgDocument(svg)}
      width={width}
      height={height}
      style={{ border: 0, maxWidth: "100%" }}
    />
  ) : (
    <img
      alt={alt}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      width={width}
      height={height}
      style={{ maxWidth: "100%", objectFit: "contain" }}
    />
  )
}
