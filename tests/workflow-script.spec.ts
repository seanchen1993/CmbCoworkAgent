import { validateWorkflowScript, stripMarkdownFence } from "../src/main/agent/workflow/script.ts"
import {
  validateJsonSchemaValue,
  assertSupportedJsonSchema
} from "../src/main/agent/workflow/json-schema.ts"
import { extractOutputTokens } from "../src/main/agent/workflow/subagent.ts"
import {
  getWorkflowGlobMax,
  getWorkflowRunWallClockMs,
  isWorkflowSubagentThreadOf,
  resolveResumeArgsAndJournal,
  type PersistedWorkflowRun
} from "../src/main/agent/workflow/types.ts"
import { WORKFLOW_MODE_SYSTEM_PROMPT } from "../src/main/agent/workflow/prompts.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function expectThrows(fn: () => unknown, includes: string, msg: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    assert(
      text.includes(includes),
      `${msg} — expected message to include "${includes}", got "${text}"`
    )
    return
  }
  throw new Error(`${msg} — expected to throw`)
}

function testValidScript(): void {
  const { meta, body } = validateWorkflowScript(`export const meta = {
  name: "audit-bugs",
  description: "Find bugs",
  phases: [{ title: "Scan" }, { title: "Verify", detail: "refute" }]
}
phase("Scan")
const found = await agent("find bugs")
return { found }`)
  assert(meta.name === "audit-bugs", "meta.name parsed")
  assert(meta.phases?.length === 2, "phases parsed")
  assert(body.startsWith('phase("Scan")'), `body strips meta statement, got: ${body.slice(0, 30)}`)
}

function testBareConstMetaTolerated(): void {
  const { meta } = validateWorkflowScript(`const meta = { name: "x", description: "y" }\nreturn 1`)
  assert(meta.name === "x", "bare const meta (missing export) is tolerated")
}

function testMarkdownFenceStripped(): void {
  const fenced = '```js\nexport const meta = { name: "a", description: "b" }\nreturn 2\n```'
  assert(stripMarkdownFence(fenced).startsWith("export const meta"), "fence stripped")
  const { meta } = validateWorkflowScript(fenced)
  assert(meta.name === "a", "fenced script validates")
}

function testMetaMustBeFirst(): void {
  expectThrows(
    () =>
      validateWorkflowScript(`const x = 1\nexport const meta = { name: "a", description: "b" }`),
    "FIRST statement",
    "meta not first"
  )
}

function testMetaMustBePureLiteral(): void {
  expectThrows(
    () => validateWorkflowScript(`export const meta = { name: "a", description: someVar }`),
    "pure literal",
    "identifier in meta"
  )
  expectThrows(
    () => validateWorkflowScript(`export const meta = { name: "a", description: f() }`),
    "pure literal",
    "call in meta"
  )
  expectThrows(
    () => validateWorkflowScript('export const meta = { name: `a${1}`, description: "b" }'),
    "pure literal",
    "template interpolation in meta"
  )
  expectThrows(
    () => validateWorkflowScript(`export const meta = { ...spread, name: "a", description: "b" }`),
    "pure literal",
    "spread in meta"
  )
}

function testMetaSchemaValidation(): void {
  expectThrows(
    () => validateWorkflowScript(`export const meta = { description: "b" }\nreturn 1`),
    "invalid meta",
    "missing name"
  )
  expectThrows(
    () => validateWorkflowScript(`export const meta = { name: "", description: "b" }\nreturn 1`),
    "invalid meta",
    "empty name"
  )
  expectThrows(
    () =>
      validateWorkflowScript(
        `export const meta = { name: "a", description: "b", phases: [{ detail: "no title" }] }\nreturn 1`
      ),
    "invalid meta",
    "phase without title"
  )
}

function testReservedKeysRejected(): void {
  expectThrows(
    () =>
      validateWorkflowScript(
        `export const meta = { name: "a", description: "b", "__proto__": { x: 1 } }\nreturn 1`
      ),
    "reserved object key",
    "__proto__ key"
  )
}

function testImportExportRejectedInBody(): void {
  expectThrows(
    () =>
      validateWorkflowScript(
        `export const meta = { name: "a", description: "b" }\nimport fs from "fs"\nreturn 1`
      ),
    "import/export statements are not allowed",
    "import in body"
  )
}

