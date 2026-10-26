import type { ModJson, ModObject } from "../types"
import type { FunctionInvocation, FunctionHostReply } from "./contracts"
import type { FunctionUiResolveWireDrawing, FunctionUiResolveWireRequest,
  FunctionUiResolveWireResponse } from "./ui-resolve-wire"

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
  | { type: "release-resource"; handle: number }
  | { type: "release-stream-cursor"; handle: number }
  | {
      type: "invoke"
      registration: string
      event: ModObject
      metadata: Omit<FunctionInvocation, "signal">
      uiDrawing?: FunctionUiResolveWireDrawing
    }
  | { type: "trusted-wait"; requestId: string; callId: string; ticket: string;
      phase: "begin" | "end"; allowanceMs?: number; creditMs?: number }
  | { type: "dispose" | "cancel" }
  | { type: "reply"; value?: FunctionHostReply; error?: FunctionWireError }
  | FunctionUiResolveWireRequest
)

export type FunctionResponse =
  | FunctionUiResolveWireResponse
  | { type: "ready" }
  | { type: "disposed"; runtimeId: string }
  | { type: "heartbeat"; rss: number; runtimes: number; frames: number; replies: number }
  | { type: "result"; id: string; runtimeId: string; value: ModJson }
  | { type: "error"; id: string; runtimeId: string; error: FunctionWireError;
      guestLoadFailure?: true; guestInvokeFailure?: true }
  | {
      type: "call"
      id: string
      runtimeId: string
      requestId: string
      method: string
      args: ModJson
    }
  | { type: "revoke"; id: string; runtimeId: string; requestId: string }
  | { type: "module-call"; id: string; runtimeId: string; method: string; args: ModJson;
      dispatchCutNs?: string }
  | { type: "module-revoke"; id: string; runtimeId: string }
