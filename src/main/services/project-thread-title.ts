import { resolveHarnessFeatureCurrentStage } from "../harness-board/service"
import { generateTitle } from "./title-generator"

export async function generateProjectThreadTitle(
  message: string,
  skillName: string | undefined,
  binding: unknown
): Promise<string> {
  try {
    const name = skillName?.trim()
    if (binding && typeof binding === "object") {
      const { projectId, slug } = binding as Record<string, unknown>
      if (typeof projectId === "string" && typeof slug === "string") {
        const stage = await resolveHarnessFeatureCurrentStage(projectId, slug, {
          labelOnly: true
        })
        if (stage?.name.trim()) return `${name || generateTitle(message)}·${stage.name.trim()}`
      }
    }
  } catch (error) {
    console.warn("[Threads] Failed to generate project title:", error)
  }
  return generateTitle(message)
}
