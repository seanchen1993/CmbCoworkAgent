import { describe, expect, it } from "vitest"
import { appendBtwReferences } from "./btw-references"
import { splitBotInlineReasoning } from "./bots/inline-reasoning"
import { CHAT_SEARCH_INPUT_LIMIT, createChatSearchPlan, appendChatSearchToolSummaries } from "./chat-search-plan"
import { createThreadSearchMessagePlan } from "./thread-search-projection"
import {
  createChatSearchPlanQueryFilter,
  findChatSearchLocations,
  findChatTextRanges,
  projectChatSearchPlan,
  validateChatSearchLocation
} from "./chat-search-index"

describe("search fragment coordinates", () => {
  it("rejects ordinary English and CJK misses without excluding visible Markdown phrases", () => {
    const fixture = "# Review notes\n\n**Result** [reference](docs/details.md)\n\n" +
      "```sh\nnpm run lint && npm test\n```\n\n```js\nconst invalid = /[^a-z]/g\n```\n\n" +
      "[query](https://example.invalid?ref=1&mode=docs) Research & Development.\n\n" +
      "The build records the resulting state so the next run can resume from the saved checkpoint. ".repeat(28) +
      "\nRecord 1729. "
    expect(createChatSearchPlanQueryFilter("saved build")(createChatSearchPlan("assistant", fixture))).toBe(false)
    expect(createChatSearchPlanQueryFilter("不存在")(createChatSearchPlan("assistant", [
      { type: "text", text: fixture }, { type: "text", text: "Another block for the final update." }
    ]))).toBe(false)
    const renderedCases = ["Release is **very *ready*** for rollout.", "Inline `line\nbreak` now.",
      "[a](https://docs)bc\n\nsecond part", "甲**乙**丙😀", "A &copy; B",
      "| before | after |\n|-|-|\n| first | second |", "> quoted\n>\n> second part",
      "a[^1]\n\n[^1]: Footnote", "a <span\n\nclass='c'>marked</span>", "Before \0 after.",
      "one &#23383; and &#x5b57;."]
    for (const source of renderedCases) {
      const plan = createChatSearchPlan("assistant", source)
      for (const segment of projectChatSearchPlan(plan)) {
        for (const line of segment.text.split(/\r?\n/)) {
          for (let start = 0; start < line.length; start += 1) {
            const query = line.slice(start, start + 14).trim()
            if (query) expect(createChatSearchPlanQueryFilter(query)(plan), `${source} / ${query}`).toBe(true)
          }
        }
      }
    }
  })

  it("builds one shared system notice across supported structured blocks", () => {
    const structured = createChatSearchPlan("system", [
      { type: "text", text: "    System is *ready" }, { type: "report", content: "to serve*." }
    ])
    expect(projectChatSearchPlan(structured)[0]?.text).toBe("System is ready\nto serve.")
    const ordinary = createChatSearchPlan("system", " ✓ Regular notice confirmed")
    expect(projectChatSearchPlan(ordinary)[0]?.text).toBe("✓ Regular notice confirmed")
  })

  it.each(["assistant", "system"])("keeps distinct folded hits for %s Markdown", (role) => {
    const source = ["Before release in the visible head.", "", "```md", "x".repeat(24_000), "", "Before **release**", "",
      "y".repeat(47_000), "```"].join("\n")
    const plan = createChatSearchPlan(role, source)
    const projected = projectChatSearchPlan(plan)
    const hits = findChatSearchLocations(projected, "Before release")
    expect(hits).toHaveLength(2)
    expect(hits[1]?.sourceStart).toBeGreaterThan(0)
    for (const hit of hits) expect(validateChatSearchLocation(projected, hit)).toBe(true)
    expect(findChatSearchLocations(projected, "Before **release**")).toHaveLength(1)
    expect(findChatSearchLocations(projected, "Before")).toHaveLength(2)
  })

  it.each(["assistant", "system"])("deduplicates transformed folded %s hits by their raw origin", (role) => {
    const head = ["Before &copy; release.", "", "```md", "x".repeat(71_000), "```"].join("\n")
    const tail = ["x".repeat(23_800), "", "[ref]: https://example.invalid", "", "[&copy; label][ref]", "",
      "y".repeat(49_100)].join("\n")
    const continuedTail = tail.replace("&copy; label", "&copy;\r\n label")
    const continuedCode = head.replace("Before &copy; release.", "`foo\nbar`")
    const quoted = tail.replace("[&copy; label][ref]", "> [&copy; \n> label][ref]")
    const codeInQuote = head.replace("Before &copy; release.", "> `foo\r\n> bar`")
    const codeInList = head.replace("Before &copy; release.", "- `foo\n  bar`")
    const fencedInQuote = head.replace("Before &copy; release.", "> ```js\n> literal\n> answer\n> ```")
    const longCodeQuote = head.replace("Before &copy; release.",
      `> ~~~js\n${"> simple\n".repeat(40)}> answer\n> ~~~`)
    const tableCode = head.replace("Before &copy; release.", "| header |\n| --- |\n| `a\\|b` |")
    for (const [source, query] of [[head, "Before © release"], [tail, "© label"],
      [continuedTail, "©"], [continuedCode, "foo bar"], [quoted, "label"],
      [codeInQuote, "foo bar"], [codeInList, "bar"], [fencedInQuote, "answer"], [longCodeQuote, "answer"],
      [tableCode, "a|b"]]) {
      const segments = projectChatSearchPlan(createChatSearchPlan(role, source))
      expect(findChatSearchLocations(segments, query)).toHaveLength(1)
    }
  })

  it("bounds mixed canonical and folded results by the same total limit", () => {
    const source = ["Before release in the visible head.", "", "```md", "x".repeat(24_000), "",
      "Before **release** and Before **release**", "", "y".repeat(47_000), "```"].join("\n")
    const segments = projectChatSearchPlan(createChatSearchPlan("assistant", source))
    expect(findChatSearchLocations(segments, "Before release", 2)).toHaveLength(2)
  })

  it("searches the authored footnote text without counting generated navigation", () => {
    const source = ["a[^ref]", "", "[^ref]: second sentinel", "", "```md", "x".repeat(71_000), "```"].join("\n")
    const segments = projectChatSearchPlan(createChatSearchPlan("assistant", source))
    expect(findChatSearchLocations(segments, "second sentinel")).toHaveLength(1)
    expect(findChatSearchLocations(segments, "1")).toEqual([])
    expect(findChatSearchLocations(segments, "↩")).toEqual([])
  })
  it("computes the same exact revision when hashing only matched projection segments", () => {
    const plan = createChatSearchPlan("assistant", "**İ** before 😀 needle and another NEEDLE")
    appendChatSearchToolSummaries(plan, [{ name: "read_file", args: { file_path: "needle.md" } }])
    const eager = projectChatSearchPlan(plan)
    const deferred = projectChatSearchPlan(plan, true)
    const found = findChatSearchLocations(deferred, "needle")
    expect(found).toHaveLength(3)
    expect(found).toEqual(findChatSearchLocations(eager, "needle"))
    for (const location of found) expect(validateChatSearchLocation(eager, location)).toBe(true)
  })

  it("caps presentation text as well as raw input and marks incomplete coverage", () => {
    const plan = createChatSearchPlan("user", "x".repeat(256 * 1024))
    plan.segments[0].raw = `/goal ${"x".repeat(256 * 1024 - 6)}`
    const projected = projectChatSearchPlan(plan)
    expect(projected.reduce((sum, segment) => sum + segment.text.length, 0)).toBeLessThanOrEqual(
      256 * 1024
    )
    expect(plan.truncated).toBe(true)
  })
  it("revalidates unchanged prefixes but rejects an edited or hidden snapshot", () => {
    const initial = projectChatSearchPlan(createChatSearchPlan("assistant", "first needle"))
    const [location] = findChatSearchLocations(initial, "needle")
    expect(
      validateChatSearchLocation(
        projectChatSearchPlan(createChatSearchPlan("assistant", "first needle and more")),
        location
      )
    ).toBe(true)
    expect(
      validateChatSearchLocation(
        projectChatSearchPlan(createChatSearchPlan("assistant", "other needle")),
        location
      )
    ).toBe(false)
    expect(validateChatSearchLocation([], location)).toBe(false)
  })
  it("distinguishes repeated head/middle/tail occurrences using their actual fragments", () => {
    const text = `needle\n\n${"x".repeat(20_000)}\n\nneedle\n\n${"y".repeat(80_000)}\n\nneedle`
    const locations = findChatSearchLocations(
      projectChatSearchPlan(createChatSearchPlan("assistant", text)),
      "needle"
    )
    expect(locations).toHaveLength(3)
    expect(locations.map((location) => location.sourceStart)).toEqual(
      [...locations.map((location) => location.sourceStart)].sort((a, b) => a - b)
    )
    expect(new Set(locations.map((location) => location.start)).size).toBe(3)
    for (const location of locations) {
      expect(location.context.slice(location.contextStart, location.contextEnd)).toBe("needle")
    }
  })

  it("never creates a phrase across omitted content", () => {
    const plan = createChatSearchPlan("assistant", "x".repeat(400_000))
    plan.segments = [
      { kind: "body", blockIndex: 0, start: 0, end: 5, sourceLength: 400_000, raw: "alpha" },
      {
        kind: "body",
        blockIndex: 0,
        start: 399_995,
        end: 400_000,
        sourceLength: 400_000,
        raw: "omega"
      }
    ]
    expect(findChatSearchLocations(projectChatSearchPlan(plan), "alpha\nomega")).toEqual([])
  })

  it("preserves phrases and Markdown syntax across continuous preview boundaries", () => {
    const plan = createChatSearchPlan("assistant", "unused")
    plan.segments = [
      { kind: "body", blockIndex: 0, start: 0, end: 8, sourceLength: 14, raw: "alpha **" },
      { kind: "body", blockIndex: 0, start: 8, end: 15, sourceLength: 15, raw: "omega**" }
    ]
    const result = findChatSearchLocations(projectChatSearchPlan(plan), "alpha omega")
    expect(result).toHaveLength(1)
    expect(result[0].context).toBe("alpha omega")
  })

  it("keeps multi-block Goal labels identical to their presentation", () => {
    const plan = createChatSearchPlan("user", [
      { type: "text", text: "/goal ship release" },
      { type: "text", text: "启动附件：report.md" }
    ])
    expect(projectChatSearchPlan(plan)[0].text).toBe("设为 Goal\nship release\n附件：report.md")
  })

  it("maps case-expanded Unicode offsets back to the original text", () => {
    const text = "İ before needle 😀 NEEDLE"
    const ranges = findChatTextRanges(text, "needle", 10)
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual(["needle", "NEEDLE"])
  })

  it("strips admitted reasoning and attachment transport without exposing severed wrappers", () => {
    const hidden = createChatSearchPlan("assistant", "<think>secret</think>visible", {
      stripThink: true
    })
    expect(
      projectChatSearchPlan(hidden)
        .map((part) => part.text)
        .join("")
    ).toBe("visible")
    const large = createChatSearchPlan(
      "assistant",
      `<think>${"secret".repeat(50_000)}</think>visible`,
      { stripThink: true }
    )
    expect(large.truncated).toBe(true)
    expect(projectChatSearchPlan(large)).toEqual([])
    const attachment = createChatSearchPlan(
      "user",
      '<attachment filename="report.txt">secret</attachment>visible'
    )
    const text = projectChatSearchPlan(attachment)
      .map((part) => part.text)
      .join("")
    expect(text).toContain("report.txt")
    expect(text).toContain("visible")
    expect(text).not.toContain("secret")
  })

  it("indexes auxiliary user message bodies without exposing selection chips or their transport", () => {
    const question = appendBtwReferences("Explain this", [{ text: "quote-only target" }])
    const attachment = '\n<attachment filename="report.txt">hidden contents</attachment>'
    for (const [content, expected] of [[question, "Explain this"], [question + attachment, "📎 report.txt\n\nExplain this"]]) {
      const live = createChatSearchPlan("user", content, { sideConversation: true })
      const durable = createThreadSearchMessagePlan("user", content, [], null, null, false, false, undefined, true)!
      for (const plan of [live, durable]) {
        const segments = projectChatSearchPlan(plan)
        const matches = findChatSearchLocations(segments, "Explain this")
        expect(matches).toHaveLength(1)
        expect(matches[0].context).toBe(expected)
        expect(findChatSearchLocations(segments, "quote-only")).toEqual([])
        expect(findChatSearchLocations(segments, "userselect")).toEqual([])
      }
    }
    const invalid = "Explain this\n\n# userselect:\n```userselect\nordinary text\n```"
    const segments = projectChatSearchPlan(createChatSearchPlan("user", invalid, { sideConversation: true }))
    expect(findChatSearchLocations(segments, "ordinary text")).toHaveLength(1)
  })

  it("searches the displayed side reply after leading whitespace without admitting an oversized reasoning block", () => {
    const body = "The visible answer. ".repeat(8).trimEnd()
    const reply = `${" ".repeat(80)}<think>private reasoning</think>\n${body}`
    const live = createChatSearchPlan("assistant", reply, { sideConversation: true })
    const durable = createThreadSearchMessagePlan("assistant", reply, [], null, null, false, false, undefined, true)!
    expect(splitBotInlineReasoning(reply)).toEqual({ body, reasoning: "private reasoning" })
    for (const plan of [live, durable]) {
      const segments = projectChatSearchPlan(plan)
      expect(segments.map(segment => segment.text)).toEqual([body])
      expect(findChatSearchLocations(segments, "private reasoning")).toEqual([])
    }

    for (const padding of [80, CHAT_SEARCH_INPUT_LIMIT + 1]) {
      const large = createChatSearchPlan("assistant", `${" ".repeat(padding)}<think>${"x".repeat(CHAT_SEARCH_INPUT_LIMIT)}`, {
        sideConversation: true
      })
      expect(large.truncated).toBe(true)
      expect(large.segments).toEqual([])
    }
  })

  it("searches literal /goal text in auxiliary messages and the Goal card title in ordinary ones", () => {
    for (const content of ["/goal ship", [{ type: "text", text: "/goal ship" }], [
      { type: "text", text: "/goal" }, { type: "text", text: "ship" }
    ]]) {
      const side = createChatSearchPlan("user", content, { sideConversation: true })
      expect(projectChatSearchPlan(side)[0].text).toMatch(/^\/goal\s+ship$/)
    }
    expect(projectChatSearchPlan(createChatSearchPlan("user", "/goal ship"))[0].text).toContain("设为 Goal")
  })

  it("keeps literal userselect examples searchable in ordinary and durable user messages", () => {
    const example = appendBtwReferences("Example", [{ text: "literal quote" }])
    for (const plan of [createChatSearchPlan("user", example), createThreadSearchMessagePlan("user", example, [], null)!]) {
      const [segment] = projectChatSearchPlan(plan)
      expect(segment.text).toBe(example)
      expect(findChatSearchLocations([segment], "literal quote")).toHaveLength(1)
    }
  })

  it("bounds tool parameters before constructing their collapsed summaries", () => {
    const plan = createChatSearchPlan("assistant", "answer")
    appendChatSearchToolSummaries(plan, [
      { name: "execute", args: { command: "x".repeat(1_000_000) } }
    ])
    expect(plan.truncated).toBe(true)
    expect(plan.segments.reduce((sum, part) => sum + part.raw.length + 1, 0)).toBeLessThanOrEqual(
      256 * 1024
    )
  })
})
