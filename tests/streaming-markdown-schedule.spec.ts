import assert from "node:assert/strict"
import {
  buildStreamingMarkdownPreview,
  buildStreamingMarkdownRenderPlan,
  getStreamingMarkdownDelayMs,
  MAX_STREAMING_MARKDOWN_RENDER_CHARS
} from "../src/renderer/src/lib/streaming-markdown-schedule"

assert.equal(getStreamingMarkdownDelayMs(0), 50)
assert.equal(getStreamingMarkdownDelayMs(3_200), 50)
assert.equal(getStreamingMarkdownDelayMs(6_400), 100)
assert.equal(getStreamingMarkdownDelayMs(32_000), 500)
assert.equal(getStreamingMarkdownDelayMs(64_000), 1000)
assert.equal(getStreamingMarkdownDelayMs(1_000_000), 1000)
assert.equal(getStreamingMarkdownDelayMs(Number.NaN), 50)

const boundedText = `${"head ".repeat(2_000)}\n\n${"middle ".repeat(30_000)}\n\n${"tail ".repeat(20_000)}`
const preview = buildStreamingMarkdownPreview(boundedText)
assert.ok(preview.omittedCharacters > 0)
assert.ok(preview.head.length + preview.tail.length <= MAX_STREAMING_MARKDOWN_RENDER_CHARS)
assert.equal(boundedText.startsWith(preview.head), true)
assert.equal(boundedText.endsWith(preview.tail), true)

const appendedPreview = buildStreamingMarkdownPreview(`${boundedText}more tail`)
assert.equal(appendedPreview.head, preview.head, "the parsed head must stay stable while appending")
assert.ok(appendedPreview.head.length + appendedPreview.tail.length <= MAX_STREAMING_MARKDOWN_RENDER_CHARS)

const completedPlan = buildStreamingMarkdownRenderPlan(boundedText, false, false)
assert.equal(completedPlan.renderFullDocument, false)
assert.ok(
  completedPlan.head.length + completedPlan.tail.length <=
    MAX_STREAMING_MARKDOWN_RENDER_CHARS,
  "completion must not synchronously restore an unbounded Markdown document"
)
assert.ok(completedPlan.omittedCharacters > 0)

const expandedPlan = buildStreamingMarkdownRenderPlan(boundedText, false, true)
assert.equal(expandedPlan.renderFullDocument, true)
assert.equal(expandedPlan.head, boundedText)
assert.equal(expandedPlan.tail, "")

const streamingExpandedPlan = buildStreamingMarkdownRenderPlan(boundedText, true, true)
assert.equal(
  streamingExpandedPlan.renderFullDocument,
  false,
  "a new stream must stay bounded even if the prior completed text was expanded"
)

const shortText = "# short\n\nanswer"
assert.deepEqual(buildStreamingMarkdownPreview(shortText), {
  head: shortText,
  tail: "",
  omittedCharacters: 0
})
assert.equal(buildStreamingMarkdownRenderPlan(shortText, false, false).renderFullDocument, true)

console.log("streaming markdown schedule tests passed")
