import type { ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export const FUNCTION_NONMEDIA_METHODS = [
  "session.identity",
  "telemetry.log",
  "telemetry.mark",
  "telemetry.records",
  "ui.notify",
  "ui.blit"
] as const

const token = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(value)
function fail(): never {
  throw new ModFunctionError("MODS_NONMEDIA_ARGUMENTS")
}

export function validateFunctionNonmediaInput(method: string, value: ModObject): void {
  if (method === "session.identity") {
    if (Object.keys(value).length) fail()
    return
  }
  if (method === "env.set") {
    if (
      typeof value.name !== "string" ||
      (value.value !== undefined && typeof value.value !== "string") ||
      Object.keys(value).some((k) => !["name", "value"].includes(k))
    )
      fail()
    return
  }
  if (method === "ui.notify") {
    if (
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 2000 ||
      (value.title !== undefined &&
        (typeof value.title !== "string" || value.title.length > 128)) ||
      (value.surface !== undefined && value.surface !== "desktop") ||
      Object.keys(value).some((k) => !["text", "title", "surface"].includes(k))
    )
      fail()
    return
  }
  if (method === "ui.blit") {
    // The desktop has no mounted terminal Raster or Image. Still reject malformed arguments.
    if (
      typeof value.requestId !== "string" ||
      !value.requestId ||
      value.requestId.length > 256 ||
      typeof value.key !== "string" ||
      !value.key ||
      value.key.length > 256 ||
      typeof value.cells !== "string" ||
      value.cells.length > 1_048_576 ||
      ["columns", "rows"].some(
        (k) =>
          value[k] !== undefined &&
          (typeof value[k] !== "number" ||
            !Number.isInteger(value[k]) ||
            Number(value[k]) < 1 ||
            Number(value[k]) > (k === "columns" ? 512 : 256))
      ) ||
      Object.keys(value).some((k) => !["requestId", "key", "cells", "columns", "rows"].includes(k))
    )
      fail()
    return
  }
  if (method !== "telemetry.log" && method !== "telemetry.mark") return
  if (JSON.stringify(value).length > 16384) fail()
  const props = value.props
  if (props !== undefined && (!isModObject(props) || Object.keys(props).length > 32)) fail()
  for (const [key, p] of Object.entries(props ?? {})) {
    if (!token(key)) fail()
    if (typeof p === "boolean" || (typeof p === "number" && Number.isFinite(p))) continue
    if (
      !isModObject(p) ||
      Object.keys(p).some((k) => !["value", "of"].includes(k)) ||
      !Array.isArray(p.of) ||
      p.of.length < 1 ||
      p.of.length > 32 ||
      !p.of.every(token) ||
      !p.of.includes(p.value)
    )
      fail()
  }
  if (method === "telemetry.mark") {
    if (
      !token(value.feature) ||
      !["ok", "sad", "bad"].includes(String(value.kind)) ||
      (value.reason !== undefined && !token(value.reason)) ||
      Object.keys(value).some((k) => !["feature", "kind", "reason", "props"].includes(k))
    )
      fail()
  } else if (value.to === "anthropic") {
    if (
      !token(value.event) ||
      Object.keys(value).some((k) => !["to", "event", "props"].includes(k))
    )
      fail()
  } else if (value.to === "collector") {
    if (
      !token(value.event) ||
      !isModObject(value.attributes) ||
      Object.keys(value.attributes).length > 32 ||
      typeof value.loggedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.loggedAt) ||
      !Number.isFinite(Date.parse(value.loggedAt)) ||
      Object.keys(value).some((k) => !["to", "event", "attributes", "loggedAt", "span"].includes(k))
    )
      fail()
    for (const [k, p] of Object.entries(value.attributes))
      if (
        !token(k) ||
        !(
          (typeof p === "string" && p.length <= 1024) ||
          typeof p === "boolean" ||
          (typeof p === "number" && Number.isFinite(p)) ||
          (Array.isArray(p) &&
            p.length <= 32 &&
            p.every((v) => typeof v === "string" && v.length <= 1024))
        )
      )
        fail()
    if (
      value.span !== undefined &&
      (!isModObject(value.span) ||
        typeof value.span.traceId !== "string" ||
        !/^[0-9a-f]{32}$/.test(value.span.traceId) ||
        typeof value.span.spanId !== "string" ||
        !/^[0-9a-f]{16}$/.test(value.span.spanId) ||
        !Number.isInteger(value.span.traceFlags) ||
        Number(value.span.traceFlags) < 0 ||
        Number(value.span.traceFlags) > 255 ||
        Object.keys(value.span).some((k) => !["traceId", "spanId", "traceFlags"].includes(k)))
    )
      fail()
  } else fail()
}

export function functionNonmediaInput(method: string, args: unknown[]): ModObject {
  let value: ModObject
  if (method === "session.identity" || method === "telemetry.records") {
    if (args.length) fail()
    value = {}
  } else if (method === "ui.notify") {
    if (args.length < 1 || args.length > 2 || (args[1] !== undefined && !isModObject(args[1])))
      fail()
    if (isModObject(args[1]) && Object.hasOwn(args[1], "text")) fail()
    value = { ...(args[1] as ModObject | undefined), text: args[0] as string }
  } else if (method === "ui.blit") {
    if (args.length !== 1 || !isModObject(args[0])) fail()
    value = { ...args[0] }
  } else {
    if (args.length !== 1 || !isModObject(args[0])) fail()
    value = { ...args[0] }
    if (method === "telemetry.log") value.to ??= "anthropic"
  }
  validateFunctionNonmediaInput(method, value)
  return value
}

export function validateFunctionNonmediaResult(method: string, result: unknown): void {
  if (!["telemetry.log", "telemetry.mark", "ui.notify", "env.set"].includes(method)) return
  if (
    !isModObject(result) ||
    Object.keys(result).some((k) => !["value", "deny"].includes(k)) ||
    (result.deny !== undefined && typeof result.deny !== "string")
  )
    fail()
  if (typeof result.deny === "string") return
  if (method.startsWith("telemetry.")) {
    if (result.value !== undefined) fail()
    return
  }
  if (!isModObject(result.value)) fail()
  const value = result.value
  if (method === "env.set") {
    if (
      Object.keys(value).some((k) => k !== "deny") ||
      (value.deny !== undefined && typeof value.deny !== "string")
    )
      fail()
    return
  }
  if (value.isSent === true) {
    if (
      value.channel !== "desktop" ||
      Object.keys(value).some((k) => !["isSent", "channel"].includes(k))
    )
      fail()
  } else if (value.isSent === false) {
    if (
      ![
        "disabled",
        "no-channel",
        "no-surface",
        "refused",
        "rate-limit",
        "failed",
        "timeout"
      ].includes(String(value.reason)) ||
      Object.keys(value).some((k) => !["isSent", "reason"].includes(k))
    )
      fail()
  } else fail()
}
