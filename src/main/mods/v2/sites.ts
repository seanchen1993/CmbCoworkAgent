import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionLogicalEngine } from "../../../shared/mods/v2/engine"
import {
  functionQuestionPresentation,
  functionSiteProps,
  functionUiSite,
  FUNCTION_DURATION_SITE_LIMIT,
  FUNCTION_COMMAND_OUTPUT_SITE_LIMIT,
  validateFunctionSiteTree,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import type {
  FunctionFocusResult,
  FunctionPaneSnapshot,
  FunctionUiAction
} from "../../../shared/mods/v2/ui"
import { FunctionPanes, type PaneHost } from "./panes"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import type { UserInputRequest } from "../../types"

interface Site {
  owner: string
  component: FunctionUiSite
  messageId?: string
  props?: ModObject
  fingerprint?: string
  nativeRequest?: Readonly<UserInputRequest>
  drawings: FunctionPanes
}

/** Every host-owned slot has a bounded intent ledger and callback generation lifetime. */
export class FunctionUiSites {
  private readonly slots = new Map<string, Site>()
  private readonly queues = new Map<string, Promise<void>>()
  private pending = 0
  private closed = false

  constructor(private readonly host: PaneHost & {
    userMessageOrigin?(messageId: string): FunctionPluginPromptOrigin | undefined
    pendingQuestion?(): Readonly<UserInputRequest> | null
  }) {}

  private drawings(owner: string, component: FunctionUiSite): FunctionPanes {
    return new FunctionPanes({
      ...this.host,
      // Host-driven mount/prop updates already have an awaiting renderer. Broadcasting them
      // back invalidates every in-flight owner and turns a transcript mount into a redraw storm.
      changed: (scope) => {
        if (scope === "panes" && this.slots.has(owner)) this.host.changed(`site:${owner}`)
      },
      component,
      markdownSiteOwner: owner,
      localNotificationsOnly: true,
      assertNativeCurrent: () => { this.native(owner) },
      captureNativeIntent: () => {
        const site = this.native(owner)
        return () => {
          if (this.native(owner) !== site) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
        }
      },
      assertSiteCurrent: (pane) => { this.native(pane.id) },
      site: (pane) => {
        const site = this.get(pane.id)
        return { component: site.component, props: site.props!,
          ...(site.nativeRequest ? { requestId: site.nativeRequest.requestId } : {}) }
      },
      validateTree: validateFunctionSiteTree
    })
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ModFunctionError("MODS_UI_SITE_CLOSED"))
    // Bound physical in-flight work too: an unmounted owner cannot manufacture
    // unlimited independent queues while an older host callback is still pending.
    if (this.pending >= 512) return Promise.reject(new ModFunctionError("MODS_UI_SITE_QUEUE_LIMIT"))
    this.pending++
    const result = (this.queues.get(key) ?? Promise.resolve()).then(() => {
      if (this.closed) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
      this.host.assertLive()
      return fn()
    })
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      this.pending--
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return result
  }

  private get(owner: string): Site {
    this.host.assertLive()
    return this.native(owner)
  }

  /** No Session recursion: this private native fact also guards SDK drawing receipts. */
  private native(owner: string): Site {
    if (this.closed) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    const site = this.slots.get(owner)
    if (!site) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    if (site.component === "AskUserQuestion" &&
      (!site.nativeRequest || this.host.pendingQuestion?.() !== site.nativeRequest))
      throw new ModFunctionError("MODS_UI_QUESTION_STALE")
    return site
  }

  async mount(component: FunctionUiSite, messageId?: string, expectedRequestId?: string): Promise<string> {
    functionUiSite(component)
    return this.enqueue(`mount:${component}`, async () => {
      functionUiSite(component)
      const nativeRequest = component === "AskUserQuestion" ? this.host.pendingQuestion?.() : undefined
      if (component === "AskUserQuestion" && (!nativeRequest ||
        typeof expectedRequestId !== "string" || nativeRequest.requestId !== expectedRequestId))
        throw new ModFunctionError("MODS_UI_QUESTION_STALE")
      if (component !== "AskUserQuestion" && expectedRequestId !== undefined)
        throw new ModFunctionError("MODS_UI_SITE_PROPS")
      if (messageId !== undefined && (component !== "UserMessage" ||
        typeof messageId !== "string" || !messageId || messageId.length > 512))
        throw new ModFunctionError("MODS_UI_SITE_PROPS")
      if (
        [
          "TurnDuration",
          "UserMessage",
          "AssistantMessage",
          "CommandOutput",
          "ToolUse",
          "ToolResult",
          "ToolGroup"
        ].includes(component)
      ) {
        if (
          [...this.slots.values()].filter((entry) => entry.component === component).length >=
          (component === "CommandOutput"
            ? FUNCTION_COMMAND_OUTPUT_SITE_LIMIT
            : FUNCTION_DURATION_SITE_LIMIT)
        )
          throw new ModFunctionError("MODS_UI_SITE_LIMIT")
      } else {
        const previous = [...this.slots.values()].find((entry) => entry.component === component)
        if (previous) await this.unmount(previous.owner)
        this.host.assertLive()
        if (this.closed) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
        if (nativeRequest && this.host.pendingQuestion?.() !== nativeRequest)
          throw new ModFunctionError("MODS_UI_QUESTION_STALE")
      }
      const owner = randomUUID()
      this.slots.set(owner, { component, messageId, owner, nativeRequest: nativeRequest ?? undefined,
        drawings: this.drawings(owner, component) })
      return owner
    })
  }

  render(owner: string, props: ModObject): Promise<FunctionPaneSnapshot> {
    return this.enqueue(`owner:${owner}`, async () => {
      // enqueue has just checked the full lifecycle at execution, without an intervening await.
      const site = this.native(owner)
      // Only the mounted, immutable message ID can select a main-process durable source.
      if (site.nativeRequest)
        functionQuestionPresentation(site.nativeRequest.questions, props.questions)
      const value = functionSiteProps(site.component, site.nativeRequest
        ? { ...props, questions: site.nativeRequest.questions }
        : site.component === "UserMessage"
        ? { ...props, origin: site.messageId && this.host.userMessageOrigin?.(site.messageId)
          || { kind: "unclassified" } } : props)
      const fingerprint = encodeModJson(value)
      if (fingerprint !== site.fingerprint) {
        site.props = value
        site.fingerprint = fingerprint
        site.drawings.open("engine", { id: owner, title: site.component })
      }
      const snapshots = await site.drawings.snapshot()
      this.get(owner)
      const snapshot = snapshots.find((pane) => pane.id === owner)
      if (!snapshot) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
      const nativeEngine = functionLogicalEngine(snapshot.tree)
      const nativeFallback = nativeEngine !== undefined &&
        snapshot.nativeContent?.nativeUnchanged === true
      const nativeRef = nativeEngine?.ref
      const native = nativeEngine ?
        snapshot.nativeContent?.entries.find((entry) => entry.ref === nativeRef) ??
          snapshot.nativeContent?.entries.find((entry) => entry.ref === 0) : undefined
      return {
        ...snapshot,
        nativeFallback,
        nativeExpansion: site.component === "ToolGroup" ? native?.props.isExpanded as boolean : undefined,
        nativeQuestions: site.component === "AskUserQuestion" ?
          native?.props.questions as FunctionPaneSnapshot["nativeQuestions"] : undefined
      }
    })
  }

  async act(owner: string, action: FunctionUiAction): Promise<void | FunctionFocusResult> {
    const site = this.get(owner)
    if (
      action.pane !== `engine:${owner}` ||
      action.kind === "close" ||
      ((action.kind === "focus" || action.kind === "scroll") && site.component !== "AbovePrompt")
    )
      throw new ModFunctionError("MODS_UI_ACTION_INVALID")
    const guard = () => {
      if (this.native(owner) !== site) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    }
    guard()
    const run = () => site.drawings.act(action)
    const result = await (this.host.withNativeIntent ? this.host.withNativeIntent(guard, run) : run())
    guard()
    if (this.slots.get(owner) === site) site.drawings.notify()
    return result
  }

  async unmount(owner: string): Promise<void> {
    const site = this.slots.get(owner)
    if (!site) return
    this.slots.delete(owner)
    try {
      await site.drawings.closePane("engine", owner)
    } finally {
      site.drawings.close()
    }
  }

  /** Private cleanup for an allocated owner that was never delivered; no Hook or SDK runs. */
  retire(owner: string): void {
    const site = this.slots.get(owner)
    if (!site) return
    this.slots.delete(owner)
    site.drawings.close()
  }

  invalidate(components?: ReadonlySet<string>, sdkRedraw = false): void {
    // Virtualized messages may have no mounted owner. Revoke their read-only cached
    // presentation as well, before any pending renderer read can publish it again.
    if (!components) this.host.changed("site-presentations:*")
    else for (const component of components)
      if (["UserMessage", "AssistantMessage", "CommandOutput"].includes(component))
        this.host.changed(`site-presentations:${component}`)
    // SDK redraw retains no action authority, but is distinct from source/permission revocation.
    // Notify every affected owner, including global dependency sets, without clearing unrelated UI.
    for (const site of this.slots.values()) {
      if (components && !components.has(site.component)) continue
      site.drawings.invalidate(undefined, true)
      if (components || sdkRedraw) this.host.changed(sdkRedraw
        ? `site-redraw:${site.owner}` : `site-invalidated:${site.owner}`)
    }
  }

  /** Route through the real registry; a string prefix alone grants no drawing authority. */
  private drawing(key: string): FunctionPanes | undefined {
    for (const site of this.slots.values())
      if (key === `engine:${site.owner}`) return site.drawings
    return undefined
  }

  notifyClient(key: string): boolean {
    const drawing = this.drawing(key)
    if (!drawing) return false
    drawing.notify()
    return true
  }

  captureClientDrawing(key: string, generation: string) {
    return this.drawing(key)?.captureClientDrawing(key, generation)
  }

  captureClientFault(key: string, generation: string) {
    return this.drawing(key)?.captureClientFault(key, generation)
  }

  invalidateGeneration(generation: string): boolean {
    let changed = false
    for (const site of this.slots.values())
      changed = site.drawings.invalidateGeneration(generation) || changed
    return changed
  }
  close(): void {
    this.closed = true
    for (const site of this.slots.values()) site.drawings.close()
    this.slots.clear()
  }
}