function testSyntaxErrorReported(): void {
  expectThrows(
    () => validateWorkflowScript(`export const meta = { name: "a", description: "b" }\nconst {`),
    "syntax error",
    "syntax error surfaces"
  )
  // Model-actionable: the message must show the OFFENDING LINE with a position marker
  // and a fix-and-retry hint — not just acorn's bare "(line:col)".
  const broken = `export const meta = { name: "a", description: "b" }\nreturn { a: 1, b: }`
  expectThrows(() => validateWorkflowScript(broken), "»HERE»", "marks the error position inline")
  expectThrows(() => validateWorkflowScript(broken), "return { a", "shows the offending line content")
  expectThrows(
    () => validateWorkflowScript(broken),
    "Fix this syntax error and call the workflow tool again",
    "tells the model to fix and retry"
  )
}

function testJsonSchemaValidator(): void {
  const schema = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" }, line: { type: "integer" } },
          required: ["file"]
        }
      },
      level: { enum: ["low", "high"] }
    },
    required: ["todos"]
  }
  assert(
    validateJsonSchemaValue(schema, { todos: [{ file: "a.ts", line: 3 }], level: "low" }).length ===
      0,
    "valid value passes"
  )
  const missing = validateJsonSchemaValue(schema, {})
  assert(
    missing.some((e) => e.includes('missing required property "todos"')),
    "missing required reported"
  )
  const wrongType = validateJsonSchemaValue(schema, { todos: [{ file: 42 }] })
  assert(
    wrongType.some((e) => e.includes("expected type string")),
    `wrong type reported: ${wrongType}`
  )
  const badEnum = validateJsonSchemaValue(schema, { todos: [], level: "mid" })
  assert(
    badEnum.some((e) => e.includes("must be one of")),
    "enum mismatch reported"
  )
  const intCheck = validateJsonSchemaValue(
    { type: "object", properties: { n: { type: "integer" } } },
    { n: 1.5 }
  )
  assert(intCheck.length === 1, "non-integer rejected")

  // nullable: true (OpenAPI style) accepts null; without it null is rejected.
  const nullableSchema = { type: "object", properties: { x: { type: "string", nullable: true } } }
  assert(validateJsonSchemaValue(nullableSchema, { x: null }).length === 0, "nullable accepts null")
  assert(
    validateJsonSchemaValue({ type: "object", properties: { x: { type: "string" } } }, { x: null })
      .length === 1,
    "non-nullable rejects null"
  )
  // type arrays also express nullability.
  assert(
    validateJsonSchemaValue(
      { type: "object", properties: { x: { type: ["string", "null"] } } },
      { x: null }
    ).length === 0,
    "type array with null accepts null"
  )

  // pattern is enforced; an invalid pattern fails loud instead of passing.
  const patternSchema = { type: "object", properties: { id: { type: "string", pattern: "^wf_" } } }
  assert(validateJsonSchemaValue(patternSchema, { id: "wf_abc" }).length === 0, "pattern matches")
  assert(
    validateJsonSchemaValue(patternSchema, { id: "nope" }).some((e) => e.includes("pattern")),
    "pattern mismatch reported"
  )

  // additionalProperties: schema form validates undeclared keys.
  const apSchema = {
    type: "object",
    properties: { known: { type: "string" } },
    additionalProperties: { type: "number" }
  }
  assert(
    validateJsonSchemaValue(apSchema, { known: "x", extra: 3 }).length === 0,
    "additionalProperties schema accepts conforming extras"
  )
  assert(
    validateJsonSchemaValue(apSchema, { known: "x", extra: "bad" }).some((e) =>
      e.includes("expected type number")
    ),
    "additionalProperties schema rejects non-conforming extras"
  )

  // Prototype-member key names (toString/constructor/…) must NOT bypass validation:
  // a plain `key in obj` walks Object.prototype, so they'd be treated as declared
  // (slipping past additionalProperties:false) and `required:["toString"]` would be
  // falsely satisfied. Ownership-only checks must flag them.
  const strictSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
    required: ["a"]
  }
  assert(
    validateJsonSchemaValue(strictSchema, { a: "x", toString: "EVIL", constructor: "E2" }).some(
      (e) => e.includes("toString")
    ),
    "additionalProperties:false flags a prototype-named extra key (toString)"
  )
  assert(
    validateJsonSchemaValue({ type: "object", properties: {}, required: ["toString"] }, {}).some(
      (e) => e.includes("required")
    ),
    "required:[toString] is NOT vacuously satisfied by Object.prototype.toString"
  )
  assert(
    validateJsonSchemaValue(
      { type: "object", properties: {}, required: ["toString"] },
      {
        toString: "own"
      }
    ).length === 0,
    "required:[toString] IS satisfied by an OWN toString property"
  )

  // A schema with `required`/`properties` but NO explicit `type` is implicitly
  // an object schema — a non-object value must NOT vacuously pass (the hole).
  const implicitObject = { required: ["x"], properties: { x: { type: "string" } } }
  assert(
    validateJsonSchemaValue(implicitObject, { x: "ok" }).length === 0,
    "implicit-object schema accepts a conforming object"
  )
  assert(
    validateJsonSchemaValue(implicitObject, { y: 1 }).some((e) => e.includes("required")),
    "implicit-object schema still enforces required on an object"
  )
  assert(
    validateJsonSchemaValue(implicitObject, "not-an-object").some((e) =>
      e.includes("expected an object")
    ),
    "implicit-object schema rejects a non-object value (closes the vacuous-pass hole)"
  )
  assert(
    validateJsonSchemaValue({ required: ["x"] }, 42).some((e) => e.includes("expected an object")),
    "bare required-only schema rejects a non-object"
  )

  // anyOf = at least one; oneOf = EXACTLY one (these must not be conflated).
  const anyOfSchema = { anyOf: [{ type: "string" }, { type: "number" }] }
  assert(validateJsonSchemaValue(anyOfSchema, "x").length === 0, "anyOf accepts one match")
  assert(validateJsonSchemaValue(anyOfSchema, true).length > 0, "anyOf rejects zero matches")

  const oneOfSchema = { oneOf: [{ type: "string" }, { type: "number" }] }
  assert(validateJsonSchemaValue(oneOfSchema, "x").length === 0, "oneOf accepts exactly one match")
  assert(validateJsonSchemaValue(oneOfSchema, true).length > 0, "oneOf rejects zero matches")
  // A value matching MULTIPLE oneOf branches must FAIL (the conflation bug).
  const ambiguousOneOf = { oneOf: [{ type: "number" }, { minimum: 0 }] }
  assert(
    validateJsonSchemaValue(ambiguousOneOf, 5).some((e) => e.includes("EXACTLY ONE")),
    "oneOf rejects a value matching more than one branch"
  )

  // additionalProperties:false WITHOUT properties must still reject extra keys
  // (was a vacuous-accept hole).
  const closedNoProps = { type: "object", additionalProperties: false }
  assert(
    validateJsonSchemaValue(closedNoProps, { extra: 1 }).some((e) =>
      e.includes("additionalProperties is false")
    ),
    "additionalProperties:false rejects extras even with no declared properties"
  )
  assert(
    validateJsonSchemaValue(closedNoProps, {}).length === 0,
    "additionalProperties:false accepts an empty object"
  )

  // const/enum are assertions ANDed with their siblings — they must NOT short-
  // circuit the other constraints (was a vacuous-accept hole).
  assert(
    validateJsonSchemaValue({ enum: ["a", "longer"], minLength: 5 }, "a").some((e) =>
      e.includes("minLength")
    ),
    "enum does not short-circuit a sibling minLength"
  )
  assert(
    validateJsonSchemaValue({ enum: ["a", "longer"], minLength: 5 }, "longer").length === 0,
    "enum + minLength accepts a value satisfying both"
  )
  assert(
    validateJsonSchemaValue({ const: "ab", minLength: 5 }, "ab").some((e) =>
      e.includes("minLength")
    ),
    "const does not short-circuit a sibling minLength"
  )
  // A plain enum/const with no siblings must still accept its members cleanly.
  assert(
    validateJsonSchemaValue({ enum: ["a", "b"] }, "a").length === 0,
    "plain enum still accepts a member with no spurious sibling errors"
  )
  assert(
    validateJsonSchemaValue({ const: 5 }, 5).length === 0,
    "plain const still accepts the constant with no spurious sibling errors"
  )

  // anyOf/oneOf are applicators ANDed with siblings — same no-short-circuit rule
  // as const/enum (was the last remaining sibling-shadowing hole).
  assert(
    validateJsonSchemaValue({ anyOf: [{ type: "string" }], minLength: 5 }, "a").some((e) =>
      e.includes("minLength")
    ),
    "anyOf does not short-circuit a sibling minLength"
  )
  assert(
    validateJsonSchemaValue({ oneOf: [{ type: "string" }], minLength: 5 }, "a").some((e) =>
      e.includes("minLength")
    ),
    "oneOf does not short-circuit a sibling minLength"
  )
  assert(
    validateJsonSchemaValue({ anyOf: [{ type: "string" }], minLength: 5 }, "longer").length === 0,
    "anyOf + minLength accepts a value satisfying both"
  )
  // Plain anyOf with no siblings must still validate cleanly (no spurious errors).
  assert(
    validateJsonSchemaValue({ anyOf: [{ type: "string" }, { type: "number" }] }, "a").length === 0,
    "plain anyOf still accepts a matching value with no spurious sibling errors"
  )

  // Whitelist fail-closed: ANY keyword we don't implement must throw at preflight,
  // not silently pass (which would let invalid structured output through). This
  // covers the long tail a blocklist would miss — exclusiveMinimum, multipleOf,
  // unevaluatedProperties, prefixItems, $ref, allOf, not, …
  for (const kw of [
    "multipleOf",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "contains",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "unevaluatedProperties",
    "prefixItems",
    "$ref",
    "allOf",
    "not",
    "patternProperties",
    "if",
    "propertyNames",
    "dependentRequired",
    "someFutureKeyword"
  ]) {
    expectThrows(
      () =>
        assertSupportedJsonSchema({
          type: "object",
          [kw]: kw === "uniqueItems" ? true : 1
        }),
      kw,
      `unsupported keyword ${kw} fails closed`
    )
  }
  // Annotation keywords are allowed (ignored, not validated) — spec-compliant.
  assertSupportedJsonSchema({ type: "string", format: "date-time" })
  assertSupportedJsonSchema({
    type: "object",
    title: "T",
    description: "d",
    default: {},
    examples: [],
    properties: { x: { type: "string" } }
  })

  // Supported keywords with WRONG-TYPED values must also fail closed — otherwise
  // they validate vacuously (e.g. required:"x" enforces nothing).
  expectThrows(() => assertSupportedJsonSchema({ type: 123 }), "type", "type must be a type name")
  expectThrows(
    () => assertSupportedJsonSchema({ type: "object", required: "x" }),
    "required",
    "required must be a string array"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "object", additionalProperties: "nope" }),
    "additionalProperties",
    "additionalProperties must be a boolean or schema"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "string", enum: "x" }),
    "enum",
    "enum must be an array"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "string", pattern: 5 }),
    "pattern",
    "pattern must be a string"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "number", minimum: "x" }),
    "minimum",
    "minimum must be a number"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "string", nullable: "yes" }),
    "nullable",
    "nullable must be a boolean"
  )
  // Edge values that look structurally valid but neuter the constraint must also
  // fail closed (empty type array, array-form properties, null items).
  expectThrows(
    () => assertSupportedJsonSchema({ type: [] }),
    "type",
    "empty type array fails closed"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "object", properties: [] }),
    "properties",
    "array-form properties fails closed"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ type: "array", items: null }),
    "items",
    "null items fails closed"
  )
  // A valid type array is still accepted.
  assertSupportedJsonSchema({ type: ["string", "null"] })

  // A boolean `true` sub-schema in anyOf/oneOf means "match anything" (JSON
  // Schema semantics), not "no match". Preflight allows `true`, so validation
  // must honor it.
  assertSupportedJsonSchema({ anyOf: [true] })
  assert(
    validateJsonSchemaValue({ anyOf: [true] }, 42).length === 0,
    "anyOf:[true] matches any value"
  )
  assert(
    validateJsonSchemaValue({ oneOf: [true] }, "x").length === 0,
    "oneOf:[true] matches any value (exactly one branch)"
  )
  assert(
    validateJsonSchemaValue({ oneOf: [true, { type: "string" }] }, "x").some((e) =>
      e.includes("EXACTLY ONE")
    ),
    "oneOf:[true, string] rejects a string (matches both branches)"
  )

  // anyOf AND oneOf together: both must be enforced (the oneOf must not be
  // shadowed by the anyOf).
  const bothApplicators = { anyOf: [true], oneOf: [{ type: "number" }] }
  assert(
    validateJsonSchemaValue(bothApplicators, 5).length === 0,
    "anyOf+oneOf: a number satisfies both"
  )
  assert(
    validateJsonSchemaValue(bothApplicators, "x").some((e) => e.includes("oneOf")),
    "anyOf+oneOf: a string passes anyOf but fails the (no-longer-shadowed) oneOf"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ anyOf: [true], oneOf: [{ multipleOf: 2 }] }),
    "multipleOf",
    "oneOf sub-schemas are preflighted even when anyOf is also present"
  )

  // Length/count bounds must be non-negative integers.
  for (const kw of ["minLength", "maxLength", "minItems", "maxItems"]) {
    expectThrows(
      () => assertSupportedJsonSchema({ type: "string", [kw]: -1 }),
      kw,
      `${kw}:-1 fails closed (must be non-negative integer)`
    )
    expectThrows(
      () => assertSupportedJsonSchema({ type: "string", [kw]: 1.5 }),
      kw,
      `${kw}:1.5 fails closed (must be an integer)`
    )
  }
  // minimum/maximum still accept any finite number (including negative/fractional).
  assertSupportedJsonSchema({ type: "number", minimum: -2.5, maximum: 10 })
}

