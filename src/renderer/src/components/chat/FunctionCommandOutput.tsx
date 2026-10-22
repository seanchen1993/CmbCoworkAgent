import type { ReactNode } from "react"
import { FunctionSite } from "./FunctionSite"
import { functionSiteRowIdentity } from "../../lib/function-site-identity"

/** The job's stored result and native success/error label retain their original authority. */
export function FunctionCommandOutput({
  threadId,
  jobId,
  channel = "output",
  command,
  text,
  isErrored,
  fallback,
  renderText
}: {
  threadId: string
  jobId?: string
  channel?: "output" | "error"
  command: string
  text: string
  isErrored: boolean
  fallback: ReactNode
  renderText(text: string): ReactNode
}): ReactNode {
  if (!text.trim() || text.length > 10000) return fallback
  return (
    <FunctionSite
      threadId={threadId}
      component="CommandOutput"
      presentationId={
        jobId ? functionSiteRowIdentity("CommandOutput", [jobId, channel]) : undefined
      }
      className="contents"
      // Jobs intentionally do not persist raw command arguments. Never infer them or expose secrets.
      facts={{ command, args: "***", text, isErrored }}
      fallback={fallback}
      renderNative={(safe) => (typeof safe.text === "string" ? renderText(safe.text) : null)}
    />
  )
}
