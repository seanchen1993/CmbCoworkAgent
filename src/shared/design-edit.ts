export interface DesignEditTextSlot {
  id: string
  value: string
  multiline: boolean
}

export interface DesignEditableNode {
  id: string
  parentId?: string
  tagName: string
  label: string
  hash: string
  variationId: string | null
  text: DesignEditTextSlot[]
  canDelete: boolean
  canStyle: boolean
  reason?: string
  source: "html" | "jsx" | "vue" | "binding"
}

export interface DesignEditableDocument {
  revision: number
  tweakRevision?: number
  nodes: DesignEditableNode[]
}

export type DesignEditOperation =
  | { type: "set_text"; nodeId: string; expectedHash: string; textSlotId: string; value: string }
  | { type: "delete_node"; nodeId: string; expectedHash: string }
  | {
      type: "set_style"
      nodeId: string
      expectedHash: string
      declarations: Record<string, string>
    }

export interface DesignEditCommand {
  protocol: "design-edit/1"
  commandId: string
  baseRevision: number
  baseTweakRevision?: number
  variationId: string | null
  operations: DesignEditOperation[]
}

/** Equivalent IPC commands have the same receipt regardless of object property order. */
export function serializeDesignEditCommand(command: DesignEditCommand): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, ordered(v)])
          )
        : value
  return JSON.stringify(ordered(command))
}

export function parseDesignEditCommand(value: unknown): DesignEditCommand {
  const c = value as DesignEditCommand
  if (
    !c ||
    c.protocol !== "design-edit/1" ||
    !/^[\w-]{8,100}$/.test(c.commandId) ||
    !Number.isSafeInteger(c.baseRevision) ||
    c.baseRevision < 0 ||
    (c.baseTweakRevision !== undefined &&
      (!Number.isSafeInteger(c.baseTweakRevision) || c.baseTweakRevision < 0)) ||
    (c.variationId !== null &&
      (typeof c.variationId !== "string" || !/^[\w-]{1,40}$/.test(c.variationId))) ||
    !Array.isArray(c.operations) ||
    !c.operations.length ||
    c.operations.length > 25 ||
    JSON.stringify(c).length > 100_000
  )
    throw new Error("直接编辑命令无效")
  for (const op of c.operations) {
    if (
      !op ||
      typeof op.nodeId !== "string" ||
      op.nodeId.length > 160 ||
      typeof op.expectedHash !== "string" ||
      op.expectedHash.length > 100
    )
      throw new Error("编辑目标无效")
    if (
      op.type === "set_text" &&
      typeof op.textSlotId === "string" &&
      typeof op.value === "string" &&
      op.value.length <= 8000
    )
      continue
    if (op.type === "delete_node") continue
    if (
      op.type === "set_style" &&
      op.declarations &&
      typeof op.declarations === "object" &&
      !Array.isArray(op.declarations) &&
      Object.keys(op.declarations).length > 0 &&
      Object.keys(op.declarations).length <= 40 &&
      Object.entries(op.declarations).every(
        ([k, v]) => /^-?[a-z][a-z-]{0,79}$/.test(k) && typeof v === "string" && v.length <= 1000
      )
    )
      continue
    throw new Error("不支持的直接编辑操作")
  }
  return c
}
