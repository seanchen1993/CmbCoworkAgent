import { describe, expect, it } from "vitest"
import { formatSkillUseBlock } from "./skill-use-block"
import {
  BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX,
  BUILTIN_BROWSER_PROMPT_PREFIX,
  stripUserInputTransportDecorations
} from "./user-input-transport"

const SKILL_BLOCK = formatSkillUseBlock({
  name: "代码审查",
  path: "/Users/demo/.claude/skills/code-review/SKILL.md"
})

describe("stripUserInputTransportDecorations", () => {
  it("leaves plain user text untouched", () => {
    expect(stripUserInputTransportDecorations("帮我看下这个页面")).toBe("帮我看下这个页面")
  })

  it("drops the skill-use block wherever it sits", () => {
    expect(stripUserInputTransportDecorations(`看下这个页面\n\n${SKILL_BLOCK}`)).toBe(
      "看下这个页面"
    )
    expect(stripUserInputTransportDecorations(`${SKILL_BLOCK}\n\n看下这个页面`)).toBe(
      "看下这个页面"
    )
  })

  it("drops paired and self-closing attachment blocks", () => {
    expect(
      stripUserInputTransportDecorations(
        '看下这个\n\n<attachment filename="a.txt" type="text/plain">\nbody text here\n</attachment>'
      )
    ).toBe("看下这个")
    expect(stripUserInputTransportDecorations('看下这个\n\n<attachment filename="a.txt" />')).toBe(
      "看下这个"
    )
  })

  it("keeps the words on either side of a stripped block apart", () => {
    expect(stripUserInputTransportDecorations('前<attachment filename="a.txt" />后')).toBe("前 后")
  })

  it("peels the browser prefix, then a coordinator token inside it", () => {
    expect(
      stripUserInputTransportDecorations(`${BUILTIN_BROWSER_PROMPT_PREFIX}[coordinator] 打开首页`)
    ).toBe("打开首页")
    expect(
      stripUserInputTransportDecorations(`${BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX}打开首页`)
    ).toBe("打开首页")
  })

  it("drops a leading slash command but not a leading absolute path", () => {
    expect(stripUserInputTransportDecorations("/goal 把首页速度提上去")).toBe("把首页速度提上去")
    expect(stripUserInputTransportDecorations("/Users/demo/src 看下")).toBe("/Users/demo/src 看下")
  })
})

describe("built-in browser prefixes", () => {
  it("stay the pair the composer actually prepends", () => {
    // The renderer derives the no-screenshot form from the base prefix; if that
    // derivation ever changes shape, this pins the spelling main relies on.
    expect(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX).toBe(
      `${BUILTIN_BROWSER_PROMPT_PREFIX.slice(0, -1)}（不允许使用截图功能）：`
    )
  })
})
