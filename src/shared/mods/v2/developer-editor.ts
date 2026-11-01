/** Native-only navigation transport. Never accepted from a guest as authority. */
export interface DeveloperEditorIntent {
  id: string
  threadId: string
  workspace: string
  scopeKey: string
  path: string
  line: number
  column: number
  expiresAt: number
  source: { provider: string; digest: string; generation: string }
  externalAvailable: boolean
}
export interface DeveloperEditorFrame extends DeveloperEditorIntent {
  text: string
  fingerprint: string
}
export interface DeveloperEditorAck {
  id: string
  fingerprint: string
  status: "preview-loaded" | "failed"
  line?: number
  column?: number
}
export type DeveloperEditorEvent =
  | { kind: "offer"; intent: DeveloperEditorIntent }
  | { kind: "retire"; id: string }
export interface DeveloperEditorApi {
  onEditorNavigation(callback: (event: DeveloperEditorEvent) => void): () => void
  editorNavigationAccept(id: string): Promise<DeveloperEditorFrame>
  editorNavigationAck(ack: DeveloperEditorAck): Promise<void>
  editorNavigationClose(id: string): Promise<void>
  editorNavigationLaunchExternal(id: string): Promise<{
    status: "external-launch-requested" | "unavailable"
    display: "unknown"
    mode?: string
    reason?: "path-requires-built-in-preview" | "ide-not-configured"
  }>
}
