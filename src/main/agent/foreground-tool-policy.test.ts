import { expect, it } from "vitest"
import { foregroundToolPolicy } from "./foreground-tool-policy"

it("keeps foreground user input, disables skill mutation and applies Solo only in normal mode", () => {
  expect(foregroundToolPolicy("normal", {})).toEqual({
    enableRequestUserInput: true,
    noSkillEvolutionTool: true,
    disableSubagents: false
  })
  expect(foregroundToolPolicy("normal", { subagentsEnabled: false }).disableSubagents).toBe(true)
  expect(foregroundToolPolicy("workflow", { subagentsEnabled: false }).disableSubagents).toBe(false)
  expect(foregroundToolPolicy("coordinator", { subagentsEnabled: false }).disableSubagents).toBe(
    false
  )
})
