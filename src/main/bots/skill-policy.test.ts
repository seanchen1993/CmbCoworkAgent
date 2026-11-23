import { expect, it } from "vitest"
import { applyBotSkillSelection } from "./skill-policy"
import { botMockRemotePolicy, botTextOnlyRemotePolicy } from "./mock-runtime-policy"

it.each([undefined, null, [], ["review"]])(
  "retains mock and report restrictions with selection %j",
  (allowedSkillNames) => {
    for (const policy of [botMockRemotePolicy(), botTextOnlyRemotePolicy([])]) {
      expect(applyBotSkillSelection({ allowedSkillNames }, policy)).toEqual(policy)
    }
  }
)
it("intersects additional skill restrictions without changing the caller's policy", () => {
  const policy = { allowedSkillNames: ["review", "deploy"], disableHooks: true }
  expect(applyBotSkillSelection({ allowedSkillNames: ["review", "test"] }, policy)).toEqual({
    allowedSkillNames: ["review"],
    disableHooks: true,
    disableSkillEvolution: true
  })
  expect(policy.allowedSkillNames).toEqual(["review", "deploy"])
})
