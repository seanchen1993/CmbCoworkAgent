import { AIMessage } from "@langchain/core/messages"
import { NodeInterrupt } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { validateWorkflowScript, stripMarkdownFence } from "../src/main/agent/workflow/script.ts"
import {
  validateJsonSchemaValue,
  assertSupportedJsonSchema
} from "../src/main/agent/workflow/json-schema.ts"
import {
  buildStructuredOutputRepairErrors,
  createStructuredOutputTool,
  exampleStructuredOutputToolInput,
  extractOutputTokens,
  runWorkflowSubagent,
  structuredOutputToolInputExampleJson
} from "../src/main/agent/workflow/subagent.ts"
import {
  describeWorkflowError,
  getWorkflowAgentTimeoutMs,
  getWorkflowGlobMax,
  getWorkflowRunWallClockMs,
  isWorkflowSubagentThreadOf,
  resolveResumeArgsAndJournal,
  type PersistedWorkflowRun
} from "../src/main/agent/workflow/types.ts"
import {
  WORKFLOW_MODE_SYSTEM_PROMPT,
  buildWorkflowSubagentStructuredPrompt
} from "../src/main/agent/workflow/prompts.ts"

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

async function expectRejects(
  fn: () => Promise<unknown>,
  includes: string,
  msg: string
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    assert(
      text.includes(includes),
      `${msg} — expected message to include "${includes}", got "${text}"`
    )
    return
  }
  throw new Error(`${msg} — expected to reject`)
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