function testOutputTokenSummation(): void {
  // extractOutputTokens must SUM output_tokens across every AI message in the
  // snapshot — not read only the last. This is what makes the structured-output
  // nudge safe: the round-2 snapshot is cumulative (same thread), so round-1's
  // AI message is still present and its tokens are counted.
  const snapshot = {
    messages: [
      { _getType: () => "human", content: "do it" },
      { _getType: () => "ai", content: "round 1", usage_metadata: { output_tokens: 12 } },
      { _getType: () => "human", content: "nudge" },
      { _getType: () => "ai", content: "round 2", usage_metadata: { output_tokens: 30 } }
    ]
  }
  assert(
    extractOutputTokens(snapshot, "round 2") === 42,
    `sums output_tokens across all AI messages (12 + 30), got ${extractOutputTokens(snapshot, "round 2")}`
  )
  // No usage metadata anywhere → falls back to a chars/4 estimate of final text.
  const noUsage = { messages: [{ _getType: () => "ai", content: "x" }] }
  assert(extractOutputTokens(noUsage, "abcd") === 1, "chars/4 fallback when no usage reported")

  // Mixed: some messages report usage, some don't → the unreported ones are
  // estimated (per-message fill), not discarded. 20 reported + ceil(8/4)=2.
  const mixed = {
    messages: [
      { _getType: () => "ai", content: "tool round", usage_metadata: { output_tokens: 20 } },
      { _getType: () => "ai", content: "12345678" } // no usage → 8 chars / 4 = 2
    ]
  }
  assert(
    extractOutputTokens(mixed, "12345678") === 22,
    `per-message fill: 20 reported + 2 estimated = 22, got ${extractOutputTokens(mixed, "12345678")}`
  )

  // CJK counts ~1 token/char (chars/4 would say 1 for 4 Chinese chars).
  const cjk = { messages: [{ _getType: () => "ai", content: "你好世界" }] }
  assert(
    extractOutputTokens(cjk, "你好世界") === 4,
    `4 CJK chars ≈ 4 tokens, got ${extractOutputTokens(cjk, "你好世界")}`
  )
}

