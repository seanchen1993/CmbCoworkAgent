import type {
  BrowserRecordingSession,
  BrowserRecordingSource
} from "../../../../shared/browser-types"

export function getRecordingLabel(source: BrowserRecordingSource): string {
  void source
  return "录制脚本"
}

export function isRecordingSessionActive(session: BrowserRecordingSession): boolean {
  return session.status === "recording" || session.status === "paused"
}

export function recordingSessionHasOutput(session: BrowserRecordingSession): boolean {
  return session.status !== "idle" || session.actions.length > 0 || session.script.trim().length > 0
}

export function getRecordingStatusText(
  source: BrowserRecordingSource,
  session: BrowserRecordingSession
): string {
  const label = getRecordingLabel(source)
  if (session.status === "recording") {
    return `${label}进行中，已捕获 ${session.actions.length} 步`
  }
  if (session.status === "paused") {
    return `${label}已暂停`
  }
  return "未开始"
}

export function getRecordingStatusDotClassName(
  browserCreated: boolean,
  session: BrowserRecordingSession
): string {
  if (session.status === "recording") {
    return "bg-status-info animate-tactical-pulse"
  }
  if (session.status === "paused") {
    return "bg-status-warning"
  }
  return browserCreated ? "bg-primary" : "bg-muted-foreground/60"
}
