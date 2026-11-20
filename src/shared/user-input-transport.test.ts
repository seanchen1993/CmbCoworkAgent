import { describe, expect, it } from "vitest"
import { formatSkillUseBlock } from "./skill-use-block"
import {
  BUILTIN_BROWSER_INSTRUCTIONS_CLOSE,
  BUILTIN_BROWSER_INSTRUCTIONS_OPEN,
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

  it("recognizes the browser wrapper without matching its prompt text", () => {
    expect(
      stripUserInputTransportDecorations(
        `${BUILTIN_BROWSER_INSTRUCTIONS_OPEN}\n任意新版提示词\n${BUILTIN_BROWSER_INSTRUCTIONS_CLOSE}\n打开首页`
      )
    ).toBe("打开首页")
  })

  it("drops a leading slash command but not a leading absolute path", () => {
    expect(stripUserInputTransportDecorations("/goal 把首页速度提上去")).toBe("把首页速度提上去")
    expect(stripUserInputTransportDecorations("/Users/demo/src 看下")).toBe("/Users/demo/src 看下")
  })
})

describe("built-in browser prefixes", () => {
  it("uses reusable-operation wording", () => {
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).toContain("匹配的可复用操作")
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).not.toContain("匹配的录制脚本")
  })

  it("uses the iframe extractor when iframe content cannot be read", () => {
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).not.toContain("页面读取先用 browser_snapshot")
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).toContain("iframe 内容无法读取时")
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).toContain("inAppBrowser_extract_iframes")
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).toContain("支持跨域")
  })

  it("stay the pair the composer actually prepends", () => {
    expect(BUILTIN_BROWSER_PROMPT_PREFIX).toMatch(/^<builtin-browser-instructions>/)
    expect(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX).toMatch(/^<builtin-browser-instructions>/)
  })
})
