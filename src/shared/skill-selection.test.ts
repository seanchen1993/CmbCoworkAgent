import { expect, it } from "vitest"
import { intersectSkillNames } from "./skill-selection"

it("keeps all/none distinct and never widens a stricter policy", () => {
  expect(intersectSkillNames(undefined, null)).toBeUndefined()
  expect(intersectSkillNames(null, [])).toEqual([])
  expect(intersectSkillNames(["review"], [])).toEqual([])
  expect(intersectSkillNames(["review", "test"], ["test", "deploy"])).toEqual(["test"])
  const names = ["review"]
  expect(intersectSkillNames(names)).toEqual(names)
  expect(intersectSkillNames(names)).not.toBe(names)
})
