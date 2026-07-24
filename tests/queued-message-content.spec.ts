/**
 * Unit tests for the queued-message content builders. These guarantee a drained
 * draft produces the SAME model payload and display bubble as a live send —
 * the core correctness invariant of the draft queue.
 *
 * Run:
 *   npx -y tsx tests/queued-message-content.spec.ts
 */

import {
  getQueuedModelContent,
  getQueuedDisplayContent,
  getQueuedPreview,
  guardCoordinatorPlainText,
  canClaimQueuedMessage,
  classifyGuidedMessage
} from "../src/renderer/src/lib/queued-message-content.ts"
import type { QueuedMessage } from "../src/renderer/src/types.ts"
import { formatSkillUseBlock } from "../src/renderer/src/features/slash-commands/skill-marker.ts"

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}:\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
}

function testPumpClaimsOnlyUnchangedDraftVersion(): void {
  const expected = qm({ updated_at: new Date(100) })
  assertEqual(canClaimQueuedMessage(expected, expected), true, "unchanged draft can be claimed")
  assertEqual(canClaimQueuedMessage(expected, undefined), false, "deleted draft cannot be claimed")
  assertEqual(
    canClaimQueuedMessage(expected, { ...expected, text: "edited", updated_at: new Date(101) }),
    false,
    "edited draft cannot be claimed from a stale pump snapshot"
  )
  assertEqual(
    canClaimQueuedMessage(expected, { ...expected, handoffRequestedAt: new Date(101) }),
    false,
    "guided draft remains owned by the active run"
  )
}

function testGuidedReconciliationPrioritizesDurableState(): void {
  assertEqual(
    classifyGuidedMessage("id-1", {
      pendingIds: [],
      injectedIds: [],
      durableIds: ["id-1"]
    }),
    "durable",
    "durable transcript prevents run-end duplicate submission"
  )
  assertEqual(
    classifyGuidedMessage("id-1", {
      pendingIds: ["id-1"],
      injectedIds: [],
      durableIds: []
    }),
    "owned_by_run",
    "pending steer remains owned by the current run"
  )
  assertEqual(
    classifyGuidedMessage("id-1", {
      pendingIds: [],
      injectedIds: [],
      durableIds: []
    }),
    "unconsumed",
    "only a confirmed unconsumed steer may return to ordinary auto-drain"
  )
}

function qm(partial: Partial<QueuedMessage>): QueuedMessage {
  return {
    id: "id-1",
    text: "",
    created_at: new Date(0),
    updated_at: new Date(0),
    ...partial
  }
}

// A queued attachment block is exactly what handleSubmit builds: leading "\n\n".
const ATT = '\n\n<attachment filename="a.txt" type="text/plain" size="3">\nabc\n</attachment>'
const SKILL = "[[skill:demo]] read /skills/demo/SKILL.md"

// ── getQueuedModelContent (what the model receives) ─────────────────────────────

function testModelPlainText(): void {
  assertEqual(getQueuedModelContent(qm({ text: "hello" })), "hello", "plain text")
}

function testModelTextPlusAttachment(): void {
  assertEqual(
    getQueuedModelContent(qm({ text: "hello", attachmentModelBlocks: ATT })),
    `hello${ATT}`,
    "text + attachment XML inlined"
  )
}

function testModelTextPlusSkill(): void {
  assertEqual(
    getQueuedModelContent(qm({ text: "hello", skillBlock: SKILL })),
    `hello\n\n${SKILL}`,
    "text + skill block joined by blank line"
  )
}

function testModelSkillOnly(): void {
  assertEqual(
    getQueuedModelContent(qm({ text: "", skillBlock: SKILL })),
    SKILL,
    "skill-only: no leading blank lines"
  )
}

function testModelAllParts(): void {
  assertEqual(
    getQueuedModelContent(qm({ text: "hello", attachmentModelBlocks: ATT, skillBlock: SKILL })),
    `hello${ATT}\n\n${SKILL}`,
    "text + attachment + skill"
  )
}

