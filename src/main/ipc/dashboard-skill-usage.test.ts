import { describe, expect, it } from "vitest"
import { buildSkillUsageMatchFilter } from "./dashboard-skill-usage"

describe("marketplace skill usage matching", () => {
  it.each(["code.review", "code+review", "code[review]", 'code"review', "code@review", "代码评审"])(
    "treats skill names as literal terms and prefixes: %s",
    (base) => {
      expect(buildSkillUsageMatchFilter([base, base], ["usedSkills"])).toEqual({
        bool: {
          should: [{ term: { usedSkills: base } }, { prefix: { usedSkills: `${base}-v` } }],
          minimum_should_match: 1
        }
      })
    }
  )
})
