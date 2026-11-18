import type { WebContents } from "electron"
import { randomUUID } from "node:crypto"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../shared/mods/v2/resource-budgets"

type SiteReadSender = Pick<WebContents, "mainFrame" | "on" | "removeListener" | "isDestroyed">
export interface FunctionSiteDocumentOwner {
  owner: string
  workspace: string
  threadId: string
  current(): boolean
  retire(): void
}

interface Owner {
  sender: SiteReadSender
  frame: object
  namespace: string
  sequence: number
  capacity: { physical: number }
  requests: Map<string, AbortController>
  sites: Map<string, FunctionSiteDocumentOwner>
  retire(): void
}

const MAX_PHYSICAL_READS = FUNCTION_MOD_RESOURCE_BUDGETS.mainDisplay.physical
const MAX_FRAME_READS = FUNCTION_MOD_RESOURCE_BUDGETS.mainDisplay.perNativeFrame
const REQUEST_ID = /^([a-f0-9-]{36}):([1-9][0-9]{0,15})$/

/** Cancellation names work in one current native frame; it never grants display authority. */
export class FunctionSiteReadRequests {
  private readonly owners = new WeakMap<object, Owner>()
  private readonly frameCapacities = new WeakMap<object, WeakMap<object, { physical: number }>>()
  private physical = 0

  private owner(sender: SiteReadSender): Owner {
    const previous = this.owners.get(sender)
    if (previous && previous.frame === sender.mainFrame) {
      return previous
    }
    previous?.retire()
    let frames = this.frameCapacities.get(sender)
    if (!frames) this.frameCapacities.set(sender, (frames = new WeakMap()))
    let capacity = frames.get(sender.mainFrame)
    if (!capacity) frames.set(sender.mainFrame, (capacity = { physical: 0 }))
    let replacingDocument = false
    const owner: Owner = {
      sender,
      frame: sender.mainFrame,
      namespace: randomUUID(),
      sequence: 0,
      capacity,
      requests: new Map(),
      sites: new Map(),
      retire: () => {
        if (this.owners.get(sender) === owner) this.owners.delete(sender)
        sender.removeListener("did-start-navigation", navigate)
        sender.removeListener("did-frame-navigate", committed)
        sender.removeListener("render-process-gone", owner.retire)
        sender.removeListener("destroyed", owner.retire)
        for (const controller of owner.requests.values())
          controller.abort(Error("MODS_DISPLAY_READ_CANCELLED"))
        for (const site of owner.sites.values()) site.retire()
        owner.sites.clear()
      }
    }
    const navigate = (...args: unknown[]) => {
      const details = args[0]
      if (
        args[3] === false ||
        (details &&
          typeof details === "object" &&
          "isMainFrame" in details &&
          details.isMainFrame === false)
      )
        return
      const sameDocument = args[2] === true || (details &&
        typeof details === "object" && "isSameDocument" in details && details.isSameDocument === true)
      if (!sameDocument) replacingDocument = true
      // A navigation may fail. Cancel pending reads while retaining the completed
      // sites until a replacement really commits or a new preload handshakes.
      for (const controller of owner.requests.values())
        controller.abort(Error("MODS_DISPLAY_READ_CANCELLED"))
    }
    const committed = (_event: unknown, _url: string, _response: number, _status: string,
      isMainFrame: boolean) => {
      // A fresh preload may already have won before Electron announces the commit.
      if (isMainFrame && replacingDocument) owner.retire()
    }
    this.owners.set(sender, owner)
    sender.on("did-start-navigation", navigate)
    sender.on("did-frame-navigate", committed)
    sender.on("render-process-gone", owner.retire)
    sender.on("destroyed", owner.retire)
    return owner
  }

  /** Native document token: queued old renderer IDs cannot claim the next document. */
  documentNamespace(sender: SiteReadSender): string {
    if (sender.isDestroyed()) throw Error("MODS_DISPLAY_READ_CANCELLED")
    // Called once by each isolated preload, never by the renderer API. A fresh
    // handshake wins regardless of whether Electron reports commit before or after it.
    this.owners.get(sender)?.retire()
    return this.owner(sender).namespace
  }

  captureSiteRegistration(sender: SiteReadSender): (site: FunctionSiteDocumentOwner) => void {
    if (sender.isDestroyed()) throw Error("MODS_DISPLAY_READ_CANCELLED")
    const document = this.owner(sender)
    return site => {
      if (this.owners.get(sender) !== document || sender.isDestroyed() ||
        sender.mainFrame !== document.frame)
        throw Error("MODS_DISPLAY_READ_CANCELLED")
      if (!site.current()) throw Error("MODS_UI_SITE_CLOSED")
      // Owner replacements and thread/configuration shutdown can retire a site without
      // a renderer reply. Keep metadata only for slots that still belong to this document.
      for (const [id, earlier] of document.sites)
        if (!earlier.current()) document.sites.delete(id)
      document.sites.set(site.owner, site)
    }
  }

  takeSite(sender: SiteReadSender, threadId: string, owner: string): FunctionSiteDocumentOwner | undefined {
    const document = this.owners.get(sender)
    if (!document || sender.isDestroyed() || sender.mainFrame !== document.frame) return undefined
    const site = document.sites.get(owner)
    if (site?.threadId !== threadId) return undefined
    document.sites.delete(owner)
    return site
  }

  async run<T>(
    sender: SiteReadSender,
    readId: unknown,
    work: (signal?: AbortSignal) => Promise<T>,
    failed?: () => Promise<void>
  ): Promise<T> {
    // Legacy peers keep the original bounded host lifecycle and cannot cancel by ID.
    if (readId === undefined) {
      if (this.physical >= MAX_PHYSICAL_READS) throw Error("MODS_DISPLAY_READ_LIMIT")
      this.physical++
      try {
        return await work()
      } catch (error) {
        await failed?.()
        throw error
      } finally {
        this.physical--
      }
    }
    if (sender.isDestroyed()) throw Error("MODS_DISPLAY_READ_CANCELLED")
    const parsed = typeof readId === "string" && REQUEST_ID.exec(readId)
    const sequence = parsed && Number(parsed[2])
    if (!parsed || !sequence || !Number.isSafeInteger(sequence))
      throw Error("MODS_DISPLAY_READ_ID_INVALID")
    const owner = this.owner(sender)
    if (owner.namespace !== parsed[1]) throw Error("MODS_DISPLAY_READ_CANCELLED")
    // A completed request ID cannot later name a new operation (late-cancel ABA).
    if (sequence <= owner.sequence) throw Error("MODS_DISPLAY_READ_ID_REUSED")
    owner.sequence = sequence
    if (this.physical >= MAX_PHYSICAL_READS || owner.capacity.physical >= MAX_FRAME_READS)
      throw Error("MODS_DISPLAY_READ_LIMIT")
    const controller = new AbortController()
    owner.requests.set(readId as string, controller)
    this.physical++
    owner.capacity.physical++
    try {
      controller.signal.throwIfAborted()
      const result = await work(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } catch (error) {
      // A mounted owner may have been allocated before the publication envelope
      // rejects. Retire it before acknowledging this physical read as finished.
      await failed?.()
      throw error
    } finally {
      owner.requests.delete(readId as string)
      owner.capacity.physical--
      this.physical--
    }
  }

  cancel(sender: SiteReadSender, readId: unknown): void {
    if (typeof readId !== "string") return
    const owner = this.owners.get(sender)
    if (!owner || sender.isDestroyed() || owner.frame !== sender.mainFrame) return
    owner.requests.get(readId)?.abort(Error("MODS_DISPLAY_READ_CANCELLED"))
  }
}
