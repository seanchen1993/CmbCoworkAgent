import type { Message } from "../types"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../../shared/checkpoint-transcript"
import { mergeLiveStreamCommitMessages } from "./live-stream-messages"

export type SchedulerSnapshotMessage = Omit<Message, "created_at"> & {
  created_at?: Date
}

export function normalizeSchedulerMessageSnapshot(
  messages: readonly SchedulerSnapshotMessage[],
  fallbackCreatedAt: Date = new Date()
): Message[] {
  return mergeCheckpointAuthorityTranscriptMessages(
    messages.map((message) => ({
      ...message,
      created_at: message.created_at ?? fallbackCreatedAt
    })),
    []
  )
}

export function mergeSchedulerTurnMessageSnapshot(
  previous: readonly Message[],
  messages: readonly SchedulerSnapshotMessage[],
  fallbackCreatedAt: Date = new Date()
): { messages: Message[]; turnMessages: Message[] } {
  const turnMessages = normalizeSchedulerMessageSnapshot(messages, fallbackCreatedAt)
  return {
    messages: mergeLiveStreamCommitMessages(previous, turnMessages),
    turnMessages
  }
}
