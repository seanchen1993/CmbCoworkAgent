export interface ChatSearchSourceSegment {
  stripThink?: boolean
  kind: "body" | "summary"
  blockIndex: number
  start: number
  end: number
  sourceLength: number
  raw: string
}

export interface ChatSearchPlan {
  role: string
  stripThink?: boolean
  cleanAttachments?: boolean
  segments: ChatSearchSourceSegment[]
  truncated: boolean
}

export interface ChatSearchLocation {
  kind: ChatSearchSourceSegment["kind"]
  blockIndex: number
  sourceStart: number
  sourceEnd: number
  /** Identity of this bounded projection, never a hash of the entire transcript. */
  revision: string
  start: number
  end: number
  /** Bounded projected context, also usable when Markdown DOM offsets differ. */
  segmentOccurrence: number
  context: string
  contextStart: number
  contextEnd: number
}

export interface ChatSearchReveal {
  messageId: string
  location: ChatSearchLocation
}

export function chatSearchLocationKey(location: ChatSearchLocation): string {
  return [
    location.kind,
    location.blockIndex,
    location.sourceStart,
    location.sourceEnd,
    location.revision,
    location.start,
    location.end
  ].join(":")
}

export function areChatSearchPlansEqual(
  left: ChatSearchPlan | undefined,
  right: ChatSearchPlan
): boolean {
  return Boolean(
    left &&
    left.role === right.role &&
    left.stripThink === right.stripThink &&
    left.cleanAttachments === right.cleanAttachments &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => {
      const other = right.segments[index]
      return (
        segment.kind === other.kind &&
        segment.blockIndex === other.blockIndex &&
        segment.start === other.start &&
        segment.end === other.end &&
        segment.raw === other.raw &&
        segment.stripThink === other.stripThink
      )
    })
  )
}
