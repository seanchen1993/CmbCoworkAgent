/**
 * Tests the renderer→main wire format for slash-command skill invocations.
 *
 * Renderer-side `formatSkillUseBlock` builds the `<CMBDEVCLAW-SKILL-USE-V1>`
 * tail block; main-side `parseSkillUseBlock` reads it back and feeds the
 * skill activation pipeline. These two MUST agree on every payload — a
 * subtle escape mismatch would silently break explicit skill selection.
 *
 * Run:
 *   npx tsx tests/slash-skill-marker.spec.ts
 */

import {
  formatSkillUseBlock,
  parseSkillUseBlock as parseRenderer
} from "../src/renderer/src/features/slash-commands/skill-marker.ts"
import {
  formatSkillUseBlock as formatMainSkillUseBlock,
  parseSkillUseBlock as parseMain
} from "../src/main/agent/skill-lifecycle/marker.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function testRoundTripSimple(): Promise<void> {
  const block = formatSkillUseBlock({ name: "pdf", path: "C:/skills/pdf/SKILL.md" })
  const message = `请用这个技能\n\n${block}`

  const renderer = parseRenderer(message)
  assert(renderer?.skillName === "pdf", `renderer parse name, got ${renderer?.skillName}`)
  assert(renderer?.skillPath === "C:/skills/pdf/SKILL.md", `renderer parse path, got ${renderer?.skillPath}`)
  assert(renderer?.rest === "请用这个技能", `renderer rest preserves prose, got ${renderer?.rest}`)

  const main = parseMain(message)
  assert(main?.skillName === "pdf", `main parse name, got ${main?.skillName}`)
  assert(main?.skillPath === "C:/skills/pdf/SKILL.md", `main parse path, got ${main?.skillPath}`)
  assert(main?.rest === "请用这个技能", `main rest preserves prose, got ${main?.rest}`)
  assert(main?.block === block, "main parse should preserve exact block payload")
}

async function testRoundTripWithXmlSpecialChars(): Promise<void> {
  // Skill names should never contain these in practice, but the format/parse
  // layer must survive them — escapeXml + unescapeXml must be symmetric.
  const skill = {
    name: "Skill <weird & quoted> 名字",
    path: "C:/path with spaces/<dir>/SKILL.md"
  }
  const block = formatSkillUseBlock(skill)
  const message = `\n\n${block}`

  for (const [label, parsed] of [
    ["renderer", parseRenderer(message)],
    ["main", parseMain(message)]
  ] as const) {
    assert(parsed !== null, `${label} should parse a well-formed block`)
    assert(
      parsed!.skillName === skill.name,
      `${label}: name should round-trip through XML escaping, got ${parsed!.skillName}`
    )
    assert(
      parsed!.skillPath === skill.path,
      `${label}: path should round-trip through XML escaping, got ${parsed!.skillPath}`
    )
  }
}

async function testMainFormatterRoundTrip(): Promise<void> {
  const skill = {
    name: "skill-creator",
    path: "/Users/me/.cmbcoworkagent/skills/skill-creator/SKILL.md"
  }
  const block = formatMainSkillUseBlock(skill)
  const message = `继续 goal\n\n${block}`

  for (const [label, parsed] of [
    ["renderer", parseRenderer(message)],
    ["main", parseMain(message)]
  ] as const) {
    assert(parsed !== null, `${label} should parse main-generated skill block`)
    assert(parsed!.skillName === skill.name, `${label}: main-generated skill name should parse`)
    assert(parsed!.skillPath === skill.path, `${label}: main-generated skill path should parse`)
    assert(parsed!.rest === "继续 goal", `${label}: main-generated block should preserve rest`)
  }
}

async function testTrailingProseRefusesParse(): Promise<void> {
  // The block MUST be at the very end. If the user types more text after the
  // close tag, neither side should treat it as a real protocol block — that
  // would silently swallow user prose.
  const block = formatSkillUseBlock({ name: "pdf", path: "C:/skills/pdf/SKILL.md" })
  const messageWithTail = `${block}\nuser typed more text after`
  assert(parseRenderer(messageWithTail) === null, "renderer should refuse blocks with trailing prose")
  assert(parseMain(messageWithTail) === null, "main should refuse blocks with trailing prose")
}

