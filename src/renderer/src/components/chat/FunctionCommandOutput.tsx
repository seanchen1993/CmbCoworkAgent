import type { ReactNode } from "react"
import { FunctionSite } from "./FunctionSite"

/** The job's stored result and native success/error label retain their original authority. */
export function FunctionCommandOutput({
  threadId,
  command,
  text,
  isErrored,
  fallback
}: {
  threadId: string
  command: string
  text: string
  isErrored: boolean
  fallback: ReactNode
}): ReactNode {
  if (!text.trim() || text.length > 10000) return fallback
  return (
    <FunctionSite
      threadId={threadId}
      component="CommandOutput"
      className="contents"
      // Jobs intentionally do not persist raw command arguments. Never infer them or expose secrets.
      facts={{ command, args: "***", text, isErrored }}
      fallback={fallback}
    />
  )
}