function testOversizedScriptRejected(): void {
  const validHead = `export const meta = { name: "big", description: "x", phases: [{ title: "S" }] }\n`
  // Pad well past the 512 KiB pre-parse cap; the byte-length gate must fire
  // before acorn ever runs (a synchronous parse of a huge script freezes the UI).
  const oversized = validHead + "// " + "x".repeat(524_288)
  expectThrows(
    () => validateWorkflowScript(oversized),
    "too large",
    "script over 512 KiB is rejected before parse"
  )
  // A script comfortably under the cap still validates — the gate isn't over-eager.
  const underCap = validHead + `// ${"x".repeat(1000)}\nreturn 1`
  assert(validateWorkflowScript(underCap).meta.name === "big", "under-cap script still validates")
}

function testInactivityWindowFlooredAboveAgentTimeout(): void {
  const origRun = process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
  const origAgent = process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS
  try {
    // A window configured BELOW the per-subagent timeout would kill slow-but-
    // healthy agents; the cross-check must floor it above the agent timeout.
    process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS = "600000" // 10 min
    process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = "60000" // 60s — misconfigured
    assert(
      getWorkflowRunWallClockMs() >= 660_000,
      `window must be floored above the agent timeout, got ${getWorkflowRunWallClockMs()}`
    )
    // A window comfortably above the agent timeout is honored as configured.
    process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = "1800000" // 30 min
    assert(getWorkflowRunWallClockMs() === 1_800_000, "sane window honored as-is")
  } finally {
    if (origRun === undefined) delete process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
    else process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = origRun
    if (origAgent === undefined) delete process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS
    else process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS = origAgent
  }
}

