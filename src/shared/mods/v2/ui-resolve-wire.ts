import type { ModJson } from "../types"
import type { FunctionRegistration, ModTier } from "./contracts"
import type { FunctionWireError } from "./protocol"

/** Private native control protocol; no functions, grants or drawing proofs are public SDK JSON. */
export interface FunctionUiResolveWireCredit {
  revision: number
  limits: { handles: number; roots: number; branches: number; reactions: number }
}
export interface FunctionUiResolveWireParticipant {
  runtimeId: string
  name: string
  root: string
  tier: ModTier
  registrations: readonly FunctionRegistration[]
  capabilities: string[]
  modelProtocol: "legacy-v1" | "result-v1"
}
export interface FunctionUiResolveWireDrawing {
  assembly: string
  token: string
}

export type FunctionUiResolveWireRequest =
  | {
      type: "prepare-ui-resolve"
      assembly: string
      participants: FunctionUiResolveWireParticipant[]
      startupCutNs: string
      credit: FunctionUiResolveWireCredit
    }
  | { type: "adopt-ui-resolve"; assembly: string; preparedToken: string }
  | { type: "retire-ui-resolve"; assembly: string }
  | { type: "ui-resolve-drawing-close"; assembly: string; token: string }
  | { type: "ui-resolve-scope-close"; assembly: string; scopeId: string }
  | {
      type: "ui-resolve-credit-reply"
      assembly: string
      credit?: FunctionUiResolveWireCredit
      error?: FunctionWireError
    }

export type FunctionUiResolveWireResponse =
  | {
      type: "ui-constructor-open"
      assembly: string
      scopeId: string
      consumerRuntimeId: string
      drawToken: string
      runtimeId: string
      registration: string
    }
  | {
      type: "ui-constructor-call"
      assembly: string
      scopeId: string
      id: string
      runtimeId: string
      registration: string
      method: string
      args: ModJson
    }
  | { type: "ui-constructor-drained"; assembly: string; scopeId: string }
  | { type: "ui-constructor-quiescent"; assembly: string; scopeId: string }
  | {
      type: "ui-resolve-call-revoke"
      assembly: string
      id: string
      runtimeId: string
      registration: string
    }
  | {
      type: "ui-resolver-call"
      assembly: string
      id: string
      requestId: string
      runtimeId: string
      registration: string
      method: string
      args: ModJson
    }
  | {
      type: "ui-resolve-credit-request"
      assembly: string
      id: string
      limits: FunctionUiResolveWireCredit["limits"]
    }
  | { type: "ui-resolve-credit-ack"; assembly: string; revision: number }

export function isFunctionUiResolveWireResponse(message: {
  type: string
}): message is FunctionUiResolveWireResponse {
  return [
    "ui-constructor-open",
    "ui-constructor-call",
    "ui-constructor-drained",
    "ui-constructor-quiescent",
    "ui-resolve-call-revoke",
    "ui-resolver-call",
    "ui-resolve-credit-request",
    "ui-resolve-credit-ack"
  ].includes(message.type)
}
