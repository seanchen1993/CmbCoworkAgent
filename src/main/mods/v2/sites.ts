import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
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
      clients: undefined,
      site: (pane) => {
        const site = this.get(pane.id)
        return { component: site.component, props: site.props! }
      },
      renderCore: async (input) =>
        functionSiteDefault(
          functionUiSite(input.component),
          input.props as ModObject
        ) as unknown as ModJson,
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
      if (["TurnDuration", "UserMessage", "AssistantMessage"].includes(component)) {
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
      return {
        ...snapshot,
        nativeFallback:
          encodeModJson(snapshot.tree as unknown as ModJson) ===
          encodeModJson(functionSiteDefault(site.component, value) as unknown as ModJson)
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
    return site.drawings.act(action)
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
    for (const site of this.slots.values()) site.drawings.invalidate()
  }
  close(): void {
    for (const site of this.slots.values()) site.drawings.close()
    this.slots.clear()
  }
}