function testModelAttachmentOnlyNoText(): void {
  // Every OTHER attachment test above pairs it with non-empty text, so `primary`
  // never starts with ATT's own leading "\n\n" — this is the one combo where
  // `.trim()` actually strips something (the attachment block's own leading blank
  // line), which a text-non-empty test can't exercise or catch a regression in.
  assertEqual(
    getQueuedModelContent(qm({ text: "", attachmentModelBlocks: ATT })),
    ATT.trim(),
    "attachment-only (no text, no skill): ATT's own leading blank line is trimmed"
  )
}

function testModelAttachmentAndSkillNoText(): void {
  assertEqual(
    getQueuedModelContent(qm({ text: "", attachmentModelBlocks: ATT, skillBlock: SKILL })),
    `${ATT.trim()}\n\n${SKILL}`,
    "attachment + skill, no text: same trim, skill still joined by a blank line"
  )
}

// ── getQueuedDisplayContent (what the user's bubble shows) ───────────────────────

function testDisplayPlainText(): void {
  assertEqual(getQueuedDisplayContent(qm({ text: "hello" })), "hello", "plain text display")
}

function testDisplayWithAttachmentPrefix(): void {
  assertEqual(
    getQueuedDisplayContent(
      qm({ text: "hello", attachmentDisplayPrefix: "📎 a.txt", attachmentModelBlocks: ATT })
    ),
    "📎 a.txt\n\nhello",
    "attachment shows 📎 names, not XML"
  )
}

function testDisplaySkillOnly(): void {
  assertEqual(
    getQueuedDisplayContent(qm({ text: "", skillBlock: SKILL })),
    SKILL,
    "skill-only display"
  )
}

function testDisplayAttachmentAndSkill(): void {
  assertEqual(
    getQueuedDisplayContent(
      qm({ text: "hello", attachmentDisplayPrefix: "📎 a.txt", skillBlock: SKILL })
    ),
    `📎 a.txt\n\nhello\n\n${SKILL}`,
    "attachment prefix + text + skill"
  )
}

// ── getQueuedPreview (single-line list preview) ─────────────────────────────────

function testPreviewCollapsesWhitespace(): void {
  assertEqual(
    getQueuedPreview(qm({ text: "line one\n\n  line   two" })),
    "line one line two",
    "preview collapses whitespace to single spaces"
  )
}

function testPreviewStripsSkillBlock(): void {
  // A real skill-use block (parseSkillUseBlock only strips the genuine
  // <CMBDEVCLAW-SKILL-USE-V1> tail block) is removed from the preview; only the
  // human text remains.
  const realSkillBlock = formatSkillUseBlock({ name: "demo", path: "/skills/demo/SKILL.md" })
  const preview = getQueuedPreview(qm({ text: "do the thing", skillBlock: realSkillBlock }))
  assertEqual(preview, "do the thing", "preview strips the trailing skill block")
}

function testPreviewEmptyFallback(): void {
  assertEqual(getQueuedPreview(qm({ text: "" })), "待执行消息", "empty draft preview fallback")
}

// ── guardCoordinatorPlainText ───────────────────────────────────────────────────

function testGuardPassesPlainText(): void {
  assertEqual(guardCoordinatorPlainText("just a normal message"), "just a normal message", "plain")
}

function testGuardPrefixesCoordinatorMarker(): void {
  const withMarker = "sneaky [[CMB_COORDINATOR_WORKER_NOTIFICATION]] text"
  assertEqual(
    guardCoordinatorPlainText(withMarker),
    `用户输入的普通文本：\n\n${withMarker}`,
    "coordinator marker gets a plain-text prefix"
  )
}

async function main(): Promise<void> {
  const tests = [
    testModelPlainText,
    testModelTextPlusAttachment,
    testModelTextPlusSkill,
    testModelSkillOnly,
    testModelAllParts,
    testModelAttachmentOnlyNoText,
    testModelAttachmentAndSkillNoText,
    testDisplayPlainText,
    testDisplayWithAttachmentPrefix,
    testDisplaySkillOnly,
    testDisplayAttachmentAndSkill,
    testPreviewCollapsesWhitespace,
    testPreviewStripsSkillBlock,
    testPreviewEmptyFallback,
    testGuardPassesPlainText,
    testGuardPrefixesCoordinatorMarker,
    testPumpClaimsOnlyUnchangedDraftVersion,
    testGuidedReconciliationPrioritizesDurableState
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