function testWorkflowSubagentThreadMatch(): void {
  // #3 regression: hasPendingWorkflowApproval must match the subagent's RUNTIME
  // thread (`<parent>__wf_<run>_a<i>`), not the parent routing thread. The original
  // bug matched the approval entry's `threadId` (= parent), so the prefix never hit
  // and the inactivity-watchdog approval exemption was dead code.
  const parent = "thread-abc"
  assert(
    isWorkflowSubagentThreadOf(`${parent}__wf_run123_a0`, parent),
    "a subagent runtime thread matches its parent"
  )
  assert(
    isWorkflowSubagentThreadOf(`${parent}__wf_run123_a5_r2`, parent),
    "a retried subagent thread matches too"
  )
  // The PARENT's own thread (the approval entry's routing threadId) must NOT match,
  // or the parent's non-workflow approvals would wrongly count as workflow-blocked.
  assert(
    !isWorkflowSubagentThreadOf(parent, parent),
    "the parent's own thread does NOT match (no __wf_ segment)"
  )
  assert(
    !isWorkflowSubagentThreadOf("thread-other__wf_run_a0", parent),
    "another thread's subagent does NOT match"
  )
  // runId-scoped: two concurrent runs share `parent`, so the watchdog must scope
  // its "awaiting approval" check to ITS run — else run A's pending approval would
  // suppress run B's hung-run timeout.
  const subA = `${parent}__wf_aaa111_a0`
  const subB = `${parent}__wf_bbb222_a3_r2`
  assert(
    isWorkflowSubagentThreadOf(subA, parent, "wf_aaa111") &&
      !isWorkflowSubagentThreadOf(subB, parent, "wf_aaa111"),
    "runId-scoped match accepts THIS run's subagent and rejects a sibling run's"
  )
  assert(
    isWorkflowSubagentThreadOf(subB, parent, "bbb222"),
    "runId scope tolerates a runId passed without the wf_ prefix"
  )
  assert(
    isWorkflowSubagentThreadOf(subA, parent) && isWorkflowSubagentThreadOf(subB, parent),
    "without a runId the match stays run-agnostic (back-compat)"
  )
}