function testNondeterministicApisRejectedBeforeRun(): void {
  const head = `export const meta = { name: "a", description: "b" }\n`
  const rejected: Array<[string, string, string]> = [
    [`return new Date().toISOString()`, "new Date() is unavailable", "argless new Date rejected before launch"],
    [`return Date()`, "Date() is unavailable", "Date() rejected before launch"],
    [`return Date.now()`, "Date.now() is unavailable", "Date.now rejected before launch"],
    [`return Date["now"]()`, "Date.now() is unavailable", "computed Date.now rejected before launch"],
    [`return Date.now.call(null)`, "Date.now() is unavailable", "Date.now.call rejected before launch"],
    [`return Date.now.apply(null)`, "Date.now() is unavailable", "Date.now.apply rejected before launch"],
    [`return (0, Date.now)()`, "Date.now() is unavailable", "sequence Date.now call rejected before launch"],
    [`return (0, Date.now.call)(null)`, "Date.now() is unavailable", "sequence Date.now.call rejected before launch"],
    [`return Date.now.bind(null)()`, "Date.now() is unavailable", "Date.now.bind rejected before launch"],
    [`return (0, Date.now.bind(null))()`, "Date.now() is unavailable", "sequence Date.now.bind rejected before launch"],
    [`return Date.call(null)`, "Date() is unavailable", "Date.call rejected before launch"],
    [`return Date.bind(null)()`, "Date() is unavailable", "Date.bind rejected before launch"],
    [`return Math.random()`, "Math.random() is unavailable", "Math.random rejected before launch"],
    [`return Math["random"]()`, "Math.random() is unavailable", "computed Math.random rejected before launch"],
    [`return Math.random.call(null)`, "Math.random() is unavailable", "Math.random.call rejected before launch"],
    [`return Math.random.bind(null)()`, "Math.random() is unavailable", "Math.random.bind rejected before launch"],
    [`return (0, Math.random)()`, "Math.random() is unavailable", "sequence Math.random rejected before launch"],
    [`return globalThis.Date.now()`, "Date.now() is unavailable", "globalThis Date.now rejected before launch"],
    [`return globalThis.Math.random()`, "Math.random() is unavailable", "globalThis Math.random rejected before launch"],
    [`return globalThis.Date.now.call(null)`, "Date.now() is unavailable", "globalThis Date.now.call rejected before launch"],
    [`return globalThis.Date.now.bind(null)()`, "Date.now() is unavailable", "globalThis Date.now.bind rejected before launch"],
    [`return globalThis.Math.random.apply(null)`, "Math.random() is unavailable", "globalThis Math.random.apply rejected before launch"],
    [`return new globalThis.Date()`, "new Date() is unavailable", "globalThis new Date rejected before launch"],
    [`return new Date(1).constructor.now()`, "Date.now() is unavailable", "Date constructor bypass rejected before launch"],
    [`return Date.prototype.constructor.now()`, "Date.now() is unavailable", "Date prototype constructor bypass rejected"],
    [
      `return globalThis.Date.prototype.constructor.now()`,
      "Date.now() is unavailable",
      "globalThis Date prototype constructor bypass rejected"
    ],
    [`function f(Date){}; return Date.now()`, "Date.now() is unavailable", "function param does not shadow outer Date"],
    [
      `function f(x = Date.now()) { const Date = { now: () => 1 }; return x } return f()`,
      "Date.now() is unavailable",
      "function body Date does not shadow parameter default Date"
    ],
    [`if (true) { const Date = () => 1 } return Date()`, "Date() is unavailable", "block Date does not shadow outer Date"],
    [`const f = function Date(){}; return Date.now()`, "Date.now() is unavailable", "function expression name is local only"],
    [
      `try {} catch (globalThis) {} return globalThis.Math.random()`,
      "Math.random() is unavailable",
      "catch param does not shadow outer globalThis"
    ],
    [
      `class C { static { var Date = { now: () => 1 } } } return Date.now()`,
      "Date.now() is unavailable",
      "static block var Date does not shadow outer Date"
    ],
    [
      `class C { static { var globalThis = { Math: { random: () => 1 } } } } return globalThis.Math.random()`,
      "Math.random() is unavailable",
      "static block var globalThis does not shadow outer globalThis"
    ],
    [
      `for (const Date of [Date.now()]) { Date() } return 1`,
      "Date.now() is unavailable",
      "for-of right side is evaluated outside loop binding"
    ],
    [
      `switch (Date.now()) { case 1: const Date = () => 1; Date(); break } return 1`,
      "Date.now() is unavailable",
      "switch discriminant is evaluated outside switch lexical scope"
    ]
  ]
  for (const [body, message, label] of rejected) {
    expectThrows(() => validateWorkflowScript(`${head}${body}`), message, label)
  }

  const { body } = validateWorkflowScript(`${head}return new Date("2026-06-26T00:00:00Z").toISOString()`)
  assert(body.includes("new Date("), "new Date(value) remains allowed")
  validateWorkflowScript(`${head}const x = {}; return x${".x".repeat(5000)}`)

  validateWorkflowScript(`${head}const Date = () => "shadowed"; return Date()`)
  validateWorkflowScript(`${head}const Math = { random: () => 0.1 }; return Math.random()`)
  validateWorkflowScript(`${head}const Date = { now: { call: () => 1 } }; return Date.now.call(null)`)
  validateWorkflowScript(`${head}const Math = { random: { apply: () => 0.1 } }; return Math.random.apply(null)`)
  validateWorkflowScript(`${head}const Date = { now: { bind: () => () => 1 } }; return Date.now.bind(null)()`)
  validateWorkflowScript(`${head}const Math = { random: { bind: () => () => 0.1 } }; return Math.random.bind(null)()`)
  validateWorkflowScript(
    `${head}const globalThis = { Date: { now: () => 1 }, Math: { random: () => 0.1 } }; return globalThis.Date.now()`
  )
  validateWorkflowScript(`${head}function f(Date) { return Date.now() }; return f({ now: () => 1 })`)
  validateWorkflowScript(`${head}if (true) { const Date = () => "shadowed"; Date() } return 1`)
  validateWorkflowScript(
    `${head}try { throw { Math: { random: () => 0.1 } } } catch (globalThis) { globalThis.Math.random() } return 1`
  )
  validateWorkflowScript(`${head}function f(Date = { now: () => 1 }) { return Date.now() }; return f()`)
  validateWorkflowScript(`${head}const C = class Math { static v(){ return Math.random() } }; return 1`)
  validateWorkflowScript(`${head}class C { static { const Date = { now: () => 1 }; Date.now() } } return 1`)
  validateWorkflowScript(`${head}class C { static { var Date = { now: () => 1 }; Date.now() } } return 1`)
  validateWorkflowScript(`${head}class C { static { var Math = { random: () => 1 }; Math.random() } } return 1`)
  validateWorkflowScript(
    `${head}class C { static { var globalThis = { Math: { random: () => 1 } }; globalThis.Math.random() } } return 1`
  )
  validateWorkflowScript(`${head}for (const Date of [() => 1]) { Date() } return 1`)
  validateWorkflowScript(`${head}for (let Math of [{ random: () => 0.1 }]) { Math.random() } return 1`)
  validateWorkflowScript(`${head}for (let globalThis of [{ Math: { random: () => 0.1 } }]) { globalThis.Math.random() } return 1`)
  validateWorkflowScript(`${head}for (let Date = () => 1; false; ) { Date() } return 1`)
  validateWorkflowScript(`${head}switch (1) { case 1: const Date = () => 1; Date(); break } return 1`)
  validateWorkflowScript(`${head}switch (1) { case Date.now(): const Date = () => 1; break } return 1`)
  validateWorkflowScript(
    `${head}switch (1) { case 1: class Math { static random(){ return 1 } } Math.random(); break } return 1`
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
  expectThrows(
    () => validateWorkflowScript(broken),
    "return { a",
    "shows the offending line content"
  )
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
  assert(
    validateJsonSchemaValue({ type: "string", maxLength: 1 }, "😀").length === 0,
    "string maxLength counts Unicode code points, not UTF-16 code units"
  )
  assert(
    validateJsonSchemaValue({ type: "string", minLength: 2 }, "😀").some((e) =>
      e.includes("minLength")
    ),
    "string minLength counts Unicode code points"
  )

  const falsePropertyErrors = validateJsonSchemaValue(
    { type: "object", properties: { blocked: false } },
    { blocked: "anything" }
  )
  assert(
    falsePropertyErrors.some((e) => e.includes("false schema")),
    "properties:false rejects present property values"
  )
  const falseItemsErrors = validateJsonSchemaValue({ type: "array", items: false }, ["anything"])
  assert(
    falseItemsErrors.some((e) => e.includes("false schema")),
    "items:false rejects array elements"
  )
  const oversizedArray = new Proxy([1, 2, 3], {
    get(target, property, receiver) {
      if (property === "1") {
        throw new Error("maxItems failure should stop before item validation scans the array")
      }
      return Reflect.get(target, property, receiver)
    }
  })
  assert(
    validateJsonSchemaValue(
      { type: "array", maxItems: 1, items: { type: "number" } },
      oversizedArray
    ).some((e) => e.includes("more than maxItems")),
    "maxItems failure returns before scanning every array item"
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
  const wideInvalidObject = Object.fromEntries(
    Array.from({ length: 5000 }, (_, index) => [`k${index}`, "bad"])
  )
  const originalObjectKeys = Object.keys
  const originalObjectEntries = Object.entries
  try {
    Object.keys = ((value: object) => {
      if (value === wideInvalidObject) {
        throw new Error("validator should not materialize every key for wide values")
      }
      return originalObjectKeys(value)
    }) as typeof Object.keys
    Object.entries = ((value: object) => {
      if (value === wideInvalidObject) {
        throw new Error("validator should not materialize every entry for wide values")
      }
      return originalObjectEntries(value)
    }) as typeof Object.entries
    assert(
      validateJsonSchemaValue({ type: "object", additionalProperties: false }, wideInvalidObject)
        .length > 0,
      "additionalProperties:false rejects wide invalid objects without materializing all keys"
    )
    assert(
      validateJsonSchemaValue(
        { type: "object", additionalProperties: { type: "number" } },
        wideInvalidObject
      ).some((e) => e.includes("expected type number")),
      "schema-form additionalProperties rejects wide invalid objects without materializing all entries"
    )
  } finally {
    Object.keys = originalObjectKeys
    Object.entries = originalObjectEntries
  }

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
  const oneOfZeroMatchDetails = validateJsonSchemaValue(
    { oneOf: [{ type: "object", properties: { value: { type: "string" } }, required: ["value"] }] },
    { value: 123 }
  )
  assert(
    oneOfZeroMatchDetails.some((e) => e.includes("matched 0")) &&
      oneOfZeroMatchDetails.some((e) => e.includes("$.value: expected type string, got number")),
    "oneOf zero-match errors include the closest variant's actionable field error"
  )
  const oneOfFalseBranchDetails = validateJsonSchemaValue(
    {
      oneOf: [
        false,
        { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
      ]
    },
    { value: 123 }
  )
  assert(
    oneOfFalseBranchDetails.some((e) => e.includes("$.value: expected type string, got number")),
    "oneOf zero-match diagnostics skip non-actionable false branches"
  )
  const oneOfTieBreakDetails = validateJsonSchemaValue(
    {
      oneOf: [
        { type: "string" },
        { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
      ]
    },
    { value: 123 }
  )
  assert(
    oneOfTieBreakDetails.some((e) => e.includes("$.value: expected type string, got number")) &&
      !oneOfTieBreakDetails.some((e) => e.includes("$: expected type string, got object")),
    "oneOf zero-match diagnostics prefer field-level errors over root-level errors on ties"
  )
  const anyOfFalseBranchDetails = validateJsonSchemaValue(
    {
      anyOf: [
        false,
        { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
      ]
    },
    { value: 123 }
  )
  assert(
    anyOfFalseBranchDetails.some((e) => e.includes("$.value: expected type string, got number")),
    "anyOf zero-match diagnostics skip non-actionable false branches"
  )
  const anyOfTieBreakDetails = validateJsonSchemaValue(
    {
      anyOf: [
        { type: "string" },
        { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
      ]
    },
    { value: 123 }
  )
  assert(
    anyOfTieBreakDetails.some((e) => e.includes("$.value: expected type string, got number")) &&
      !anyOfTieBreakDetails.some((e) => e.includes("$: expected type string, got object")),
    "anyOf zero-match diagnostics prefer field-level errors over root-level errors on ties"
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
    () => assertSupportedJsonSchema({ type: "string", pattern: "[" }),
    "valid regular expression",
    "malformed pattern fails during schema preflight"
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
  expectThrows(() => assertSupportedJsonSchema([]), "schema", "top-level array schema fails closed")
  expectThrows(
    () => assertSupportedJsonSchema({ type: "object", properties: { x: [] } }),
    "$.x",
    "array property schema fails closed"
  )
  expectThrows(
    () => assertSupportedJsonSchema({ anyOf: [[]] }),
    "$.anyOf[0]",
    "array anyOf variant schema fails closed"
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
  assertSupportedJsonSchema({ oneOf: [true, {}] })
  assertSupportedJsonSchema({
    oneOf: [true, { type: "object", required: ["x"] }],
    required: ["x"]
  })
  for (const schema of [
    { oneOf: [true, { type: "string" }], type: "string", minLength: 5 },
    { oneOf: [true, { type: "array" }], type: "array", minItems: 1 },
    { oneOf: [true, { type: "null" }], type: "null" },
    {
      oneOf: [true, { type: "object", properties: { x: { type: "string" } }, required: ["x"] }],
      properties: { x: { type: "string" } },
      required: ["x"]
    }
  ]) {
    assertSupportedJsonSchema(schema)
  }
  for (const schema of [
    { type: "string", oneOf: [{ maxLength: 5 }, { minLength: 6 }] },
    { type: "number", oneOf: [{ maximum: 10 }, { minimum: 11 }] },
    { type: "string", oneOf: [{ pattern: "^a" }, { pattern: "^b" }] },
    { type: "array", oneOf: [{ maxItems: 2 }, { minItems: 3 }] }
  ]) {
    assertSupportedJsonSchema(schema)
  }
  for (const schema of [{ anyOf: [false] }, { anyOf: [false, false] }, { oneOf: [false] }]) {
    assertSupportedJsonSchema(schema)
  }
  assertSupportedJsonSchema({ type: "object", properties: { blocked: false } })
  assertSupportedJsonSchema({ type: "array", items: false })
  assert(
    validateJsonSchemaValue({ anyOf: [false] }, 42).some((e) => e.includes("does not match any")),
    "anyOf:[false] matches no values"
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
  assertSupportedJsonSchema({ type: "number", minimum: 10, maximum: 1 })
  assertSupportedJsonSchema({ type: "string", minLength: 5, maxLength: 2 })
  assertSupportedJsonSchema({ type: "array", minItems: 3, maxItems: 1 })
  assertSupportedJsonSchema({ type: ["string", "number"], minLength: 5, maxLength: 2 })
  assertSupportedJsonSchema({ type: ["array", "null"], minItems: 3, maxItems: 1 })
  assertSupportedJsonSchema({ type: ["number", "string"], minimum: 10, maximum: 1 })
  assertSupportedJsonSchema({ type: "number", anyOf: [{ type: "integer" }] })
  assertSupportedJsonSchema({ type: "integer", anyOf: [{ type: "number" }] })
  assertSupportedJsonSchema({ anyOf: [{ type: "number" }], maximum: -5 })
  assertSupportedJsonSchema({ oneOf: [{ type: "integer" }], maximum: -1 })
  assertSupportedJsonSchema({ anyOf: [{ type: "null" }], nullable: true, required: ["a"] })
  assertSupportedJsonSchema({
    oneOf: [{ type: "integer", nullable: true }],
    nullable: true,
    required: ["a"]
  })
  assertSupportedJsonSchema({
    type: "object",
    properties: { a: { type: "string", minLength: 5, maxLength: 1 } }
  })
  assertSupportedJsonSchema({
    type: "array",
    items: { type: "string", minLength: 5, maxLength: 1 }
  })
  assertSupportedJsonSchema({
    type: "object",
    additionalProperties: { type: "string", minLength: 5, maxLength: 1 }
  })
  assertSupportedJsonSchema({ type: "integer", minimum: 1.2, maximum: 2.8 })
  assertSupportedJsonSchema({ type: "integer", minimum: 1.2, maximum: 1.8 })
  assertSupportedJsonSchema({
    type: "object",
    properties: { a: { type: "string", minLength: 5, maxLength: 1 } },
    required: ["a"]
  })
  assertSupportedJsonSchema({
    type: "array",
    items: { type: "string", minLength: 5, maxLength: 1 },
    minItems: 1
  })
  assertSupportedJsonSchema({
    type: "object",
    required: ["a"],
    additionalProperties: { type: "string", minLength: 5, maxLength: 1 }
  })
  assertSupportedJsonSchema({
    anyOf: [
      {
        type: "object",
        required: ["y"],
        additionalProperties: { type: "number" }
      }
    ],
    type: "object",
    properties: { x: { type: "string" } },
    additionalProperties: false
  })
  assertSupportedJsonSchema({
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
    anyOf: [false, { type: "object", additionalProperties: { type: "string" } }]
  })
  assertSupportedJsonSchema({
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
    anyOf: [{ type: "object", additionalProperties: { type: "number" } }]
  })
  assert(
    validateJsonSchemaValue({ type: "number", anyOf: [{ type: "integer" }] }, 5).length === 0,
    "integer remains a valid number when preflight intersects type constraints"
  )
  assert(
    validateJsonSchemaValue({ anyOf: [{ type: "number" }], maximum: -5 }, -10).length === 0,
    "negative numeric upper bounds remain viable when no lower bound is declared"
  )
  assertSupportedJsonSchema({
    type: ["string", "number"],
    minLength: 5,
    maxLength: 2,
    minimum: 10,
    maximum: 1
  })
  assertSupportedJsonSchema({ anyOf: [{ type: "null" }], required: ["a"] })
  assertSupportedJsonSchema({
    anyOf: [{ type: "string", minLength: 5, maxLength: 1 }, { type: "number" }]
  })
  assertSupportedJsonSchema({
    oneOf: [{ type: "array", minItems: 5, maxItems: 1 }, { type: "string" }]
  })
  assertSupportedJsonSchema({
    oneOf: [
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "number" } }
    ],
    type: "array",
    minItems: 1
  })
  assertSupportedJsonSchema({
    oneOf: [
      { type: "array", items: {} },
      { type: "array", items: { type: "string" } }
    ],
    type: "array",
    minItems: 1
  })
  assertSupportedJsonSchema({
    oneOf: [
      {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
        additionalProperties: true
      },
      {
        type: "object",
        properties: { x: { type: "string" }, y: { type: "string" } },
        required: ["x", "y"]
      }
    ],
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x", "y"]
  })
  assertSupportedJsonSchema({ type: "string", const: "ab", minLength: 5 })
  assertSupportedJsonSchema({ type: "string", enum: ["a", "b"], minLength: 5 })
  assertSupportedJsonSchema({ type: "string", const: "ab", pattern: "^A+$" })
  assertSupportedJsonSchema({ type: "string", enum: ["a", "longer"], minLength: 5 })
  for (const schema of [
    { anyOf: [{ const: "a" }], minLength: 5 },
    { oneOf: [{ enum: ["a", "b"] }], pattern: "^Z+$" },
    { anyOf: [{ type: "string", minLength: 3 }], maxLength: 1 },
    { oneOf: [{ type: "number", minimum: 10 }], maximum: 5 },
    { anyOf: [{ type: "array", minItems: 2 }], maxItems: 0 },
    { anyOf: [{ type: "string", pattern: "^B+$" }], type: "string", pattern: "^A+$" },
    {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"]
        }
      ],
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"]
    },
    {
      anyOf: [{ type: "object", properties: { y: { type: "string" } }, required: ["y"] }],
      type: "object",
      properties: { x: { type: "string" } },
      additionalProperties: false
    },
    {
      anyOf: [{ type: "array", items: { type: "string" } }],
      type: "array",
      items: { type: "number" },
      minItems: 1
    },
    { oneOf: [{ type: "string" }, { type: "string" }], type: "string" },
    {
      oneOf: [
        {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"]
        },
        {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"]
        }
      ],
      type: "object"
    }
  ]) {
    assertSupportedJsonSchema(schema)
  }
  assertSupportedJsonSchema({ oneOf: [{ type: "string" }, { type: "string" }, { type: "number" }] })
  assertSupportedJsonSchema({
    anyOf: [{ type: "string" }, { type: "number" }],
    minLength: 5,
    maxLength: 2,
    minimum: 10,
    maximum: 1
  })
  assertSupportedJsonSchema({
    anyOf: [{ type: "string" }],
    oneOf: [{ type: "string" }, { type: "number" }],
    minLength: 5,
    maxLength: 2
  })
  const siblingConstrainedMixedRootSchema = {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
    ],
    required: ["x"]
  }
  assertSupportedJsonSchema(siblingConstrainedMixedRootSchema)
  assert(
    validateJsonSchemaValue(siblingConstrainedMixedRootSchema, "ok").some((error) =>
      error.includes("expected an object")
    ),
    "root required/properties remain an implicit object constraint even when anyOf has a scalar branch"
  )
  assert(
    validateJsonSchemaValue(siblingConstrainedMixedRootSchema, { x: "ok" }).length === 0,
    "sibling-constrained mixed roots still accept the valid object branch"
  )
  assertSupportedJsonSchema({
    anyOf: [{ type: "string" }, { type: "number" }],
    properties: { x: { type: "string" } }
  })

  const nestedAnyOf = (depth: number): Record<string, unknown> =>
    depth <= 0
      ? { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
      : {
          anyOf: Array.from({ length: 5 }, () => nestedAnyOf(depth - 1)),
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"]
        }
  expectThrows(
    () => assertSupportedJsonSchema(nestedAnyOf(6)),
    "too large or complex",
    "schema preflight rejects combinator trees before exponential analysis can freeze the main process"
  )
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

async function testStructuredOutputHardStopsInvalidLoops(): Promise<void> {
  const schema = {
    type: "object",
    properties: {
      xssFindings: { type: "array", items: { type: "string" } },
      level: { enum: ["low", "high"] }
    },
    required: ["xssFindings"]
  }

  const repeatedCapture = { value: undefined as unknown, called: false }
  const repeatedTool = createStructuredOutputTool(schema, repeatedCapture) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  const toolProperties = repeatedTool.schema.properties as Record<string, Record<string, unknown>>
  assert(
    toolProperties.xssFindings?.type === "array",
    "structured_output exposes the real JSON Schema to the model, not a generic object"
  )
  const firstMismatch = String(await repeatedTool.invoke({ xssFindings: "[]" }))
  assert(
    firstMismatch.includes("schema mismatch"),
    "first invalid structured_output call returns repairable feedback"
  )
  assert(
    firstMismatch.includes('Use [] instead of "[]"'),
    "stringified JSON arrays get a model-actionable repair hint"
  )
  const largeJsonStringMismatch = String(
    await createStructuredOutputTool(schema, { value: undefined, called: false }).invoke({
      xssFindings: JSON.stringify(Array.from({ length: 300 }, (_, index) => `finding-${index}`))
    })
  )
  assert(
    largeJsonStringMismatch.includes("...[truncated]"),
    "large JSON repair hints are bounded instead of echoing the entire value"
  )
  assert(
    largeJsonStringMismatch.length < 2000,
    `large JSON repair hint stays compact, got ${largeJsonStringMismatch.length} chars`
  )
  const wideObject = Object.fromEntries(
    Array.from({ length: 5000 }, (_, index) => [`k${index}`, index])
  )
  const originalObjectEntries = Object.entries
  try {
    Object.entries = ((value: object) => {
      if (value === wideObject) {
        throw new Error("wide structured_output input should not materialize every entry")
      }
      return originalObjectEntries(value)
    }) as typeof Object.entries
    const wideObjectMismatch = String(
      await createStructuredOutputTool(schema, { value: undefined, called: false }).invoke({
        xssFindings: wideObject
      })
    )
    assert(
      wideObjectMismatch.includes("schema mismatch"),
      "wide invalid objects still return repairable structured_output feedback"
    )
  } finally {
    Object.entries = originalObjectEntries
  }
  assert(
    String(await repeatedTool.invoke({ xssFindings: "[]" })).includes("schema mismatch"),
    "second identical invalid structured_output call still returns repairable feedback"
  )
  await expectRejects(
    () => repeatedTool.invoke({ xssFindings: "[]" }),
    "identical invalid attempts",
    "third identical invalid structured_output call hard-stops instead of looping"
  )

  const validThenInvalidCapture = { value: undefined as unknown, called: false }
  const validThenInvalidTool = createStructuredOutputTool(
    schema,
    validThenInvalidCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await validThenInvalidTool.invoke({ xssFindings: ["ok"], level: "low" })).includes(
      "recorded successfully"
    ),
    "valid structured_output call records the result"
  )
  for (let index = 0; index < 3; index += 1) {
    assert(
      String(await validThenInvalidTool.invoke({ xssFindings: "[]" })).includes(
        "recorded successfully"
      ),
      "invalid structured_output calls after a valid result do not hard-stop the run"
    )
  }
  assert(
    JSON.stringify(validThenInvalidCapture.value) ===
      JSON.stringify({ xssFindings: ["ok"], level: "low" }),
    "invalid calls after a valid result do not overwrite the captured structured output"
  )

  const truncatedSignatureTool = createStructuredOutputTool(schema, {
    value: undefined,
    called: false
  }) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  for (const suffix of ["a", "b", "c"]) {
    assert(
      String(
        await truncatedSignatureTool.invoke({
          xssFindings: `${"x".repeat(1500)}${suffix}`
        })
      ).includes("schema mismatch"),
      "lossy invalid signatures do not trigger identical-attempt hard-stop early"
    )
  }

  const nodeCapture = { value: undefined as unknown, called: false }
  const nodeTool = createStructuredOutputTool(schema, nodeCapture)
  const toolNode = new ToolNode([nodeTool])
  const invokeViaToolNode = (index: number): Promise<unknown> =>
    toolNode.invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${index}`,
              name: "structured_output",
              args: { xssFindings: "[]" }
            }
          ]
        })
      ]
    })
  assert(
    JSON.stringify(await invokeViaToolNode(1)).includes("schema mismatch"),
    "first invalid structured_output call remains repairable through ToolNode"
  )
  assert(
    JSON.stringify(await invokeViaToolNode(2)).includes("schema mismatch"),
    "second invalid structured_output call remains repairable through ToolNode"
  )
  await expectRejects(
    () => invokeViaToolNode(3),
    "identical invalid attempts",
    "third invalid structured_output call bubbles through real ToolNode instead of becoming another ToolMessage"
  )

  const variedCapture = { value: undefined as unknown, called: false }
  const variedTool = createStructuredOutputTool(schema, variedCapture) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  for (const input of [
    {},
    { xssFindings: "[]" },
    { xssFindings: [1] },
    { xssFindings: [], level: "critical" }
  ]) {
    assert(
      String(await variedTool.invoke(input)).includes("schema mismatch"),
      "varied invalid structured_output calls receive bounded repair feedback"
    )
  }
  await expectRejects(
    () => variedTool.invoke({ xssFindings: null }),
    "after 5 attempts",
    "fifth varied invalid structured_output call hard-stops at the global attempt cap"
  )
}

async function testStructuredOutputAcceptsWrappersAndNullableObjects(): Promise<void> {
  const objectSchema = {
    type: "object",
    properties: { answer: { type: "string", minLength: 1 } },
    required: ["answer"],
    additionalProperties: false
  }

  const wrappedCapture = { value: undefined as unknown, called: false }
  const wrappedTool = createStructuredOutputTool(objectSchema, wrappedCapture) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    wrappedTool.schema.additionalProperties === false,
    "provider-facing object schemas preserve additionalProperties:false"
  )
  assert(
    String(await wrappedTool.invoke({ value: { answer: "ok" } })).includes("recorded successfully"),
    "valid one-key wrapper is accepted even when tool pre-validation rejects the wrapper object"
  )
  assert(
    JSON.stringify(wrappedCapture.value) === JSON.stringify({ answer: "ok" }),
    "wrapper input is unwrapped before capture"
  )
  const invalidWrappedCapture = { value: undefined as unknown, called: false }
  const invalidWrappedTool = createStructuredOutputTool(
    objectSchema,
    invalidWrappedCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const invalidWrappedMessage = String(await invalidWrappedTool.invoke({ value: { answer: 123 } }))
  assert(
    invalidWrappedMessage.includes("$.answer: expected type string, got number"),
    "invalid object-root wrappers report errors from the unwrapped candidate"
  )

  const openObjectSchema = {
    type: "object",
    properties: { a: { type: "string" } }
  }
  const openWrappedCapture = { value: undefined as unknown, called: false }
  const openWrappedTool = createStructuredOutputTool(
    openObjectSchema,
    openWrappedCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await openWrappedTool.invoke({ value: { a: "ok" } })).includes("recorded successfully"),
    "open object-root schemas unwrap accidental value wrappers when the object shape is declared"
  )
  assert(
    JSON.stringify(openWrappedCapture.value) === JSON.stringify({ a: "ok" }),
    "open object-root wrapper input captures the inner shaped object, not the wrapper object"
  )

  const openInvalidWrappedCapture = { value: undefined as unknown, called: false }
  const openInvalidWrappedTool = createStructuredOutputTool(
    openObjectSchema,
    openInvalidWrappedCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const openInvalidWrappedMessage = String(
    await openInvalidWrappedTool.invoke({ value: { a: 123 } })
  )
  assert(
    openInvalidWrappedMessage.includes("$.a: expected type string, got number"),
    "open object-root wrappers do not let the wrapper object mask invalid inner fields"
  )
  assert(
    openInvalidWrappedCapture.value === undefined,
    "invalid open object-root wrapper input is not recorded as a valid wrapper object"
  )

  const pureOpenObjectCapture = { value: undefined as unknown, called: false }
  const pureOpenObjectTool = createStructuredOutputTool(
    { type: "object" },
    pureOpenObjectCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await pureOpenObjectTool.invoke({ value: { a: 123 } })).includes(
      "recorded successfully"
    ),
    "pure open object schemas still accept a direct object with a value key"
  )
  assert(
    JSON.stringify(pureOpenObjectCapture.value) === JSON.stringify({ value: { a: 123 } }),
    "pure open object schemas do not invent unwrapping without a declared object shape"
  )

  const valueFieldCapture = { value: undefined as unknown, called: false }
  const valueFieldTool = createStructuredOutputTool(
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    valueFieldCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const valueFieldMismatch = String(await valueFieldTool.invoke({ value: 123 }))
  assert(
    valueFieldMismatch.includes("$.value: expected type string, got number"),
    "real object-root fields named value/input/result/data are not mistaken for wrapper-only errors"
  )
  const additionalValueTool = createStructuredOutputTool(
    {
      type: "object",
      additionalProperties: { type: "string" }
    },
    { value: undefined as unknown, called: false }
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const additionalValueMismatch = String(await additionalValueTool.invoke({ value: 123 }))
  assert(
    additionalValueMismatch.includes("$.value: expected type string, got number"),
    "additionalProperties schemas treat value/input/result/data as real object-root fields for repair errors"
  )
  const combinatorValueFieldTool = createStructuredOutputTool(
    {
      anyOf: [
        {
          type: "object",
          properties: { value: { type: "string", minLength: 5 } },
          required: ["value"]
        }
      ]
    },
    { value: undefined as unknown, called: false }
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const combinatorValueMismatch = String(await combinatorValueFieldTool.invoke({ value: "x" }))
  assert(
    combinatorValueMismatch.includes("$.value: string is shorter than minLength 5"),
    "anyOf/oneOf object-root fields named value/input/result/data are not mistaken for wrapper errors"
  )

  const nodeWrappedCapture = { value: undefined as unknown, called: false }
  const nodeWrappedTool = createStructuredOutputTool(objectSchema, nodeWrappedCapture)
  const nodeWrappedResult = await new ToolNode([nodeWrappedTool]).invoke({
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "wrapped_call",
            name: "structured_output",
            args: { value: { answer: "ok" } }
          }
        ]
      })
    ]
  })
  assert(
    JSON.stringify(nodeWrappedResult).includes("recorded successfully"),
    "valid one-key wrapper also succeeds through the real ToolNode path"
  )
  assert(
    JSON.stringify(nodeWrappedCapture.value) === JSON.stringify({ answer: "ok" }),
    "ToolNode wrapper input is unwrapped before capture"
  )

  const firstValidCapture = { value: undefined as unknown, called: false }
  const firstValidTool = createStructuredOutputTool(objectSchema, firstValidCapture) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await firstValidTool.invoke({ answer: "first" })).includes("recorded successfully"),
    "first valid structured_output call records the result"
  )
  assert(
    String(await firstValidTool.invoke({ answer: "second" })).includes("recorded successfully"),
    "later valid structured_output calls are acknowledged without changing the result"
  )
  assert(
    JSON.stringify(firstValidCapture.value) === JSON.stringify({ answer: "first" }),
    "the first valid structured_output result wins to preserve exactly-once semantics"
  )

  const nullableObjectSchema = {
    type: ["object", "null"],
    properties: { answer: { type: "string" } },
    required: ["answer"]
  }
  const nullableCapture = { value: undefined as unknown, called: false }
  const nullableTool = createStructuredOutputTool(
    nullableObjectSchema,
    nullableCapture
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    nullableTool.schema.type === "object" &&
      typeof (nullableTool.schema.properties as Record<string, unknown>)?.value === "object",
    "nullable object roots are wrapped so providers always receive an object tool schema"
  )
  const nullableValueSchema = (nullableTool.schema.properties as Record<string, unknown>)
    .value as Record<string, unknown>
  assert(
    !Array.isArray(nullableValueSchema.type) && Array.isArray(nullableValueSchema.anyOf),
    "nullable object value schemas are normalized away from type arrays for provider compatibility"
  )
  const nullableNullBranch = (nullableValueSchema.anyOf as Record<string, unknown>[]).find(
    (branch) => branch.type === "null"
  )
  assert(
    nullableNullBranch &&
      !Object.prototype.hasOwnProperty.call(nullableNullBranch, "properties") &&
      !Object.prototype.hasOwnProperty.call(nullableNullBranch, "required"),
    "nullable object null branch does not inherit object-only constraints"
  )
  assert(
    String(await nullableTool.invoke({ value: { answer: "ok" } })).includes(
      "recorded successfully"
    ),
    "type:[object,null] accepts the value-wrapped object shape"
  )
  assert(
    JSON.stringify(nullableCapture.value) === JSON.stringify({ answer: "ok" }),
    "nullable object unwraps the captured object result"
  )
  const nullableNullCapture = { value: undefined as unknown, called: false }
  const nullableNullTool = createStructuredOutputTool(
    nullableObjectSchema,
    nullableNullCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await nullableNullTool.invoke({ value: null })).includes("recorded successfully"),
    "type:[object,null] can represent null through the value wrapper"
  )
  assert(nullableNullCapture.value === null, "nullable object unwraps null")
  const nullableDirectCapture = { value: undefined as unknown, called: false }
  const nullableDirectTool = createStructuredOutputTool(
    nullableObjectSchema,
    nullableDirectCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await nullableDirectTool.invoke({ answer: "ok" })).includes("recorded successfully"),
    "type:[object,null] still tolerates a direct object if a model/provider sends one"
  )
  assert(
    JSON.stringify(nullableDirectCapture.value) === JSON.stringify({ answer: "ok" }),
    "direct nullable object fallback captures the object result"
  )

  const wideRootWrapperCases = [
    {
      name: "wide root",
      schema: {},
      input: { value: "ok" },
      expected: "ok"
    },
    {
      name: "nullable wide root",
      schema: { nullable: true },
      input: { value: 42 },
      expected: 42
    }
  ]
  for (const { name, schema, input, expected } of wideRootWrapperCases) {
    const capture = { value: undefined as unknown, called: false }
    const wideRootTool = createStructuredOutputTool(schema, capture) as unknown as {
      schema: Record<string, unknown>
      invoke: (input: unknown) => Promise<unknown>
    }
    const toolSchema = wideRootTool.schema as {
      type?: unknown
      properties?: Record<string, unknown>
      required?: unknown
    }
    assert(toolSchema.type === "object", `${name} is exposed as an object tool schema`)
    assert(
      typeof toolSchema.properties?.value === "object" && toolSchema.properties.value !== null,
      `${name} uses a value wrapper so scalar results remain expressible`
    )
    assert(
      JSON.stringify(toolSchema.required) === JSON.stringify(["value"]),
      `${name} requires the value wrapper`
    )
    assert(
      String(await wideRootTool.invoke(input)).includes("recorded successfully"),
      `${name} accepts a value-wrapped tool input`
    )
    assert(
      JSON.stringify(capture.value) === JSON.stringify(expected),
      `${name} unwraps the captured scalar value`
    )
  }

  const wideRootNullCases = [
    {
      name: "wide root null",
      schema: {},
      input: { value: null },
      expected: null
    },
    {
      name: "nullable wide root null",
      schema: { nullable: true },
      input: { value: null },
      expected: null
    }
  ]
  for (const { name, schema, input, expected } of wideRootNullCases) {
    const capture = { value: undefined as unknown, called: false }
    const tool = createStructuredOutputTool(schema, capture) as unknown as {
      invoke: (input: unknown) => Promise<unknown>
    }
    assert(
      String(await tool.invoke(input)).includes("recorded successfully"),
      `${name} accepts value-wrapped null`
    )
    assert(JSON.stringify(capture.value) === JSON.stringify(expected), `${name} unwraps to null`)
  }

  const wideRootExample = JSON.parse(structuredOutputToolInputExampleJson({}) ?? "null") as {
    value?: unknown
  }
  assert(
    typeof wideRootExample === "object" &&
      wideRootExample !== null &&
      Object.prototype.hasOwnProperty.call(wideRootExample, "value"),
    "wide root schemas show the value wrapper in the tool input example"
  )

  const nonObjectRootCases = [
    {
      name: "root enum",
      schema: { enum: ["ok"] },
      input: { value: "ok" },
      expected: "ok"
    },
    {
      name: "root const",
      schema: { const: "ok" },
      input: { value: "ok" },
      expected: "ok"
    },
    {
      name: "root anyOf",
      schema: { anyOf: [{ type: "string", minLength: 2 }, { type: "number" }] },
      input: { value: "hi" },
      expected: "hi"
    },
    {
      name: "root oneOf",
      schema: { oneOf: [{ type: "string" }, { type: "number" }] },
      input: { value: 42 },
      expected: 42
    },
    {
      name: "mixed scalar/object root",
      schema: { anyOf: [{ type: "string" }, { type: "object" }] },
      input: { value: "ok" },
      expected: "ok"
    },
    {
      name: "mixed type-array root",
      schema: { type: ["string", "object"] },
      input: { value: "ok" },
      expected: "ok"
    },
    {
      name: "mixed scalar/object/null root",
      schema: { anyOf: [{ type: "string" }, { type: "object" }, { type: "null" }] },
      input: { value: null },
      expected: null
    }
  ]
  for (const { name, schema, input, expected } of nonObjectRootCases) {
    const capture = { value: undefined as unknown, called: false }
    const nonObjectTool = createStructuredOutputTool(schema, capture) as unknown as {
      schema: Record<string, unknown>
      invoke: (input: unknown) => Promise<unknown>
    }
    const toolSchema = nonObjectTool.schema as {
      type?: unknown
      properties?: Record<string, unknown>
      required?: unknown
    }
    assert(toolSchema.type === "object", `${name} is exposed as an object tool schema`)
    assert(
      typeof toolSchema.properties?.value === "object" && toolSchema.properties.value !== null,
      `${name} is wrapped under a value property for the model`
    )
    assert(
      JSON.stringify(toolSchema.required) === JSON.stringify(["value"]),
      `${name} requires the value wrapper`
    )
    assert(
      String(await nonObjectTool.invoke(input)).includes("recorded successfully"),
      `${name} accepts a value-wrapped tool input`
    )
    assert(
      JSON.stringify(capture.value) === JSON.stringify(expected),
      `${name} unwraps the captured value`
    )
  }

  const objectLiteralRootCases = [
    {
      name: "object const root",
      schema: { const: { a: 1 } },
      input: { value: { a: 1 } },
      expected: { a: 1 }
    },
    {
      name: "object enum root",
      schema: { enum: [{ a: 1 }] },
      input: { value: { a: 1 } },
      expected: { a: 1 }
    }
  ]
  for (const { name, schema, input, expected } of objectLiteralRootCases) {
    const capture = { value: undefined as unknown, called: false }
    const tool = createStructuredOutputTool(schema, capture) as unknown as {
      schema: { properties?: Record<string, unknown>; required?: unknown }
      invoke: (input: unknown) => Promise<unknown>
    }
    assert(
      typeof tool.schema.properties?.value === "object" &&
        JSON.stringify(tool.schema.required) === JSON.stringify(["value"]),
      `${name} exposes the object literal under a value wrapper`
    )
    const exampleJson = structuredOutputToolInputExampleJson(schema)
    assert(
      exampleJson !== undefined &&
        JSON.stringify(JSON.parse(exampleJson)) === JSON.stringify(input),
      `${name} example shows the same value wrapper the tool schema requires`
    )
    assert(
      String(await tool.invoke(input)).includes("recorded successfully"),
      `${name} accepts the value-wrapped object literal`
    )
    assert(
      JSON.stringify(capture.value) === JSON.stringify(expected),
      `${name} unwraps the captured object literal`
    )
  }

  const structuredPrompt = buildWorkflowSubagentStructuredPrompt(
    JSON.stringify({ const: { a: 1 } }, null, 2),
    structuredOutputToolInputExampleJson({ const: { a: 1 } })
  )
  assert(
    structuredPrompt.includes("tool schema or example requires that wrapper"),
    "structured subagent prompt tells the model to follow the actual tool schema/example for value wrappers"
  )

  const booleanTrueMixedRootSchema = {
    anyOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }, true]
  }
  const booleanTrueScalarCapture = { value: undefined as unknown, called: false }
  const booleanTrueScalarTool = createStructuredOutputTool(
    booleanTrueMixedRootSchema,
    booleanTrueScalarCapture
  ) as unknown as {
    schema: { properties?: Record<string, unknown>; required?: unknown; type?: unknown }
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    booleanTrueScalarTool.schema.type === "object" &&
      typeof booleanTrueScalarTool.schema.properties?.value === "object" &&
      JSON.stringify(booleanTrueScalarTool.schema.required) === JSON.stringify(["value"]),
    "anyOf true branches make mixed roots value-wrapped so scalar results stay expressible"
  )
  assert(
    String(await booleanTrueScalarTool.invoke({ value: "abc" })).includes("recorded successfully"),
    "anyOf true mixed roots accept value-wrapped scalar results"
  )
  assert(
    booleanTrueScalarCapture.value === "abc",
    "anyOf true mixed roots unwrap value-wrapped scalar results"
  )
  const booleanTrueObjectCapture = { value: undefined as unknown, called: false }
  const booleanTrueObjectTool = createStructuredOutputTool(
    booleanTrueMixedRootSchema,
    booleanTrueObjectCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await booleanTrueObjectTool.invoke({ value: { x: "ok" } })).includes(
      "recorded successfully"
    ),
    "anyOf true mixed roots also accept value-wrapped object results"
  )
  assert(
    JSON.stringify(booleanTrueObjectCapture.value) === JSON.stringify({ x: "ok" }),
    "anyOf true mixed roots unwrap value-wrapped object results"
  )

  const wideDirectCapture = { value: undefined as unknown, called: false }
  const wideDirectTool = createStructuredOutputTool({}, wideDirectCapture) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await wideDirectTool.invoke({ foo: "bar" })).includes("recorded successfully"),
    "wide root schemas accept direct single-key objects without treating the key as a wrapper"
  )
  assert(
    JSON.stringify(wideDirectCapture.value) === JSON.stringify({ foo: "bar" }),
    "wide root schemas preserve direct single-key object values"
  )

  const semanticScalarCapture = { value: undefined as unknown, called: false }
  const semanticScalarTool = createStructuredOutputTool(
    { type: "string" },
    semanticScalarCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await semanticScalarTool.invoke({ answer: "ok" })).includes("recorded successfully"),
    "non-object scalar roots accept common semantic single-key near-misses"
  )
  assert(
    semanticScalarCapture.value === "ok",
    "non-object scalar roots capture the semantic single-key value"
  )

  const semanticArrayCapture = { value: undefined as unknown, called: false }
  const semanticArrayTool = createStructuredOutputTool(
    { type: "array", items: { type: "string" } },
    semanticArrayCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await semanticArrayTool.invoke({ items: ["a", "b"] })).includes("recorded successfully"),
    "non-object array roots accept common semantic single-key near-misses"
  )
  assert(
    JSON.stringify(semanticArrayCapture.value) === JSON.stringify(["a", "b"]),
    "non-object array roots capture the semantic single-key value"
  )

  const semanticNullCapture = { value: undefined as unknown, called: false }
  const semanticNullTool = createStructuredOutputTool(
    { type: "null" },
    semanticNullCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await semanticNullTool.invoke({ answer: null })).includes("recorded successfully"),
    "null roots accept semantic single-key near-misses whose value is null"
  )
  assert(semanticNullCapture.value === null, "null roots capture the semantic null value")

  const semanticNullableCapture = { value: undefined as unknown, called: false }
  const semanticNullableTool = createStructuredOutputTool(
    { type: ["string", "null"] },
    semanticNullableCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    String(await semanticNullableTool.invoke({ answer: null })).includes("recorded successfully"),
    "nullable scalar roots accept semantic single-key near-misses whose value is null"
  )
  assert(
    semanticNullableCapture.value === null,
    "nullable scalar roots capture the semantic null value"
  )

  const nullableWideCapture = { value: undefined as unknown, called: false }
  const nullableWideTool = createStructuredOutputTool(
    { nullable: true },
    nullableWideCapture
  ) as unknown as {
    schema: {
      type?: unknown
      properties?: Record<string, Record<string, unknown>>
      required?: unknown
    }
    invoke: (input: unknown) => Promise<unknown>
  }
  const nullableWideHasValueWrapper =
    typeof nullableWideTool.schema.properties?.value === "object" &&
    nullableWideTool.schema.properties.value !== null &&
    JSON.stringify(nullableWideTool.schema.required) === JSON.stringify(["value"])
  assert(
    nullableWideTool.schema.type === "object" && nullableWideHasValueWrapper,
    "wide nullable:true schemas use value wrapping instead of narrowing to object-only"
  )
  assert(
    String(await nullableWideTool.invoke({ value: 123 })).includes("recorded successfully"),
    "wide nullable:true schemas still accept non-null values through the workflow validator"
  )
  assert(
    JSON.stringify(nullableWideCapture.value) === JSON.stringify(123),
    "wide nullable:true schemas unwrap valid scalar results"
  )

  const minItemsExample = exampleStructuredOutputToolInput({
    type: "object",
    properties: {
      items: { type: "array", minItems: 3, items: { type: "string" } }
    },
    required: ["items"]
  }) as { items?: unknown }
  assert(
    Array.isArray(minItemsExample.items) && minItemsExample.items.length === 3,
    "structured_output examples satisfy practical minItems values instead of always capping at 2"
  )

  const implicitObjectCapture = { value: undefined as unknown, called: false }
  const implicitObjectTool = createStructuredOutputTool(
    {
      properties: { answer: { type: "string" } },
      required: ["answer"]
    },
    implicitObjectCapture
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    implicitObjectTool.schema.type === "object",
    "implicit object schemas are normalized to type:object for provider tool compatibility"
  )
  assert(
    String(await implicitObjectTool.invoke({ answer: "ok" })).includes("recorded successfully"),
    "implicit object schemas still accept the direct object shape"
  )

  const siblingConstrainedMixedRootSchema = {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
    ],
    required: ["x"]
  }
  const siblingConstrainedCapture = { value: undefined as unknown, called: false }
  const siblingConstrainedTool = createStructuredOutputTool(
    siblingConstrainedMixedRootSchema,
    siblingConstrainedCapture
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    siblingConstrainedTool.schema.type === "object" &&
      !Object.prototype.hasOwnProperty.call(
        (siblingConstrainedTool.schema.properties as Record<string, unknown>) ?? {},
        "value"
      ),
    "sibling-constrained mixed roots expose the same implicit object shape as the validator"
  )
  assert(
    structuredOutputToolInputExampleJson(siblingConstrainedMixedRootSchema)?.includes('"x"'),
    "sibling-constrained mixed root examples guide models to the reachable object branch"
  )
  assert(
    String(await siblingConstrainedTool.invoke({ x: "ok" })).includes("recorded successfully"),
    "sibling-constrained mixed roots accept the reachable object branch through the tool"
  )
  assert(
    JSON.stringify(siblingConstrainedCapture.value) === JSON.stringify({ x: "ok" }),
    "sibling-constrained mixed roots capture the object branch without value wrapping"
  )

  const siblingConstrainedNullableMixedSchema = {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { x: { type: "string" } }, required: ["x"] }
    ],
    nullable: true,
    required: ["x"]
  }
  const siblingConstrainedNullableCapture = { value: undefined as unknown, called: false }
  const siblingConstrainedNullableTool = createStructuredOutputTool(
    siblingConstrainedNullableMixedSchema,
    siblingConstrainedNullableCapture
  ) as unknown as {
    schema: { properties?: Record<string, unknown> }
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    siblingConstrainedNullableTool.schema.properties?.value === undefined &&
      !JSON.stringify(siblingConstrainedNullableTool.schema).includes('"type":"null"'),
    "nullable sibling-constrained mixed roots stay object-shaped and do not expose null when sibling anyOf rejects it"
  )
  assert(
    String(await siblingConstrainedNullableTool.invoke({ value: null })).includes(
      "does not match any"
    ),
    "nullable sibling-constrained mixed roots reject value-wrapped null consistently with the validator"
  )
  assert(
    String(await siblingConstrainedNullableTool.invoke({ x: "ok" })).includes(
      "recorded successfully"
    ),
    "nullable sibling-constrained mixed roots still accept the reachable object branch"
  )
  assert(
    JSON.stringify(siblingConstrainedNullableCapture.value) === JSON.stringify({ x: "ok" }),
    "nullable sibling-constrained mixed roots capture the reachable object branch"
  )

  const nestedImplicitObjectCapture = { value: undefined as unknown, called: false }
  const nestedImplicitObjectTool = createStructuredOutputTool(
    {
      type: "object",
      properties: {
        payload: {
          properties: { x: { type: "string" } },
          required: ["x"]
        }
      },
      required: ["payload"]
    },
    nestedImplicitObjectCapture
  ) as unknown as {
    schema: { properties?: Record<string, Record<string, unknown>> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const nestedPayloadSchema = nestedImplicitObjectTool.schema.properties?.payload
  assert(
    nestedPayloadSchema?.type === "object",
    "nested implicit object schemas are normalized to type:object for provider tool compatibility"
  )
  assert(
    String(await nestedImplicitObjectTool.invoke({ payload: { x: "ok" } })).includes(
      "recorded successfully"
    ),
    "nested implicit object schemas still validate normally"
  )

  const booleanSubschemaCapture = { value: undefined as unknown, called: false }
  const booleanSubschemaTool = createStructuredOutputTool(
    {
      type: "object",
      properties: {
        anything: true,
        list: { type: "array", items: true },
        choice: { anyOf: [true] }
      },
      required: ["anything", "list", "choice"]
    },
    booleanSubschemaCapture
  ) as unknown as {
    schema: { properties?: Record<string, Record<string, unknown>> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const booleanSubschemaProperties = booleanSubschemaTool.schema.properties ?? {}
  assert(
    JSON.stringify(booleanSubschemaProperties.anything) === JSON.stringify({}) &&
      JSON.stringify(booleanSubschemaProperties.list.items as unknown) === JSON.stringify({}) &&
      JSON.stringify((booleanSubschemaProperties.choice.anyOf as unknown[])[0]) ===
        JSON.stringify({}),
    "boolean JSON Schema subschemas are normalized to provider-compatible empty schemas"
  )
  assert(
    String(
      await booleanSubschemaTool.invoke({
        anything: { nested: "ok" },
        list: [1, "two", null],
        choice: false
      })
    ).includes("recorded successfully"),
    "boolean subschemas still validate through the local workflow validator"
  )

  const invalidScalarCapture = { value: undefined as unknown, called: false }
  const invalidScalarTool = createStructuredOutputTool(
    { type: "string" },
    invalidScalarCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const invalidScalarMessage = String(await invalidScalarTool.invoke({ value: 123 }))
  assert(
    invalidScalarMessage.includes("expected type string, got number"),
    "invalid value-wrapped scalar feedback points at the unwrapped value type"
  )

  const nullableStringCapture = { value: undefined as unknown, called: false }
  const nullableStringTool = createStructuredOutputTool(
    { type: "string", nullable: true, minLength: 2 },
    nullableStringCapture
  ) as unknown as {
    schema: { properties?: Record<string, Record<string, unknown>> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const nullableStringValueSchema = nullableStringTool.schema.properties?.value as {
    nullable?: unknown
    anyOf?: Record<string, unknown>[]
  }
  assert(
    nullableStringValueSchema.nullable === undefined &&
      Array.isArray(nullableStringValueSchema.anyOf),
    "OpenAPI nullable:true is normalized away before exposing tool schema to providers"
  )
  const nullableStringNullBranch = nullableStringValueSchema.anyOf?.find(
    (branch) => branch.type === "null"
  )
  assert(
    nullableStringNullBranch &&
      !Object.prototype.hasOwnProperty.call(nullableStringNullBranch, "minLength"),
    "nullable string null branch does not inherit string-only constraints"
  )
  assert(
    String(await nullableStringTool.invoke({ value: null })).includes("recorded successfully"),
    "nullable:true still validates null through the local workflow validator"
  )

  const nullableEnumCapture = { value: undefined as unknown, called: false }
  const nullableEnumTool = createStructuredOutputTool(
    { type: ["string", "null"], enum: ["ok", null] },
    nullableEnumCapture
  ) as unknown as {
    schema: { properties?: Record<string, { anyOf?: Record<string, unknown>[] }> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const nullableEnumBranches = nullableEnumTool.schema.properties?.value.anyOf ?? []
  assert(
    nullableEnumBranches.length === 2 &&
      nullableEnumBranches.every(
        (branch) => JSON.stringify(branch.enum) === JSON.stringify(["ok", null])
      ),
    "type-array provider branches retain shared enum constraints"
  )
  assert(
    String(await nullableEnumTool.invoke({ value: "bad" })).includes('must be one of ["ok",null]'),
    "shared enum constraints remain enforced by the workflow validator"
  )

  const nullableArrayCapture = { value: undefined as unknown, called: false }
  const nullableArrayTool = createStructuredOutputTool(
    { type: ["array", "null"], items: { type: "string" } },
    nullableArrayCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const nullableArrayMismatch = String(await nullableArrayTool.invoke({ value: "[]" }))
  assert(
    nullableArrayMismatch.includes('Use [] instead of "[]"'),
    "stringified JSON repair hints still work after nullable type arrays become provider anyOf schemas"
  )

  const nestedArrayCapture = { value: undefined as unknown, called: false }
  const nestedArrayTool = createStructuredOutputTool(
    {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { payload: { type: "array", items: { type: "string" } } },
            required: ["payload"]
          }
        }
      },
      required: ["items"]
    },
    nestedArrayCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const nestedArrayMismatch = String(
    await nestedArrayTool.invoke({ items: [{ payload: '["a"]' }] })
  )
  assert(
    nestedArrayMismatch.includes("$.items[0].payload: pass an array directly"),
    "stringified JSON repair hints recurse into array items"
  )

  const additionalPropertiesHintTool = createStructuredOutputTool(
    {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } }
    },
    { value: undefined as unknown, called: false }
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  assert(
    !Object.prototype.hasOwnProperty.call(
      additionalPropertiesHintTool.schema,
      "additionalProperties"
    ),
    "schema-form additionalProperties is kept out of provider-facing tool schemas"
  )
  const additionalPropertiesMismatch = String(
    await additionalPropertiesHintTool.invoke({ extra: '["a"]' })
  )
  assert(
    additionalPropertiesMismatch.includes("$.extra: pass an array directly"),
    "stringified JSON repair hints recurse into additionalProperties schemas"
  )

  const wideAdditionalPropertiesInput: Record<string, unknown> = { early: '["a"]' }
  for (let index = 0; index < 600; index += 1) {
    wideAdditionalPropertiesInput[`safe_${index}`] = []
  }
  Object.defineProperty(wideAdditionalPropertiesInput, "tail", {
    enumerable: true,
    get() {
      throw new Error("additionalProperties hint should not materialize every key")
    }
  })
  const wideAdditionalPropertiesErrors = buildStructuredOutputRepairErrors(
    {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } }
    },
    wideAdditionalPropertiesInput,
    ["base error"]
  )
  assert(
    wideAdditionalPropertiesErrors.some((message) =>
      message.includes("$.early: pass an array directly")
    ),
    "additionalProperties repair hints use lazy key traversal on wide invalid objects"
  )

  const semanticArrayMismatchTool = createStructuredOutputTool(
    { type: "array", items: { type: "string" } },
    { value: undefined as unknown, called: false }
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const semanticArrayMismatch = String(await semanticArrayMismatchTool.invoke({ items: '["a"]' }))
  assert(
    semanticArrayMismatch.includes("$.items: pass an array directly"),
    "semantic single-key array near-misses get a key-specific stringified JSON repair hint"
  )
  assert(
    !semanticArrayMismatch.includes("got object"),
    "semantic single-key array near-misses prefer the inner-value schema error over the outer object error"
  )

  const nestedArraySchema = (depth: number): Record<string, unknown> =>
    depth === 0
      ? { type: "array", items: { type: "string" } }
      : { type: "array", items: nestedArraySchema(depth - 1) }
  const nestedArrayValue = (depth: number): unknown =>
    depth === 0 ? '["leaf"]' : Array.from({ length: 8 }, () => nestedArrayValue(depth - 1))
  const wideNestedArrayTool = createStructuredOutputTool(
    {
      type: "object",
      properties: { items: nestedArraySchema(4) },
      required: ["items"]
    },
    { value: undefined as unknown, called: false }
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const wideNestedArrayMismatch = String(
    await wideNestedArrayTool.invoke({ items: nestedArrayValue(4) })
  )
  const repairHintCount = wideNestedArrayMismatch.match(/pass an array directly/g)?.length ?? 0
  assert(repairHintCount > 0, "wide nested arrays still emit useful stringified JSON hints")
  assert(
    repairHintCount <= 512,
    `wide nested array repair hints are globally bounded, got ${repairHintCount}`
  )

  const arrayCombinatorCapture = { value: undefined as unknown, called: false }
  const arrayCombinatorTool = createStructuredOutputTool(
    { anyOf: [{ type: "array" }] },
    arrayCombinatorCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const arrayCombinatorMismatch = String(await arrayCombinatorTool.invoke({ value: "{}" }))
  assert(
    !arrayCombinatorMismatch.includes('Use {} instead of "{}"'),
    "combinator-only array schemas do not emit object-shaped stringified JSON hints"
  )

  const implicitObjectCombinatorCapture = { value: undefined as unknown, called: false }
  const implicitObjectCombinatorTool = createStructuredOutputTool(
    {
      type: "object",
      properties: {
        payload: {
          anyOf: [true],
          properties: { x: { type: "string" } },
          required: ["x"]
        }
      },
      required: ["payload"]
    },
    implicitObjectCombinatorCapture
  ) as unknown as {
    invoke: (input: unknown) => Promise<unknown>
  }
  const implicitObjectCombinatorMismatch = String(
    await implicitObjectCombinatorTool.invoke({ payload: '{"x":"ok"}' })
  )
  assert(
    implicitObjectCombinatorMismatch.includes('Use {"x":"ok"} instead of'),
    "implicit object schemas with anyOf/oneOf siblings still emit object-shaped stringified JSON hints"
  )
}

async function testWorkflowSubagentBubblesStructuredOutputInterruptSnapshot(): Promise<void> {
  let streamCalls = 0
  const schema = {
    type: "object",
    properties: {
      xssFindings: { type: "array", items: { type: "string" } }
    },
    required: ["xssFindings"]
  }
  const interruptSnapshot = {
    __interrupt__: [
      {
        value:
          "structured_output schema validation failed after 3 identical invalid attempts:\n$.xssFindings: expected type array, got string"
      }
    ],
    messages: []
  }
  assert(
    describeWorkflowError(new NodeInterrupt(interruptSnapshot.__interrupt__[0].value)) ===
      interruptSnapshot.__interrupt__[0].value,
    "workflow error descriptions hide NodeInterrupt's internal JSON wrapper"
  )

  const originalWarn = console.warn
  const keepAlive = setInterval(() => undefined, 100)
  try {
    console.warn = () => undefined
    await expectRejects(
      () =>
        runWorkflowSubagent(
          {
            parentThreadId: "thread-structured-interrupt",
            defaultModelId: "default",
            cleanupThread: async () => undefined,
            isRetryableApiError: () => false,
            createRuntime: async () => ({
              stream: async () => {
                streamCalls += 1
                return (async function* () {
                  yield ["values", interruptSnapshot]
                })()
              }
            })
          },
          {
            prompt: "return findings",
            schema,
            agentIndex: 0,
            label: "structured-interrupt",
            runId: "wf_structured_interrupt",
            signal: new AbortController().signal
          }
        ),
      "identical invalid attempts",
      "compiled graph __interrupt__ snapshot preserves the structured_output fatal reason"
    )
  } finally {
    clearInterval(keepAlive)
    console.warn = originalWarn
  }
  assert(
    streamCalls === 2,
    `structured_output interrupt should skip the nudge stream and only retry the fresh session, got ${streamCalls} stream calls`
  )
}

async function testWorkflowSubagentRepairsDanglingToolCallThenNudges(): Promise<void> {
  let streamCalls = 0
  const streamInputs: unknown[][] = []
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" }
    },
    required: ["answer"]
  }

  // The model leaves structured_output dangling (a tool_call with no result) on EVERY turn.
  // The subagent must NOT 400 by appending the nudge after the dangling call; instead it
  // synthesizes a tool result for the dangling id, then nudges — on EACH attempt (initial +
  // one fresh retry). The mock never recovers, so it ultimately fails after both attempts.
  await expectRejects(
    () =>
      runWorkflowSubagent(
        {
          parentThreadId: "thread-structured-pending-tool-call",
          defaultModelId: "default",
          cleanupThread: async () => undefined,
          isRetryableApiError: () => false,
          createRuntime: async () => ({
            stream: async (input: unknown) => {
              streamCalls += 1
              const messages = (input as { messages?: unknown[] })?.messages
              if (Array.isArray(messages)) streamInputs.push(messages)
              return (async function* () {
                yield [
                  "values",
                  {
                    messages: [
                      {
                        _getType: () => "ai",
                        content: "",
                        kwargs: {
                          additional_kwargs: {
                            tool_calls: [
                              {
                                id: "call-structured",
                                function: { name: "structured_output" },
                                type: "function"
                              }
                            ]
                          }
                        },
                        usage_metadata: { output_tokens: 5 }
                      }
                    ]
                  }
                ]
              })()
            }
          })
        },
        {
          prompt: "return a structured answer",
          schema,
          agentIndex: 0,
          label: "structured-pending-tool-call",
          runId: "wf_structured_pending_tool_call",
          signal: new AbortController().signal
        }
      ),
    "completed without calling the structured_output tool",
    "dangling tool call must be repaired + nudged (not 400), then fail after retries"
  )
  // Each attempt = [initial stream, nudge stream]; 2 attempts (initial + 1 fresh retry) = 4.
  // A 400-block (old behavior) would have been 1 stream/attempt = 2.
  assert(
    streamCalls === 4,
    `repair must let the nudge proceed on each attempt (2 attempts × 2 streams); got ${streamCalls}`
  )
  // The nudge turn's input must carry a synthetic tool result for the dangling tool_call id
  // (so the history is valid before the nudge HumanMessage — no 400).
  const repaired = streamInputs.some((messages) =>
    messages.some((m) => {
      const id = (m as { tool_call_id?: unknown })?.tool_call_id
      return id === "call-structured"
    })
  )
  assert(repaired, "nudge stream input must include a synthetic tool result for the dangling id")
}

async function testWorkflowSubagentNudgesAfterClosedToolCall(): Promise<void> {
  let streamCalls = 0
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" }
    },
    required: ["answer"]
  }

  const result = await runWorkflowSubagent(
    {
      parentThreadId: "thread-structured-closed-tool-call",
      defaultModelId: "default",
      cleanupThread: async () => undefined,
      isRetryableApiError: () => false,
      createRuntime: async (options) => ({
        stream: async () => {
          streamCalls += 1
          return (async function* () {
            if (streamCalls === 1) {
              yield [
                "values",
                {
                  messages: [
                    {
                      _getType: () => "ai",
                      content: "",
                      tool_calls: [
                        {
                          id: "call-read",
                          name: "read_file",
                          args: { path: "README.md" }
                        }
                      ],
                      usage_metadata: { output_tokens: 5 }
                    },
                    {
                      _getType: () => "tool",
                      tool_call_id: "call-read",
                      content: "readme"
                    }
                  ]
                }
              ]
              return
            }

            const structuredTool = options.additionalTools?.find(
              (tool) => tool.name === "structured_output"
            ) as { invoke: (input: unknown) => Promise<unknown> } | undefined
            assert(structuredTool, "structured subagent receives structured_output tool")
            await structuredTool.invoke({ answer: "ok" })
            yield [
              "values",
              {
                messages: [
                  {
                    _getType: () => "ai",
                    content: "",
                    usage_metadata: { output_tokens: 7 }
                  }
                ]
              }
            ]
          })()
        }
      })
    },
    {
      prompt: "return a structured answer",
      schema,
      agentIndex: 0,
      label: "structured-closed-tool-call",
      runId: "wf_structured_closed_tool_call",
      signal: new AbortController().signal
    }
  )

  assert(JSON.stringify(result.structured) === '{"answer":"ok"}', "captures nudge result")
  assert(streamCalls === 2, `closed tool calls should still allow the nudge, got ${streamCalls}`)
}

async function testWorkflowSubagentStopsAfterStructuredOutputSuccess(): Promise<void> {
  let continuedAfterSuccess = false
  let streamClosedEarly = false
  let streamCalls = 0
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" }
    },
    required: ["answer"],
    additionalProperties: false
  }

  const result = await runWorkflowSubagent(
    {
      parentThreadId: "thread-structured-stop",
      defaultModelId: "default",
      cleanupThread: async () => undefined,
      isRetryableApiError: () => false,
      createRuntime: async (options) => ({
        stream: async () => {
          streamCalls += 1
          return (async function* () {
            try {
              const structuredTool = options.additionalTools?.find(
                (tool) => tool.name === "structured_output"
              ) as { invoke: (input: unknown) => Promise<unknown> } | undefined
              assert(structuredTool, "structured subagent receives structured_output tool")
              await structuredTool.invoke({ answer: "ok" })
              yield [
                "values",
                {
                  messages: [
                    {
                      _getType: () => "ai",
                      content: "",
                      usage_metadata: { output_tokens: 7 }
                    }
                  ]
                }
              ]
              continuedAfterSuccess = true
              yield [
                "values",
                {
                  messages: [
                    {
                      _getType: () => "ai",
                      content: "should not run after structured_output succeeds",
                      usage_metadata: { output_tokens: 99 }
                    }
                  ]
                }
              ]
            } finally {
              streamClosedEarly = !continuedAfterSuccess
            }
          })()
        }
      })
    },
    {
      prompt: "return a structured answer",
      schema,
      agentIndex: 0,
      label: "structured-stop",
      runId: "wf_structured_stop",
      signal: new AbortController().signal
    }
  )

  assert(JSON.stringify(result.structured) === '{"answer":"ok"}', "captures structured result")
  assert(result.outputTokens === 7, `uses the success snapshot token count, got ${result.outputTokens}`)
  assert(streamCalls === 1, `successful structured_output should not trigger a nudge, got ${streamCalls}`)
  assert(!continuedAfterSuccess, "stream stops before the model can continue after structured success")
  assert(streamClosedEarly, "successful structured_output closes the stream iterator early")
}

async function testStructuredOutputPatternValidationStaysLocal(): Promise<void> {
  const schema = {
    type: "object",
    properties: {
      code: { type: "string", pattern: "^[A-Z]{2}$" }
    },
    required: ["code"]
  }
  const capture = { value: undefined as unknown, called: false }
  const tool = createStructuredOutputTool(schema, capture) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  const properties = tool.schema.properties as Record<string, Record<string, unknown>>
  assert(
    properties.code && !Object.prototype.hasOwnProperty.call(properties.code, "pattern"),
    "pattern is stripped from the LangChain tool schema so local validation runs first"
  )
  const mismatch = String(await tool.invoke({ code: "bad" }))
  assert(
    mismatch.includes("string does not match pattern"),
    "pattern mismatch is still enforced by the workflow JSON Schema validator"
  )

  const fieldNameSchema = {
    type: "object",
    properties: {
      pattern: { type: "string" }
    },
    required: ["pattern"],
    additionalProperties: false
  }
  const fieldNameCapture = { value: undefined as unknown, called: false }
  const fieldNameTool = createStructuredOutputTool(
    fieldNameSchema,
    fieldNameCapture
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  const fieldNameProperties = fieldNameTool.schema.properties as Record<
    string,
    Record<string, unknown>
  >
  assert(
    fieldNameProperties.pattern?.type === "string",
    'a business field named "pattern" is preserved in the LangChain tool schema'
  )
  assert(
    String(await fieldNameTool.invoke({ pattern: "literal" })).includes("recorded successfully"),
    'a valid business field named "pattern" still validates normally'
  )

  const annotationCapture = { value: undefined as unknown, called: false }
  const annotationTool = createStructuredOutputTool(
    {
      type: "object",
      description: "Keep this description",
      default: { email: "a@example.com" },
      examples: [{ email: "a@example.com" }],
      properties: {
        email: {
          type: "string",
          description: "Email value",
          format: "email",
          default: "a@example.com",
          examples: ["a@example.com"]
        }
      },
      required: ["email"]
    },
    annotationCapture
  ) as unknown as {
    schema: {
      default?: unknown
      examples?: unknown
      properties?: Record<string, Record<string, unknown>>
    }
  }
  const emailProviderSchema = annotationTool.schema.properties?.email ?? {}
  assert(
    annotationTool.schema.description === "Keep this description" &&
      emailProviderSchema.description === "Email value",
    "provider schema keeps useful descriptions"
  )
  assert(
    !Object.prototype.hasOwnProperty.call(annotationTool.schema, "default") &&
      !Object.prototype.hasOwnProperty.call(annotationTool.schema, "examples") &&
      !Object.prototype.hasOwnProperty.call(emailProviderSchema, "format") &&
      !Object.prototype.hasOwnProperty.call(emailProviderSchema, "default") &&
      !Object.prototype.hasOwnProperty.call(emailProviderSchema, "examples"),
    "provider schema strips annotations the local validator ignores"
  )

  const keywordFieldSchema = {
    type: "object",
    properties: {
      enum: { type: "string", pattern: "^[A-Z]+$" },
      const: { type: "string", pattern: "^[A-Z]+$" },
      default: { type: "string", pattern: "^[A-Z]+$" },
      examples: { type: "string", pattern: "^[A-Z]+$" }
    },
    required: ["enum", "const", "default", "examples"]
  }
  const keywordFieldCapture = { value: undefined as unknown, called: false }
  const keywordFieldTool = createStructuredOutputTool(
    keywordFieldSchema,
    keywordFieldCapture
  ) as unknown as {
    schema: Record<string, unknown>
    invoke: (input: unknown) => Promise<unknown>
  }
  const keywordFieldProperties = keywordFieldTool.schema.properties as Record<
    string,
    Record<string, unknown>
  >
  for (const key of ["enum", "const", "default", "examples"]) {
    assert(
      keywordFieldProperties[key]?.type === "string" &&
        !Object.prototype.hasOwnProperty.call(keywordFieldProperties[key], "pattern"),
      `business field schema named "${key}" still has its pattern stripped`
    )
  }
  assert(
    String(
      await keywordFieldTool.invoke({
        enum: "bad",
        const: "bad",
        default: "bad",
        examples: "bad"
      })
    ).includes("$.enum: string does not match pattern"),
    "business fields named like schema keywords still validate against the local pattern"
  )

  const constPatternCapture = { value: undefined as unknown, called: false }
  const constPatternTool = createStructuredOutputTool(
    { const: { pattern: "abc" } },
    constPatternCapture
  ) as unknown as {
    schema: { properties?: Record<string, { const?: unknown }> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const constValueSchema = constPatternTool.schema.properties?.value
  assert(
    JSON.stringify(constValueSchema?.const) === JSON.stringify({ pattern: "abc" }),
    'const values containing a "pattern" business key are not stripped from the provider schema'
  )
  assert(
    String(await constPatternTool.invoke({ value: { pattern: "abc" } })).includes(
      "recorded successfully"
    ),
    'const values containing a "pattern" business key still validate normally'
  )

  const enumPatternCapture = { value: undefined as unknown, called: false }
  const enumPatternTool = createStructuredOutputTool(
    { enum: [{ pattern: "abc" }] },
    enumPatternCapture
  ) as unknown as {
    schema: { properties?: Record<string, { enum?: unknown }> }
    invoke: (input: unknown) => Promise<unknown>
  }
  const enumValueSchema = enumPatternTool.schema.properties?.value
  assert(
    JSON.stringify(enumValueSchema?.enum) === JSON.stringify([{ pattern: "abc" }]),
    'enum values containing a "pattern" business key are not stripped from the provider schema'
  )
  assert(
    String(await enumPatternTool.invoke({ value: { pattern: "abc" } })).includes(
      "recorded successfully"
    ),
    'enum values containing a "pattern" business key still validate normally'
  )
}

function testStructuredOutputExamplePromptOmitsInvalidExamples(): void {
  const invalidExampleSchemas: Record<string, unknown>[] = [
    { type: "string", pattern: "^(foo|bar)$" },
    { type: "string", minLength: 40 },
    { type: "array", minItems: 20, items: { type: "string" } },
    {
      type: "array",
      minItems: 16,
      items: { type: "array", minItems: 16, items: { type: "array", minItems: 16 } }
    }
  ]
  for (const schema of invalidExampleSchemas) {
    assert(
      structuredOutputToolInputExampleJson(schema) === undefined,
      `invalid generated example is omitted for schema ${JSON.stringify(schema)}`
    )
  }

  const nullExampleJson = structuredOutputToolInputExampleJson({ type: "null" })
  assert(typeof nullExampleJson === "string", "pure null schemas include a valid example")
  assert(
    JSON.stringify(JSON.parse(nullExampleJson)) === JSON.stringify({ value: null }),
    "pure null schemas are represented as a value-wrapped null tool input"
  )
  const nestedNullExampleJson = structuredOutputToolInputExampleJson({
    type: "object",
    properties: { marker: { type: "null" } },
    required: ["marker"]
  })
  assert(typeof nestedNullExampleJson === "string", "nested null fields include a valid example")
  const nestedNullExample = JSON.parse(nestedNullExampleJson)
  assert(
    nestedNullExample.marker === null,
    "nested null fields are generated as null instead of an object"
  )

  const enumExampleJson = structuredOutputToolInputExampleJson({
    type: "string",
    enum: ["a", "longer"],
    minLength: 5
  })
  assert(typeof enumExampleJson === "string", "enum schemas choose a valid example when possible")
  assert(
    JSON.stringify(JSON.parse(enumExampleJson)) === JSON.stringify({ value: "longer" }),
    "enum example generation skips invalid early candidates"
  )

  const variantExampleSchema = {
    anyOf: [
      { type: "string", minLength: 10 },
      { type: "string", minLength: 2 }
    ],
    maxLength: 5
  }
  const variantExampleJson = structuredOutputToolInputExampleJson(variantExampleSchema)
  assert(
    typeof variantExampleJson === "string",
    "anyOf/oneOf example generation tries later variants when the first is invalid"
  )
  const variantExample = (JSON.parse(variantExampleJson) as { value: unknown }).value
  assert(
    validateJsonSchemaValue(variantExampleSchema, variantExample).length === 0,
    "anyOf/oneOf generated example validates against sibling assertions"
  )

  const repeatedPatternExampleJson = structuredOutputToolInputExampleJson({
    anyOf: [{ type: "string", minLength: 5 }],
    pattern: "^A+$"
  })
  assert(
    typeof repeatedPatternExampleJson === "string",
    "simple repeated literal patterns include a valid example"
  )
  const repeatedPatternExample = (JSON.parse(repeatedPatternExampleJson) as { value: unknown })
    .value
  assert(
    repeatedPatternExample === "AAAAA",
    "simple repeated literal patterns are padded to satisfy minLength"
  )

  const exactClassPatternExampleJson = structuredOutputToolInputExampleJson({
    type: "object",
    properties: { code: { type: "string", pattern: "^[A-Z]{2}$" } },
    required: ["code"]
  })
  assert(
    typeof exactClassPatternExampleJson === "string",
    "simple exact character-class patterns include a valid nested example"
  )
  assert(
    JSON.stringify(JSON.parse(exactClassPatternExampleJson)) === JSON.stringify({ code: "AA" }),
    "simple exact character-class patterns choose a matching string"
  )

  const booleanAnyOfObjectExampleJson = structuredOutputToolInputExampleJson({
    anyOf: [true],
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"]
  })
  assert(
    typeof booleanAnyOfObjectExampleJson === "string",
    "boolean true anyOf object schemas include a valid example"
  )
  assert(
    JSON.stringify(JSON.parse(booleanAnyOfObjectExampleJson)) === JSON.stringify({ x: "" }),
    "boolean true anyOf object examples are generated from sibling assertions"
  )

  const booleanAnyOfArrayExampleJson = structuredOutputToolInputExampleJson({
    anyOf: [true],
    type: "array",
    items: { type: "string" },
    minItems: 2
  })
  assert(
    typeof booleanAnyOfArrayExampleJson === "string",
    "boolean true anyOf array schemas include a valid example"
  )
  assert(
    JSON.stringify(JSON.parse(booleanAnyOfArrayExampleJson)) ===
      JSON.stringify({ value: ["", ""] }),
    "boolean true anyOf array examples stay value-wrapped for non-object roots"
  )

  const validExampleSchema = {
    type: "object",
    properties: {
      answer: { type: "string", minLength: 2 },
      items: { type: "array", minItems: 3, items: { type: "string" } }
    },
    required: ["answer", "items"]
  }
  const exampleJson = structuredOutputToolInputExampleJson(validExampleSchema)
  assert(typeof exampleJson === "string", "valid generated examples are still included")
  const example = JSON.parse(exampleJson)
  assert(
    validateJsonSchemaValue(validExampleSchema, example).length === 0,
    "included structured_output examples validate against the workflow schema"
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
    delete process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS
    delete process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
    assert(getWorkflowAgentTimeoutMs() === undefined, "per-subagent timeout is disabled by default")
    assert(getWorkflowRunWallClockMs() === 7_200_000, "default inactivity window is 2h")

    process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS = "1000"
    assert(
      getWorkflowAgentTimeoutMs() === undefined,
      "too-small per-subagent timeout is ignored instead of enabled"
    )

    // A window configured BELOW the per-subagent timeout would kill slow-but-
    // healthy agents; when the optional timeout is enabled, the cross-check must
    // floor the run-level window above it.
    process.env.CMB_WORKFLOW_AGENT_TIMEOUT_MS = "600000" // 10 min
    process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = "60000" // 60s — misconfigured
    const flooredWindow = getWorkflowRunWallClockMs()
    assert(
      flooredWindow >= 660_000,
      `window must be floored above the agent timeout, got ${flooredWindow}`
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
  testNondeterministicApisRejectedBeforeRun,
  testSyntaxErrorReported,
  testJsonSchemaValidator,
  testOutputTokenSummation,
  testStructuredOutputHardStopsInvalidLoops,
  testStructuredOutputAcceptsWrappersAndNullableObjects,
  testWorkflowSubagentBubblesStructuredOutputInterruptSnapshot,
  testWorkflowSubagentRepairsDanglingToolCallThenNudges,
  testWorkflowSubagentNudgesAfterClosedToolCall,
  testWorkflowSubagentStopsAfterStructuredOutputSuccess,
  testStructuredOutputPatternValidationStaysLocal,
  testStructuredOutputExamplePromptOmitsInvalidExamples,
  testOversizedScriptRejected,
  testInactivityWindowFlooredAboveAgentTimeout,
  testWorkflowSubagentThreadMatch,
  testResumeArgsAndJournal,
  testGlobMaxClamp,
  testJsonSchemaReDoSGuard
]

void (async () => {
  for (const test of tests) {
    await test()
  }
  console.log(`PASS workflow-script (${tests.length} tests)`)
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
