import { generateTitle } from "./title-generator"

export async function generateProjectThreadTitle(
  message: string,
  skillName: string | undefined,
  binding: unknown,
  skillDescription?: string
): Promise<string> {
  if (binding && typeof binding === "object") {
    const { projectId, slug } = binding as Record<string, unknown>
    if (typeof projectId === "string" && typeof slug === "string") {
      const title = [skillDescription?.trim(), skillName?.trim()].filter(Boolean).join("·")
      if (title) return title
    }
  }
  return generateTitle(message)
}