function testWorkflowModePromptDistinguishesTaskVsWorkflow(): void {
  // Workflow mode keeps the `task` tool (parity with CC, which has Workflow +
  // Agent side by side) but the prompt must steer fan-out to `workflow` rather
  // than hand-rolled repeated `task` calls (which skip approval/journal/resume).
  assert(
    WORKFLOW_MODE_SYSTEM_PROMPT.includes("`task` is ONE inline subagent") &&
      WORKFLOW_MODE_SYSTEM_PROMPT.includes("`workflow` is FAN-OUT"),
    "workflow-mode prompt explicitly distinguishes the task tool from workflow"
  )
  assert(
    WORKFLOW_MODE_SYSTEM_PROMPT.includes("hand-roll a fan-out with repeated `task` calls"),
    "workflow-mode prompt tells the model not to fan out via repeated task calls"
  )
}

function testResumeArgsAndJournal(): void {
  const baseRun = {
    runId: "wf_old",
    scriptSha256: "sha-A",
    args: { topic: "x" },
    journal: [{ index: 0, hash: "h0", result: "r0" }]
  } as unknown as PersistedWorkflowRun

  // #1: resume with NO args → reuse the original run's args (the UI/notification
  // resume with just {resumeFromRunId}; an args-dependent script must not see
  // undefined and mis-branch).
  const reuse = resolveResumeArgsAndJournal(undefined, baseRun, "sha-A")
  assert(
    JSON.stringify(reuse.effectiveArgs) === JSON.stringify({ topic: "x" }),
    `resume reuses original args, got ${JSON.stringify(reuse.effectiveArgs)}`
  )
  assert(reuse.invalidatedReason === null, "same script+args keeps the journal")
  assert(reuse.effectiveResumeJournal?.length === 1, "journal preserved on plain resume")

  // Explicit SAME args → not spuriously invalidated.
  const same = resolveResumeArgsAndJournal({ topic: "x" }, baseRun, "sha-A")
  assert(same.invalidatedReason === null, "explicit same args keeps the journal")

  // #2: CHANGED args → drop the journal (else append-only's index-replace would
  // clobber a cached entry under a reused callIndex and lose it next resume).
  const changed = resolveResumeArgsAndJournal({ topic: "y" }, baseRun, "sha-A")
  assert(changed.invalidatedReason === "args", "changed args invalidates the journal")
  assert(changed.effectiveResumeJournal === undefined, "changed args drops the journal")
  assert(
    JSON.stringify(changed.effectiveArgs) === JSON.stringify({ topic: "y" }),
    "changed args uses the new args"
  )

  // Changed script → drop the journal (script reason takes precedence).
  const newScript = resolveResumeArgsAndJournal(undefined, baseRun, "sha-B")
  assert(newScript.invalidatedReason === "script", "changed script invalidates the journal")
  assert(newScript.effectiveResumeJournal === undefined, "changed script drops the journal")

  // Fresh launch (no resume run) → input args pass through, no journal.
  const fresh = resolveResumeArgsAndJournal({ a: 1 }, null, "sha-A")
  assert(fresh.invalidatedReason === null, "fresh launch not invalidated")
  assert(fresh.effectiveResumeJournal === undefined, "fresh launch has no journal")
  assert(JSON.stringify(fresh.effectiveArgs) === JSON.stringify({ a: 1 }), "fresh uses input args")

  // P2: undefined → null is a REAL change (a script distinguishes args===undefined
  // from args===null) — it must drop the journal, not be collapsed to "same".
  // Original run never passed args; resume explicitly passes null.
  const undefRun = {
    runId: "wf_u",
    scriptSha256: "sha-A",
    journal: [{ index: 0, hash: "h0", result: "r0" }]
    // args intentionally absent (undefined)
  } as unknown as PersistedWorkflowRun
  const nullArgs = resolveResumeArgsAndJournal(null, undefRun, "sha-A")
  assert(nullArgs.effectiveArgs === null, "explicit null is used as the args")
  assert(
    nullArgs.invalidatedReason === "args",
    `undefined→null args must invalidate, got ${nullArgs.invalidatedReason}`
  )
  assert(nullArgs.effectiveResumeJournal === undefined, "undefined→null drops the journal")
}

