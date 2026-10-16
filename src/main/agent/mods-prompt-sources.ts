import { AsyncLocalStorage } from "node:async_hooks"
import { isDeepStrictEqual } from "node:util"
import type { BaseMessage } from "@langchain/core/messages"
import { createMiddleware, type WrapModelCallHook } from "langchain"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { FunctionInstructionFile } from "../../shared/mods/v2/prompt-context"
import { assertRequiredPromptTexts, RequiredPromptContextError } from "./required-prompt-context"

export type PromptContribution = {
  id: string
  text: string | null
  scope: "session"
  /** Host-resolved project knowledge that ordinary prompt transforms must retain verbatim. */
  requiredText?: string
  context?: {
    name: string
    instructionFiles?: readonly FunctionInstructionFile[]
  }
}

type PromptRequest = Parameters<WrapModelCallHook>[0]
type ObservableMiddleware = {
  name?: string
  wrapModelCall?: (...args: never[]) => unknown
}
type TextBlock = { type: "text"; text: string; [key: string]: unknown }
type ContentSnapshot = {
  content: string | TextBlock[]
  text: string
}
type Lifetime = { active: boolean; parent?: Lifetime }
type PromptFrame = Readonly<{
  authority: ModRuntimeAuthority
  lifetime: Lifetime
  snapshot: ContentSnapshot | undefined
  contributions: readonly PromptContribution[] | undefined
  requiredTexts: readonly string[]
}>

const frames = new AsyncLocalStorage<PromptFrame | undefined>()
const contextOccurrences = new WeakMap<object, object>()

/** Preserve only a genuine native source through trusted immutable frame copies. */
export function promptContextOccurrence(context: NonNullable<PromptContribution["context"]>): object {
  return contextOccurrences.get(context) ?? context
}

function active(lifetime: Lifetime): boolean {
  for (let current: Lifetime | undefined = lifetime; current; current = current.parent)
    if (!current.active) return false
  return true
}

function runFrame<T>(frame: PromptFrame, run: () => T): T {
  const close = () => {
    frame.lifetime.active = false
  }
  let result: T
  try {
    result = frames.run(frame, run)
  } catch (error) {
    close()
    throw error
  }
  if (result && typeof (result as { then?: unknown }).then === "function")
    return Promise.resolve(result).finally(close) as T
  close()
  return result
}

function snapshot(content: unknown): ContentSnapshot | undefined {
  if (typeof content === "string") return { content, text: content }
  if (!Array.isArray(content)) return undefined
  if (
    !content.every(
      (part) =>
        part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
    )
  )
    return undefined
  try {
    const blocks = structuredClone(content) as TextBlock[]
    return { content: blocks, text: blocks.map((part) => part.text).join("") }
  } catch {
    return undefined
  }
}

function live(authority: ModRuntimeAuthority): boolean {
  try {
    authority.assertLive()
    return true
  } catch {
    return false
  }
}

function copyContributions(
  value: readonly PromptContribution[] | undefined
): readonly PromptContribution[] | undefined {
  if (!value) return undefined
  const ids = new Set<string>()
  const result: PromptContribution[] = []
  for (const part of value) {
    if (
      !part ||
      typeof part.id !== "string" ||
      !part.id.trim() ||
      ids.has(part.id) ||
      (part.text !== null && typeof part.text !== "string") ||
      part.scope !== "session"
    )
      return undefined
    ids.add(part.id)
    const context = part.context && Object.freeze({
      name: part.context.name,
      ...(part.context.instructionFiles === undefined ? {} : {
        instructionFiles: Object.freeze(part.context.instructionFiles.map(file =>
          Object.freeze({ ...file })))
      })
    })
    if (context && part.context)
      contextOccurrences.set(context, promptContextOccurrence(part.context))
    result.push(Object.freeze({ id: part.id, text: part.text, scope: "session",
      ...(part.requiredText === undefined ? {} : { requiredText: part.requiredText }),
      ...(context ? { context } : {}) }))
  }
  return Object.freeze(result)
}

function reconstruct(parts: readonly PromptContribution[]): string {
  return parts.map((part) => part.text ?? "").join("")
}

function appended(before: ContentSnapshot, after: ContentSnapshot): string | undefined {
  if (typeof before.content === "string") {
    if (typeof after.content === "string")
      return after.content.startsWith(before.content)
        ? after.content.slice(before.content.length)
        : undefined
    // Pinned native memory converts the exact original string into its first text block.
    if (!isDeepStrictEqual(after.content[0], { type: "text", text: before.content }))
      return undefined
    return after.content
      .slice(1)
      .map((part) => part.text)
      .join("")
  }
  if (
    typeof after.content === "string" ||
    !isDeepStrictEqual(after.content.slice(0, before.content.length), before.content)
  )
    return undefined
  return after.content
    .slice(before.content.length)
    .map((part) => part.text)
    .join("")
}

