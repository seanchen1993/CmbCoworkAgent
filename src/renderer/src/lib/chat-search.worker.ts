import {
  projectChatSearchPlan,
  findChatSearchLocations,
  validateChatSearchLocation,
  type ProjectedChatSearchSegment
} from "../../../shared/chat-search-index"
import { CHAT_SEARCH_INPUT_LIMIT } from "../../../shared/chat-search-plan"
import type { ChatSearchSourceSegment, ChatSearchLocation } from "../../../shared/chat-search-types"

type Request =
  | {
      type: "begin"
      requestId: number
      id: number
      role: string
      stripThink?: boolean
      cleanAttachments?: boolean
    }
  | {
      type: "part"
      requestId: number
      source: Omit<ChatSearchSourceSegment, "raw">
      raw: string
      last: boolean
    }
  | { type: "commit"; requestId: number }
  | { type: "retain"; requestId: number; ids: number[] }
  | { type: "match"; requestId: number; id: number; query: string; limit: number }
  | { type: "validate"; requestId: number; id: number; location: ChatSearchLocation }
  | { type: "forget"; requestId: number; id: number }

const documents = new Map<number, ProjectedChatSearchSegment[]>()
let retainedUnits = 0
const documentUnits = (segments: readonly ProjectedChatSearchSegment[]): number =>
  segments.reduce((sum, segment) => sum + segment.text.length, 0)
const forget = (id: number): void => {
  retainedUnits -= documentUnits(documents.get(id) ?? [])
  documents.delete(id)
}
let pending: {
  id: number
  role: string
  stripThink?: boolean
  cleanAttachments?: boolean
  units: number
  segments: ChatSearchSourceSegment[]
  parts: string[]
} | null = null

self.onmessage = (event: MessageEvent<Request>): void => {
  const request = event.data
  try {
    if (request.type === "begin") {
      pending = {
        id: request.id,
        role: request.role,
        stripThink: request.stripThink,
        cleanAttachments: request.cleanAttachments,
        units: 0,
        segments: [],
        parts: []
      }
    } else if (request.type === "part") {
      if (
        !pending ||
        request.raw.length > 8192 ||
        pending.units + request.raw.length > CHAT_SEARCH_INPUT_LIMIT
      ) {
        throw new Error("Search input budget exceeded")
      }
      pending.units += request.raw.length
      pending.parts.push(request.raw)
      if (request.last) {
        const raw = pending.parts.join("")
        pending.segments.push({ ...request.source, raw })
        pending.parts = []
      }
    } else if (request.type === "commit") {
      if (!pending || pending.parts.length) throw new Error("Incomplete search document")
      const plan = {
        role: pending.role,
        stripThink: pending.stripThink,
        cleanAttachments: pending.cleanAttachments,
        truncated: false,
        segments: pending.segments
      }
      const projected = projectChatSearchPlan(plan)
      const units = documentUnits(projected)
      const nextUnits = retainedUnits - documentUnits(documents.get(pending.id) ?? []) + units
      // One transient validation document may coexist with the 4 Mi-character search corpus.
      if (
        nextUnits > 4 * 1024 * 1024 + CHAT_SEARCH_INPUT_LIMIT ||
        (!documents.has(pending.id) && documents.size >= 501)
      )
        throw new Error("Search cache budget exceeded")
      documents.set(pending.id, projected)
      retainedUnits = nextUnits
      if (plan.truncated) self.postMessage({ requestId: request.requestId, truncated: true })
      pending = null
    } else if (request.type === "retain") {
      const retained = new Set(request.ids)
      for (const id of documents.keys()) if (!retained.has(id)) forget(id)
    } else if (request.type === "forget") {
      forget(request.id)
      if (pending?.id === request.id) pending = null
    } else if (request.type === "validate") {
      const valid = validateChatSearchLocation(documents.get(request.id) ?? [], request.location)
      self.postMessage({ requestId: request.requestId, locations: valid ? [request.location] : [] })
    } else if (request.type === "match") {
      const segments = documents.get(request.id)
      if (!segments) throw new Error("Search snapshot expired")
      const locations = findChatSearchLocations(
        segments,
        request.query,
        Math.min(1001, request.limit)
      )
      for (let index = 0; index < locations.length; index += 16) {
        self.postMessage({
          requestId: request.requestId,
          locations: locations.slice(index, index + 16)
        })
      }
    }
    self.postMessage({ requestId: request.requestId, done: true })
  } catch (error) {
    pending = null
    self.postMessage({ requestId: request.requestId, error: String(error) })
  }
}
