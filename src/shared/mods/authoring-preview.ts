import type { AuthoringScope } from "./authoring"
import type { ModJson } from "./types"

export interface AuthoringPreviewAction {
  kind: "inspect" | "command" | "tool" | "rule"
  target: string
  input: string
}
export interface AuthoringPreviewRequest extends AuthoringScope {
  id: string
  revision: number
  sourceDigest: string
  requestId: string
  action: AuthoringPreviewAction
}
export interface AuthoringPreviewView {
  id: string
  revision: number
  requestId: string
  sourceDigest: string
  compiledDigest: string
  action: AuthoringPreviewAction["kind"]
  failures: number
  commands: { name: string; description: string }[]
  tools: { name: string; description: string }[]
  checks: { types: boolean; events: boolean; sdk: boolean }
  diagnostics: { source: "types" | "events" | "sdk"; message: string }[]
  omittedDiagnostics: number
  result: ModJson
  panes: { title: string; text: string }[]
  paneTextTruncated: boolean
}
export interface AuthoringPreviewApi {
  start(input: AuthoringPreviewRequest): Promise<AuthoringPreviewView>
  cancel(input: AuthoringScope & { requestId: string }): Promise<void>
}
