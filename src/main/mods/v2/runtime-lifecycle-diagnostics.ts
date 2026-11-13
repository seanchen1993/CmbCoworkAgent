import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../../shared/mods/v2/resource-budgets"
import {
  RUNTIME_LIFECYCLE_PHASES as phases,
  RUNTIME_LIFECYCLE_CODES as codes,
  type RuntimeLifecycleDiagnostic,
  type RuntimeLifecyclePhase
} from "../../../shared/mods/v2/runtime-diagnostics"
export type {
  RuntimeLifecycleDiagnostic,
  RuntimeLifecyclePhase
} from "../../../shared/mods/v2/runtime-diagnostics"
interface LifecycleObservation {
  generation: number
  pid?: number
  phase: RuntimeLifecyclePhase
  code?: unknown
  exitCode?: number
  pending: number
  hostCalls: number
  draining: number
}
const count = (value: number): number => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

/** Bounded observations only. Never retain prompts, source, runtime IDs, stdout or error messages. */
export class RuntimeLifecycleDiagnostics {
  private readonly entries: RuntimeLifecycleDiagnostic[] = []

  record(input: LifecycleObservation): void {
    try {
      if (!phases.includes(input.phase)) return
      const entry: RuntimeLifecycleDiagnostic = {
        at: performance.now(),
        generation: count(input.generation),
        phase: input.phase,
        ...(Number.isSafeInteger(input.pid) && input.pid! > 0 ? { pid: input.pid } : {}),
        ...(input.code === undefined
          ? {}
          : {
              code:
                typeof input.code === "string" &&
                codes.includes(input.code as (typeof codes)[number])
                  ? (input.code as (typeof codes)[number])
                  : "OTHER"
            }),
        ...(Number.isSafeInteger(input.exitCode) ? { exitCode: input.exitCode } : {}),
        pending: count(input.pending),
        hostCalls: count(input.hostCalls),
        draining: count(input.draining)
      }
      const previous = this.entries.at(-1)
      if (
        previous?.generation === entry.generation &&
        previous.phase === entry.phase &&
        previous.pid === entry.pid &&
        previous.code === entry.code &&
        previous.exitCode === entry.exitCode
      )
        this.entries[this.entries.length - 1] = Object.freeze(entry)
      else this.entries.push(Object.freeze(entry))
      if (this.entries.length > FUNCTION_MOD_RESOURCE_BUDGETS.diagnostics.retainedEvents)
        this.entries.shift()
    } catch {
      // Observation cannot change execution, cleanup or physical accounting.
    }
  }

  snapshot(): readonly RuntimeLifecycleDiagnostic[] {
    return Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry })))
  }
}
