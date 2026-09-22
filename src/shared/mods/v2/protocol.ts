import type { ModJson, ModObject } from "../types"
import type { FunctionInvocation, FunctionHostReply } from "./contracts"

export interface FunctionWireError {
  code: string
  message: string
  downstream: boolean
}

export type FunctionRequest = {
  id: string
  runtimeId: string
} & (
  | { type: "load"; code: string; options: ModObject }
  | { type: "match"; registration: string; event: ModObject }
  | { type: "release-ui"; generation: string }
  | {
      type: "invoke"
      registration: string
      event: ModObject
      metadata: Omit<FunctionInvocation, "signal">
    }
  | { type: "dispose" | "cancel" }
  | { type: "reply"; value?: FunctionHostReply; error?: FunctionWireError }
)

export type FunctionResponse =
  | { type: "ready" }
  | { type: "disposed"; runtimeId: string }
  | { type: "heartbeat"; rss: number; runtimes: number; frames: number; replies: number }
  | { type: "result"; id: string; runtimeId: string; value: ModJson }
  | { type: "error"; id: string; runtimeId: string; error: FunctionWireError }
  | {
      type: "call"
      id: string
      runtimeId: string
      requestId: string
      method: string
      args: ModJson
    }
  | { type: "revoke"; id: string; runtimeId: string; requestId: string }