function testJsonSchemaReDoSGuard(): void {
  // #9: a script-supplied schema.pattern is RegExp.test()'d synchronously on the
  // main process; a nested-quantifier pattern can ReDoS. assertSupportedJsonSchema
  // rejects the common stacked-quantifier shapes up front, and the validator caps
  // the input length it will test (heuristic, not RE2-grade — documented).
  for (const evil of ["(a+)+$", "(a*)*", "(.*)+", "((ab)+)*", "(\\d+)+", "(a?)+$", "(.?)+$"]) {
    let threw = false
    try {
      assertSupportedJsonSchema({ type: "string", pattern: evil })
    } catch {
      threw = true
    }
    assert(threw, `ReDoS-prone pattern ${evil} must be rejected at compile time`)
  }
  // Legitimate patterns still pass — including char classes whose +/*/? are
  // literals (no false positive) and a group under a BOUNDED ? (can't blow up).
  for (const ok of [
    "^[a-z]+$",
    "^\\d{3}-\\d{4}$",
    "(\\d{3})-(\\d{4})",
    "^https?://",
    "^([A-Za-z0-9+/_-])+$",
    "^([+])+$",
    "(a+)?"
  ]) {
    assertSupportedJsonSchema({ type: "string", pattern: ok }) // must not throw
  }
  // The validator caps the input length it will regex-test (blast-radius bound).
  const longErrors = validateJsonSchemaValue(
    { type: "string", pattern: "^a+$" },
    "a".repeat(100_001)
  )
  assert(
    longErrors.some((e) => e.includes("too long")),
    "an over-long string is reported, not regex-tested"
  )
  // Normal-length strings still validate against the pattern (match + non-match).
  assert(
    validateJsonSchemaValue({ type: "string", pattern: "^a+$" }, "aaa").length === 0,
    "a normal string still matches its pattern"
  )
  assert(
    validateJsonSchemaValue({ type: "string", pattern: "^a+$" }, "bbb").length === 1,
    "a non-matching normal string still fails the pattern"
  )
}