function forkFrame(
  frame: PromptFrame,
  before: ContentSnapshot | undefined,
  after: ContentSnapshot | undefined,
  id: string | undefined
): PromptFrame {
  let contributions: readonly PromptContribution[] | undefined
  if (
    active(frame.lifetime) &&
    live(frame.authority) &&
    before &&
    after &&
    frame.snapshot &&
    frame.contributions &&
    isDeepStrictEqual(before.content, frame.snapshot.content) &&
    reconstruct(frame.contributions) === before.text
  ) {
    if (isDeepStrictEqual(before.content, after.content)) {
      contributions = copyContributions(frame.contributions)
    } else if (id?.trim()) {
      const text = appended(before, after)
      const existing = frame.contributions.find((part) => part.id === id)
      if (text !== undefined && (!existing || existing.text === null)) {
        contributions = copyContributions([
          ...frame.contributions.filter((part) => part.id !== id),
          { id, text, scope: "session" }
        ])
      }
    }
  }
  if (contributions && reconstruct(contributions) !== after?.text) contributions = undefined
  return Object.freeze({
    ...frame,
    lifetime: { active: true, parent: frame.lifetime },
    snapshot: after,
    contributions
  })
}

/** Host-only provenance. A nested entry with no owner must not borrow its caller's frame. */
export function createPromptSourceMiddleware(options: {
  name?: string
  authority: () => ModRuntimeAuthority | undefined
  seed: (request: PromptRequest) => readonly PromptContribution[] | undefined
}): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: options.name ?? "modsPromptSources",
    wrapModelCall: async (request, handler) => {
      const authority = options.authority()
      if (!authority || !live(authority)) return frames.run(undefined, () => handler(request))
      const content = snapshot(request.systemMessage?.content)
      const rawSeed = options.seed(request)
      const requiredTexts = Object.freeze((rawSeed ?? []).flatMap(part => {
        if (part?.requiredText === undefined) return []
        if (typeof part.requiredText !== "string" || !part.requiredText ||
          typeof part.text !== "string" || !part.text.includes(part.requiredText))
          throw new RequiredPromptContextError()
        return [part.requiredText]
      }))
      const seed = copyContributions(rawSeed)
      const lifetime = { active: true }
      const frame: PromptFrame = Object.freeze({
        authority,
        lifetime,
        snapshot: content,
        requiredTexts,
        contributions: content && seed && reconstruct(seed) === content.text ? seed : undefined
      })
      try {
        return await frames.run(frame, () => handler(request))
      } finally {
        lifetime.active = false
      }
    }
  })
}

/** Each downstream invocation gets its own immutable branch, including retries and fan-out. */
export function observePromptSourceMiddleware<T extends ObservableMiddleware>(
  middleware: T,
  id?: string
): T {
  if (!middleware.wrapModelCall) return middleware
  const original = middleware.wrapModelCall as WrapModelCallHook
  const observed: WrapModelCallHook = (request, handler) => {
    const frame = frames.getStore()
    const before = snapshot(request.systemMessage?.content)
    return original.call(middleware, request, (next) => {
      const after = snapshot(next.systemMessage?.content)
      const branch = frame ? forkFrame(frame, before, after, id) : undefined
      return branch
        ? runFrame(branch, () => handler(next))
        : frames.run(undefined, () => handler(next))
    })
  }
  return { ...middleware, wrapModelCall: observed }
}

/** Requirements survive opaque native rewrites even when the section provenance cannot. */
export function assertRequiredPromptContext(
  messages: readonly BaseMessage[],
  authority: ModRuntimeAuthority
): void {
  const frame = frames.getStore()
  if (!frame || frame.authority !== authority || !active(frame.lifetime)) return
  authority.assertLive()
  assertRequiredPromptTexts(messages, frame.requiredTexts)
}

/** Undefined keeps the final adapter's whole-message opaque path, never a guessed split. */
export function promptContributionsFor(
  messages: BaseMessage[],
  authority: ModRuntimeAuthority
): readonly PromptContribution[] | undefined {
  const frame = frames.getStore()
  if (
    !frame ||
    frame.authority !== authority ||
    !active(frame.lifetime) ||
    !live(authority) ||
    !frame.snapshot ||
    !frame.contributions
  )
    return undefined
  const system = messages.filter((message) => message.type === "system")
  if (system.length !== 1) return undefined
  const actual = snapshot(system[0].content)
  if (
    !actual ||
    !isDeepStrictEqual(actual.content, frame.snapshot.content) ||
    reconstruct(frame.contributions) !== actual.text
  )
    return undefined
  return copyContributions(frame.contributions)
}
