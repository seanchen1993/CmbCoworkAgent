type AnchorStyle = Pick<CSSStyleDeclaration,
  "getPropertyValue" | "getPropertyPriority" | "setProperty" | "removeProperty">

interface AnchorViewport {
  readonly style: AnchorStyle
}

interface AnchorDeclaration {
  value: string
  priority: string
}

interface AnchorOwner {
  before: AnchorDeclaration
  priority: string
  leases: Set<symbol>
}

const owners = new WeakMap<AnchorViewport, AnchorOwner>()
const property = "overflow-anchor"

/** Virtuoso owns resize compensation while this exact chat viewport is virtualized. */
export function claimVirtualizedChatScrollAnchor(viewport: AnchorViewport): () => void {
  const style = viewport.style
  const current = {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property)
  }
  const previous = owners.get(viewport)
  const before = previous && current.value === "none" && current.priority === previous.priority
    ? previous.before
    : current
  const owner = previous ?? { before, priority: before.priority, leases: new Set<symbol>() }
  style.setProperty(property, "none", before.priority)
  owner.before = before
  owner.priority = before.priority
  const lease = Symbol("virtualized-chat-scroll-anchor")
  owner.leases.add(lease)
  owners.set(viewport, owner)

  return () => {
    if (!owner.leases.delete(lease) || owners.get(viewport) !== owner) return
    if (owner.leases.size) return
    owners.delete(viewport)
    if (style.getPropertyValue(property) !== "none" ||
        style.getPropertyPriority(property) !== owner.priority) return
    if (owner.before.value) style.setProperty(property, owner.before.value, owner.before.priority)
    else style.removeProperty(property)
  }
}
