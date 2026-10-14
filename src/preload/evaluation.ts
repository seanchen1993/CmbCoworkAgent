import type { EvaluationApi } from "../shared/mods/evaluation-api"

export function createEvaluationBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): EvaluationApi {
  return {
    list: (threadId) =>
      invoke("mods:evaluation:list", threadId) as ReturnType<EvaluationApi["list"]>,
    discard: (input) => invoke("mods:evaluation:discard", input) as ReturnType<EvaluationApi["discard"]>,
    start: (input) => invoke("mods:evaluation:start", input) as ReturnType<EvaluationApi["start"]>,
    cancel: (input) =>
      invoke("mods:evaluation:cancel", input) as ReturnType<EvaluationApi["cancel"]>
  }
}
