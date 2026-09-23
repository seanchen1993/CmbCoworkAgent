import { isModObject, ModFunctionError } from "./contracts"

export interface FunctionScrollArgs {
  to: "start" | "end" | { key: string } | { requestId: string }
  in?: string
  block?: "start" | "center" | "end" | "nearest"
}
export interface FunctionScrollGeometry {
  height: number
  content: number
  top: number
  width: number
  row: number
  target?: { top: number; height: number }
}

const name = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256

export function functionScrollInput(value: unknown): FunctionScrollArgs {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["to", "in", "block"].includes(key)) ||
    (value.in !== undefined && !name(value.in)) ||
    (value.block !== undefined &&
      (typeof value.block !== "string" ||
        !["start", "center", "end", "nearest"].includes(value.block)))
  )
    throw new ModFunctionError("MODS_UI_SCROLL_ARGUMENTS")
  const target = value.to
  if (target === "start" || target === "end") {
    if (!name(value.in)) throw new ModFunctionError("MODS_UI_SCROLL_ARGUMENTS")
  } else if (
    !isModObject(target) ||
    Object.keys(target).length !== 1 ||
    !(name(target.key) || name(target.requestId))
  )
    throw new ModFunctionError("MODS_UI_SCROLL_ARGUMENTS")
  return value as unknown as FunctionScrollArgs
}

/** Pixel measurements from the renderer, never guessed terminal-cell geometry. */
export function functionScrollGeometry(value: unknown): FunctionScrollGeometry {
  const size = (item: unknown): item is number =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 10000000
  if (
    !isModObject(value) ||
    Object.keys(value).some(
      (key) => !["height", "content", "top", "width", "row", "target"].includes(key)
    ) ||
    ![value.height, value.content, value.top, value.width, value.row].every(size) ||
    Number(value.height) <= 0 ||
    Number(value.width) <= 0 ||
    Number(value.row) <= 0 ||
    Number(value.row) > 1024 ||
    Number(value.top) > Math.max(0, Number(value.content) - Number(value.height)) + 1
  )
    throw new ModFunctionError("MODS_UI_SCROLL_GEOMETRY")
  if (
    value.target !== undefined &&
    (!isModObject(value.target) ||
      Object.keys(value.target).some((key) => !["top", "height"].includes(key)) ||
      !size(value.target.top) ||
      !size(value.target.height))
  )
    throw new ModFunctionError("MODS_UI_SCROLL_GEOMETRY")
  return value as unknown as FunctionScrollGeometry
}

export function functionScrollPosition(
  args: FunctionScrollArgs,
  measurement: FunctionScrollGeometry
): {
  offset: number
  by: number
  bodyRows: number
  contentRows: number
} {
  const geometry = functionScrollGeometry(measurement)
  const max = Math.max(0, geometry.content - geometry.height)
  let top: number
  if (args.to === "start") top = 0
  else if (args.to === "end") top = max
  else {
    const target = geometry.target
    if (!target) throw new ModFunctionError("MODS_UI_SCROLL_TARGET")
    const block = args.block ?? "nearest"
    if (target.height > geometry.height || block === "start") top = target.top
    else if (block === "center") top = target.top + (target.height - geometry.height) / 2
    else if (block === "end") top = target.top + target.height - geometry.height
    else if (target.top < geometry.top) top = target.top
    else if (target.top + target.height > geometry.top + geometry.height)
      top = target.top + target.height - geometry.height
    else top = geometry.top
  }
  top = Math.max(0, Math.min(max, top))
  return {
    offset: top / geometry.row,
    by: (top - geometry.top) / geometry.row,
    bodyRows: geometry.height / geometry.row,
    contentRows: geometry.content / geometry.row
  }
}

export interface FunctionScrollAddress {
  pane: string
  generation: string
  plugin: string
  requestId: string
}
export interface FunctionScrollRequest extends FunctionScrollAddress {
  id: string
  phase: "probe" | "apply"
  args: FunctionScrollArgs
  geometry?: FunctionScrollGeometry
  offset?: number
}
export interface FunctionScrollAck {
  pane: string
  generation: string
  id: string
  phase: "probe" | "apply"
  allowed: boolean
  geometry?: FunctionScrollGeometry
}
export interface FunctionScrollOutcome {
  deny?: string
}