async function testTrailingWhitespaceIsTolerated(): Promise<void> {
  const block = formatSkillUseBlock({ name: "pdf", path: "C:/skills/pdf/SKILL.md" })
  // The renderer's parser allows pure whitespace tail.
  const padded = `${block}\n\n   \r\n`
  assert(parseRenderer(padded)?.skillName === "pdf", "renderer should tolerate trailing whitespace")
  assert(parseMain(padded)?.skillName === "pdf", "main should tolerate trailing whitespace")
}

async function testNoBlockReturnsNull(): Promise<void> {
  assert(parseRenderer("just a normal message") === null, "renderer: no block → null")
  assert(parseMain("just a normal message") === null, "main: no block → null")
}

async function testMissingNameOrPathReturnsNull(): Promise<void> {
  // Hand-craft a malformed block missing <path>. Real producers always emit both.
  const malformed = [
    "<CMBDEVCLAW-SKILL-USE-V1>",
    "<instruction>read it</instruction>",
    "<name>pdf</name>",
    "</CMBDEVCLAW-SKILL-USE-V1>"
  ].join("\n")
  assert(parseRenderer(malformed) === null, "renderer: missing path → null")
  assert(parseMain(malformed) === null, "main: missing path → null")
}

async function testLastBlockWinsWhenUserTextContainsTagName(): Promise<void> {
  // If the user's prose mentions our tag name, the parser uses lastIndexOf,
  // so only the trailing real block is recognised — earlier user prose is
  // preserved in `rest`.
  const proseWithMention =
    "I tried <CMBDEVCLAW-SKILL-USE-V1> earlier but it broke (no closing tag)\n\n"
  const realBlock = formatSkillUseBlock({ name: "pdf", path: "C:/skills/pdf/SKILL.md" })
  const message = proseWithMention + realBlock

  for (const [label, parsed] of [
    ["renderer", parseRenderer(message)],
    ["main", parseMain(message)]
  ] as const) {
    assert(parsed?.skillName === "pdf", `${label}: should pick the last block, got ${parsed?.skillName}`)
    assert(
      parsed?.rest.includes("I tried"),
      `${label}: earlier prose with the tag name should be preserved in rest`
    )
  }
}

async function testEmptyNameOrPathRejected(): Promise<void> {
  // The XML is well-formed but values are empty after trim — caller never
  // emits this, but defend against it (the marker contract requires both).
  const block = [
    "<CMBDEVCLAW-SKILL-USE-V1>",
    "<instruction>i</instruction>",
    "<name>   </name>",
    "<path>   </path>",
    "</CMBDEVCLAW-SKILL-USE-V1>"
  ].join("\n")
  assert(parseRenderer(block) === null, "renderer: empty name/path → null")
  assert(parseMain(block) === null, "main: empty name/path → null")
}

async function run(): Promise<void> {
  await testRoundTripSimple()
  console.log("PASS M1 round-trip simple skill")
  await testRoundTripWithXmlSpecialChars()
  console.log("PASS M2 round-trip XML special characters in name/path")
  await testMainFormatterRoundTrip()
  console.log("PASS M2b main formatter round-trip")
  await testTrailingProseRefusesParse()
  console.log("PASS M3 trailing prose after close tag refuses to parse")
  await testTrailingWhitespaceIsTolerated()
  console.log("PASS M4 trailing whitespace tolerated")
  await testNoBlockReturnsNull()
  console.log("PASS M5 no block → null")
  await testMissingNameOrPathReturnsNull()
  console.log("PASS M6 missing <name> or <path> → null")
  await testLastBlockWinsWhenUserTextContainsTagName()
  console.log("PASS M7 last block wins; user text mentioning tag is preserved")
  await testEmptyNameOrPathRejected()
  console.log("PASS M8 whitespace-only name/path rejected")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
