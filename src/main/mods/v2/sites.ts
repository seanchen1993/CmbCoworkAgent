import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  functionQuestionPresentation,
  functionSiteDefault,
  functionSiteProps,
  functionUiSite,
  FUNCTION_DURATION_SITE_LIMIT,
  validateFunctionSiteTree,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import type {
  FunctionFocusResult,
  FunctionPaneSnapshot,
  FunctionUiAction
} from "../../../shared/mods/v2/ui"
import { FunctionPanes, type PaneHost } from "./panes"

interface Site {
  owner: string
  component: FunctionUiSite
  props?: ModObject
  fingerprint?: string
  nativeExpansion?: boolean
  nativeQuestions?: FunctionPaneSnapshot["nativeQuestions"]
  drawings: FunctionPanes
}

/** Every host-owned slot has a bounded intent ledger and callback generation lifetime. */
export class FunctionUiSites {
  private readonly slots = new Map<string, Site>()
  private serial: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: PaneHost) {}

  private drawings(): FunctionPanes {
    return new FunctionPanes({
      ...this.host,
      // Host-driven mount/prop updates already have an awaiting renderer. Broadcasting them
      // back invalidates every in-flight owner and turns a transcript mount into a redraw storm.
      changed: () => {},
      clients: undefined,
      site: (pane) => {
        const site = this.get(pane.id)
        site.nativeExpansion = undefined
        site.nativeQuestions = undefined
        return { component: site.component, props: site.props! }
      },
      renderCore: async (input) => {
        const site = this.get(input.requestId as string)
        const props = input.props as ModObject
        if (site.component === "ToolGroup")
          site.nativeExpansion = functionSiteProps(site.component, props).isExpanded as boolean
        if (site.component === "AskUserQuestion")
          site.nativeQuestions = functionSiteProps(site.component, props)
            .questions as FunctionPaneSnapshot["nativeQuestions"]
        return functionSiteDefault(site.component, props) as unknown as ModJson
      },
      validateTree: validateFunctionSiteTree
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => {
      this.host.assertLive()
      return fn()
    })
    this.serial = result.catch(() => {})
    return result
  }

  private get(owner: string): Site {
    this.host.assertLive()
    const site = this.slots.get(owner)
    if (!site) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    return site
  }

  mount(component: FunctionUiSite): Promise<string> {
    return this.enqueue(async () => {
      functionUiSite(component)
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
          FUNCTION_DURATION_SITE_LIMIT
        )
          throw new ModFunctionError("MODS_UI_SITE_LIMIT")
      } else {
        const previous = [...this.slots.values()].find((entry) => entry.component === component)
        if (previous) await this.unmount(previous.owner)
      }
      const owner = randomUUID()
      this.slots.set(owner, { component, owner, drawings: this.drawings() })
      return owner
    })
  }

  render(owner: string, props: ModObject): Promise<FunctionPaneSnapshot> {
    return this.enqueue(async () => {
      const site = this.get(owner)
      const value = functionSiteProps(site.component, props)
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
      // Recompute after plugin publication: a guest cannot assert native ownership via metadata.
      const nativeFallback =
        encodeModJson(snapshot.tree as unknown as ModJson) ===
        encodeModJson(functionSiteDefault(site.component, value) as unknown as ModJson)
      let nativeQuestions: FunctionPaneSnapshot["nativeQuestions"]
      if (nativeFallback && site.nativeQuestions) {
        const published = await this.host.publish({ questions: site.nativeQuestions })
        if (this.get(owner) !== site) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
        nativeQuestions = functionQuestionPresentation(
          value.questions,
          isModObject(published) ? published.questions : undefined
        )
      }
      return {
        ...snapshot,
        nativeFallback,
        nativeExpansion: nativeFallback ? site.nativeExpansion : undefined,
        nativeQuestions
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
    const result = await site.drawings.act(action)
    if (this.slots.get(owner) === site) this.host.changed()
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

  invalidate(): void {
    // The session invalidates its Pane registry in the same SDK call, emitting one shared notice.
    for (const site of this.slots.values()) site.drawings.invalidate()
  }
  close(): void {
    for (const site of this.slots.values()) site.drawings.close()
    this.slots.clear()
  }
}
