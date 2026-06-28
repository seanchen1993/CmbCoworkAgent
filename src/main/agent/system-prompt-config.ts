import { access, readFile } from "fs/promises"
import { join } from "path"
import { getCmbCoworkAgentsHome } from "./agents-md"

export type ConfiguredSystemPromptMode = "session" | "harnessboard"

export interface ConfiguredSystemPrompt {
  prompt: string
  path: string
}

const SYSTEM_PROMPT_FILENAME = "system-prompt.md"
const SESSION_SYSTEM_PROMPT_FILENAME = "session.system-prompt.md"
const HARNESSBOARD_SYSTEM_PROMPT_FILENAME = "harnessboard.system-prompt.md"

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function modeSpecificFilename(mode: ConfiguredSystemPromptMode): string {
  return mode === "harnessboard"
    ? HARNESSBOARD_SYSTEM_PROMPT_FILENAME
    : SESSION_SYSTEM_PROMPT_FILENAME
}

export function getSystemPromptConfigHome(): string {
  return getCmbCoworkAgentsHome()
}

export function getSystemPromptCandidatePaths(
  mode: ConfiguredSystemPromptMode,
  home = getSystemPromptConfigHome()
): string[] {
  return [join(home, modeSpecificFilename(mode)), join(home, SYSTEM_PROMPT_FILENAME)]
}

export async function loadConfiguredSystemPrompt(
  mode: ConfiguredSystemPromptMode
): Promise<ConfiguredSystemPrompt> {
  const home = getSystemPromptConfigHome()
  const candidates = getSystemPromptCandidatePaths(mode, home)

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue
    const prompt = await readFile(candidate, "utf-8")
    return {
      prompt,
      path: candidate
    }
  }

  throw new Error(
    [
      `System prompt config is required for ${mode} mode.`,
      "Create one of:",
      ...candidates.map((candidate) => `- ${candidate}`)
    ].join("\n")
  )
}