function testGlobMaxClamp(): void {
  // #1(P3): the test-only env knob is guarded like the timeout knobs — a bad value
  // can neither DISABLE the cap (Infinity / negative / zero) nor RAISE it in prod.
  const prev = process.env.CMB_WORKFLOW_GLOB_MAX
  try {
    delete process.env.CMB_WORKFLOW_GLOB_MAX
    assert(getWorkflowGlobMax() === 10_000, "default cap when unset")
    process.env.CMB_WORKFLOW_GLOB_MAX = "3"
    assert(getWorkflowGlobMax() === 3, "a valid smaller override applies")
    process.env.CMB_WORKFLOW_GLOB_MAX = "-1"
    assert(
      getWorkflowGlobMax() === 10_000,
      "negative falls back to default (never disables the cap)"
    )
    process.env.CMB_WORKFLOW_GLOB_MAX = "0"
    assert(getWorkflowGlobMax() === 10_000, "zero falls back to default")
    process.env.CMB_WORKFLOW_GLOB_MAX = "Infinity"
    assert(
      getWorkflowGlobMax() === 10_000,
      "Infinity (non-integer to parseInt) falls back to default"
    )
    process.env.CMB_WORKFLOW_GLOB_MAX = "abc"
    assert(getWorkflowGlobMax() === 10_000, "non-numeric falls back to default")
    process.env.CMB_WORKFLOW_GLOB_MAX = "99999"
    assert(getWorkflowGlobMax() === 10_000, "cannot raise above the default ceiling")
    process.env.CMB_WORKFLOW_GLOB_MAX = "2.9"
    assert(getWorkflowGlobMax() === 2, "fractional truncates via parseInt")
  } finally {
    if (prev === undefined) delete process.env.CMB_WORKFLOW_GLOB_MAX
    else process.env.CMB_WORKFLOW_GLOB_MAX = prev
  }
}

const tests = [
  testWorkflowModePromptDistinguishesTaskVsWorkflow,
  testValidScript,
  testBareConstMetaTolerated,
  testMarkdownFenceStripped,
  testMetaMustBeFirst,
  testMetaMustBePureLiteral,
  testMetaSchemaValidation,
  testReservedKeysRejected,
  testImportExportRejectedInBody,
  testSyntaxErrorReported,
  testJsonSchemaValidator,
  testOutputTokenSummation,
  testOversizedScriptRejected,
  testInactivityWindowFlooredAboveAgentTimeout,
  testWorkflowSubagentThreadMatch,
  testResumeArgsAndJournal,
  testGlobMaxClamp,
  testJsonSchemaReDoSGuard
]

for (const test of tests) {
  test()
}
console.log(`PASS workflow-script (${tests.length} tests)`)
