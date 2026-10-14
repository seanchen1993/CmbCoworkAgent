import type { SkillEvaluationApi } from "../shared/mods/skill-evaluation"
export function createSkillEvaluationBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): SkillEvaluationApi {
  return {
    list: (threadId) =>
      invoke("mods:skill-evaluation:list", threadId) as ReturnType<SkillEvaluationApi["list"]>,
    prepare: (input) =>
      invoke("mods:skill-evaluation:prepare", input) as ReturnType<SkillEvaluationApi["prepare"]>,
    start: (input) =>
      invoke("mods:skill-evaluation:start", input) as ReturnType<SkillEvaluationApi["start"]>,
    change: (input) =>
      invoke("mods:skill-evaluation:change", input) as ReturnType<SkillEvaluationApi["change"]>
  }
}
