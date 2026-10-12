/** Default browser work surface, aligned with Grok Bot 0.68.1 (2026-10-07).
 * Frame tickets still carry the actual page dimensions for input mapping.
 */
export const BOT_BROWSER_VIEWPORT = Object.freeze({ width: 1920, height: 1200 })

/** Includes the active input. Shared by the renderer FIFO and Host admission. */
export const BOT_HUMAN_INPUT_LIMIT = 16
export const BOT_HUMAN_INPUT_CHARACTERS = 32_000

/** Current local browser process only; readiness does not imply a site login or authorization. */
export interface BotComputerStatus {
  state: "stopped" | "starting" | "ready" | "stopping" | "failed"
  browser: string
  version: string | null
  startedAt: number | null
  attemptId: string | null
}

export interface BotBrowserTarget {
  botId: string
  /** Original workflow child owner; absent for a persistent Bot surface. */
  taskRunId?: string
  generation: string
  controlEpoch: number
  control: "bot" | "human" | "handoff"
  viewId: string
}
export interface BotBrowserSession {
  urls: string[]
  active: number
  /** Survives browser/Host recreation; a client must explicitly reclaim or release. */
  humanHeld?: true
}
export interface BotBrowserControl extends BotBrowserTarget {
  /** Viewer-relative ownership; never an authorization credential. */
  controlOwner?: "self" | "other"
  controlOwnerConnected?: boolean
}
export interface BotNativeSelectOption {
  index: number
  label: string
  group?: string
  selected: boolean
}
/** Human-view projection only; option values and DOM selectors remain in the Host. */
export interface BotNativeSelect {
  token: string
  label: string
  multiple: boolean
  options: BotNativeSelectOption[]
}
export interface BotBrowserFrame extends BotBrowserControl {
  nativeSelect?: BotNativeSelect
  /** Viewer-bound continuous human input; never authorizes a Bot/model action. */
  humanInputLease?: { id: string; nextSequence: number }
  /** Navigation has started; the displayed document cannot authorize another input yet. */
  humanInputPending?: true
  frameSeq: number
  /** Present on current Hosts. Omitted by older Hosts, which cannot support queued input. */
  navigationEpoch?: number
  width: number
  height: number
  url: string
  title: string
  image: string
  tabs: { viewId: string; title: string; url: string }[]
}
export interface BotHumanInput {
  frameSeq: number
  /** Original visible frame stays in frameSeq; this lease does not rebase coordinates. */
  humanInputLease?: { id: string; sequence: number }
  /** Older clients may omit this; the Host still fences its retained frame's document epoch. */
  navigationEpoch?: number
  kind:
    | "click"
    | "text"
    | "key"
    | "scroll"
    | "navigate"
    | "tab_select"
    | "tab_close"
    | "tab_new"
    | "select_option"
    | "select_dismiss"
  selectToken?: string
  optionIndices?: number[]
  x?: number
  y?: number
  text?: string
  key?: string
  deltaY?: number
  url?: string
  viewId?: string
}
