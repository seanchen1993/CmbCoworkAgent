/**
 * Minimal JSON Schema validator for workflow structured output.
 *
 * Covers the practical subset a workflow script's `schema` option uses:
 * type (incl. type arrays and OpenAPI-style `nullable: true`) / properties /
 * required / items (single object) / enum / const / pattern / anyOf-oneOf
 * (both treated as match-at-least-one) / additionalProperties (false or a
 * schema) plus the common string/number/array bounds. Error messages are
 * written for a mid-tier model to read and fix on retry, so they name the
 * exact path and what was expected.
 *
 * Unsupported constructs ($ref/allOf/not/tuple items/…) are REJECTED up front
 * by assertSupportedJsonSchema rather than silently passing — see below.
 * Intentionally self-contained; no ajv dependency.
 */

const MAX_ERRORS = 10
const MAX_DEPTH = 32

/**
 * Upper bound on the input length we run a schema `pattern` regex against.
 * `RegExp.test` is synchronous on the main process; a pathological pattern over
 * a very long input is the main amplifier of catastrophic backtracking (ReDoS),
 * so beyond this we report a validation error instead of risking a CPU stall.
 * Paired with the compile-time nested-quantifier rejection below. (#9)
 */
const PATTERN_MAX_INPUT_LENGTH = 100_000

/**
 * Heuristic ReDoS guard for a script-supplied `pattern`. Catastrophic
 * backtracking comes mainly from a quantifier applied to a group that itself
 * contains a quantifier — ((a+)+, (a*)*, (.*)+, …) — where one input span can be
 * matched many ways. We reject that "stacked quantifier" shape up front. This is
 * a heuristic, NOT an RE2-grade analysis: it catches the realistic failure mode
 * (an author writing a nested quantifier by mistake), but a deliberately crafted
 * pattern can still slip through. That residual is the same self-inflicted class
 * as a script's own infinite loop (the pattern is author-supplied), and
 * PATTERN_MAX_INPUT_LENGTH bounds its blast radius. (#9)
 */
function hasNestedQuantifier(pattern: string): boolean {
  // A quantifier INSIDE a group (any of * + ? {) makes the group body backtrack-
  // repeatable; if that group is then quantified by an UNBOUNDED quantifier
  // (* + {…}, but NOT ? which is 0..1 and can't blow up), one input span matches
  // exponentially many ways = catastrophic backtracking ((a+)+, (.*)+, (a?)+ …).
  // Skip char classes [...] (where + * ? { are literals — else `[A-Z+]+` is a
  // false positive) and escaped chars.
  const isUnbounded = (ch: string): boolean => ch === "*" || ch === "+" || ch === "{"
  const isAnyQuantifier = (ch: string): boolean =>
    ch === "*" || ch === "+" || ch === "?" || ch === "{"
  // Per open group: does its body already contain a quantifier?
  const groupHasQuantifier: boolean[] = []
  let inCharClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "\\") {
      i++ // skip the escaped char so \( \+ \] aren't read as structure
      continue
    }
    if (inCharClass) {
      if (ch === "]") inCharClass = false
      continue // inside [...], + * ? { are literals, not quantifiers
    }
    if (ch === "[") {
      inCharClass = true
    } else if (ch === "(") {
      groupHasQuantifier.push(false)
    } else if (ch === ")") {
      const innerHadQuantifier = groupHasQuantifier.pop() ?? false
      const next = pattern[i + 1] ?? ""
      // An UNBOUNDED quantifier on a group whose body already had one = ReDoS.
      if (innerHadQuantifier && isUnbounded(next)) return true
      // If THIS group is itself quantified (any quantifier), the enclosing group
      // now "contains a quantifier" too.
      if (isAnyQuantifier(next) && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
    } else if (isAnyQuantifier(ch) && groupHasQuantifier.length > 0) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true
    }
  }
  return false
}

export function validateJsonSchemaValue(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = []
  validateNode(schema, value, "$", errors, 0)
  return errors
}

/** OWN-property check. Plain `key in obj` walks the prototype chain, so a model
 * output (or schema) key named after an Object.prototype member (`toString`,
 * `constructor`, `hasOwnProperty`, `valueOf`, …) would be treated as present/
 * declared even when absent — bypassing `additionalProperties:false` and falsely
 * satisfying `required`. Validate ownership only. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** Valid JSON Schema `type` names. */
const VALID_TYPE_NAMES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null"
])

/** Keywords actually enforced by validateNode (the supported validator subset). */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "additionalProperties",
  "nullable",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems"
])

/** Annotation keywords that JSON Schema permits implementations to ignore (allowed, not validated). */
const IGNORED_ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "format",
  "$schema",
  "$id",
  "$comment",
  "readOnly",
  "writeOnly",
  "deprecated"
])

/**
 * Fail-closed pre-check for the schema itself, run when the SCRIPT declares it
 * (agent() call time) — not during subagent retries, where the schema author
 * isn't present to fix it. Without this, an unsupported construct ($ref,
 * tuple items, boolean subschema) validates vacuously and garbage output
 * passes as "valid".
 */
export function assertSupportedJsonSchema(schema: unknown, path = "$", depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`${path}: schema nesting exceeds the supported depth of ${MAX_DEPTH}`)
  }
  if (schema === true) return
  if (schema === false) {
    throw new TypeError(
      `${path}: boolean JSON schemas are not supported — use { type, properties, required, items, enum, const, anyOf }`
    )
  }
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError(`${path}: schema must be an object`)
  }
  const record = schema as Record<string, unknown>
  // WHITELIST (fail-closed): only keywords we actually implement in validateNode
  // are accepted as validators. Any other ASSERTION keyword (multipleOf,
  // uniqueItems, exclusiveMinimum, …) would otherwise validate vacuously and let
  // invalid structured output through. A blocklist can't keep up with every such
  // keyword, so we invert it. Annotation keywords (description, default, format,
  // …) are permitted but ignored — JSON Schema allows ignoring annotations.
  for (const key of Object.keys(record)) {
    if (SUPPORTED_SCHEMA_KEYWORDS.has(key) || IGNORED_ANNOTATION_KEYWORDS.has(key)) continue
    throw new TypeError(
      `${path}: JSON Schema "${key}" is not supported — use the plain subset: type, properties, required, items (single object), enum, const, anyOf/oneOf, nullable, plus min/max bounds and pattern`
    )
  }
  // Value-type checks for supported keywords. A wrong-typed keyword would
  // otherwise validate vacuously (e.g. required:"x" or additionalProperties:"nope"
  // silently enforce nothing), so fail closed on a malformed schema.
  if (record.type !== undefined) {
    if (Array.isArray(record.type) && record.type.length === 0) {
      throw new TypeError(`${path}.type: a type array must not be empty`)
    }
    const declaredTypes = Array.isArray(record.type) ? record.type : [record.type]
    for (const one of declaredTypes) {
      if (typeof one !== "string" || !VALID_TYPE_NAMES.has(one)) {
        throw new TypeError(
          `${path}.type: must be a JSON type name (or array of them) — one of ${[...VALID_TYPE_NAMES].join(", ")}`
        )
      }
    }
  }
  if (
    record.required !== undefined &&
    (!Array.isArray(record.required) || record.required.some((k) => typeof k !== "string"))
  ) {
    throw new TypeError(`${path}.required: must be an array of property-name strings`)
  }
  if (record.enum !== undefined && !Array.isArray(record.enum)) {
    throw new TypeError(`${path}.enum: must be an array of allowed values`)
  }
  if (
    record.additionalProperties !== undefined &&
    typeof record.additionalProperties !== "boolean" &&
    !isPlainObject(record.additionalProperties)
  ) {
    throw new TypeError(`${path}.additionalProperties: must be a boolean or a schema object`)
  }
  if (record.nullable !== undefined && typeof record.nullable !== "boolean") {
    throw new TypeError(`${path}.nullable: must be a boolean`)
  }
  if (record.pattern !== undefined && typeof record.pattern !== "string") {
    throw new TypeError(`${path}.pattern: must be a string (a regular expression)`)
  }
  if (typeof record.pattern === "string" && hasNestedQuantifier(record.pattern)) {
    throw new TypeError(
      `${path}.pattern: rejected as ReDoS-prone — a quantifier is applied to a group that already contains one (e.g. (a+)+). Rewrite without nested quantifiers.`
    )
  }
  for (const numKeyword of ["minimum", "maximum"]) {
    const bound = record[numKeyword]
    if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) {
      throw new TypeError(`${path}.${numKeyword}: must be a finite number`)
    }
  }
  // Length/item counts must be non-negative integers (a negative or fractional
  // bound is either a silent no-op or rejects everything).
  for (const countKeyword of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const bound = record[countKeyword]
    if (
      bound !== undefined &&
      (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0)
    ) {
      throw new TypeError(`${path}.${countKeyword}: must be a non-negative integer`)
    }
  }

  if (record.items !== undefined) {
    if (Array.isArray(record.items)) {
      throw new TypeError(
        `${path}.items: tuple-form items are not supported — use a single object schema for all array items`
      )
    }
    // A present `items` must be a schema object — null/primitives are malformed
    // (they would otherwise become a silent "no item constraint").
    assertSupportedJsonSchema(record.items, `${path}.items`, depth + 1)
  }
  if (
    record.additionalProperties !== undefined &&
    typeof record.additionalProperties === "object" &&
    record.additionalProperties !== null
  ) {
    assertSupportedJsonSchema(
      record.additionalProperties,
      `${path}.additionalProperties`,
      depth + 1
    )
  }
  if (record.properties !== undefined) {
    // Must be a plain object — an array passes `typeof === "object"` but
    // validateNode ignores it (isPlainObject), silently dropping the constraints.
    if (!isPlainObject(record.properties)) {
      throw new TypeError(`${path}.properties: must be an object mapping names to schemas`)
    }
    for (const [key, child] of Object.entries(record.properties)) {
      assertSupportedJsonSchema(child, `${path}.${key}`, depth + 1)
    }
  }
  // anyOf and oneOf are independent applicators — when BOTH are present, both are
  // enforced (AND), so each must be preflighted (earlier `anyOf ?? oneOf` skipped
  // oneOf entirely, leaving its sub-schemas unchecked).
  for (const variantKeyword of ["anyOf", "oneOf"]) {
    const variants = record[variantKeyword]
    if (variants === undefined) continue
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new TypeError(`${path}.${variantKeyword}: must be a non-empty array of schemas`)
    }
    variants.forEach((child, index) =>
      assertSupportedJsonSchema(child, `${path}.${variantKeyword}[${index}]`, depth + 1)
    )
  }
}

function validateNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): void {
  if (errors.length >= MAX_ERRORS) return
  if (depth > MAX_DEPTH) {
    // Fail loud instead of silently passing unvalidated branches.
    errors.push(`${path}: schema nesting exceeds depth ${MAX_DEPTH}; value not fully validated`)
    return
  }
  if (typeof schema !== "object" || schema === null) return

  // anyOf = "match AT LEAST one"; oneOf = "match EXACTLY one" (JSON Schema
  // semantics differ — earlier this conflated them, letting a value that matches
  // multiple oneOf branches pass). anyOf wins if both are present.
  // A single variant's match test. Boolean sub-schemas: `true` matches
  // everything, `false` nothing (consistent with a `true` items/property schema
  // meaning "no constraint"); preflight already rejects a top-level `false`.
  const matchesVariant = (candidate: unknown): boolean => {
    if (candidate === true) return true
    if (candidate === false) return false
    if (typeof candidate !== "object" || candidate === null) return false
    const candidateErrors: string[] = []
    validateNode(candidate as Record<string, unknown>, value, path, candidateErrors, depth + 1)
    return candidateErrors.length === 0
  }
  const anyOfVariants = Array.isArray(schema.anyOf) ? schema.anyOf : null
  const oneOfVariants = Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (anyOfVariants?.length || oneOfVariants?.length) {
    // anyOf and oneOf are independent applicators: when both are present BOTH are
    // enforced (AND), so check each rather than letting one shadow the other.
    if (anyOfVariants && anyOfVariants.length > 0) {
      if (anyOfVariants.filter(matchesVariant).length === 0) {
        errors.push(
          `${path}: value does not match any of the ${anyOfVariants.length} anyOf variants`
        )
      }
    }
    if (oneOfVariants && oneOfVariants.length > 0) {
      const matchCount = oneOfVariants.filter(matchesVariant).length
      if (matchCount !== 1) {
        errors.push(
          `${path}: value must match EXACTLY ONE of the ${oneOfVariants.length} oneOf variants (matched ${matchCount})`
        )
      }
    }
    // No early return: anyOf/oneOf are applicators ANDed with sibling assertions
    // (type, minLength, minimum, …) — e.g. `{ anyOf: [{ type: "string" }],
    // minLength: 5 }` must still reject "a". Fall through to validate the rest.
    // (Same JSON-Schema AND rule as const/enum below.)
  }

  if ("const" in schema) {
    if (!deepEquals(schema.const, value)) {
      errors.push(`${path}: must equal the constant ${JSON.stringify(schema.const)}`)
    }
    // No early return: `const` is one assertion ANDed with its siblings (type,
    // minLength, pattern, minimum, …). Returning here would let a schema like
    // `{ const: "x", minLength: 5 }` accept "x"; fall through to validate the rest.
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEquals(candidate, value))) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
    }
    // No early return — same reason as `const` above: `{ enum: ["a"], minLength: 5 }`
    // must still reject "a" on the minLength constraint.
  }

  const types = normalizeTypes(schema.type)
  if (types.length > 0) {
    // OpenAPI-style `nullable: true` widens the declared type with null.
    if (schema.nullable === true && value === null) {
      return
    }
    const actual = jsonTypeOf(value)
    const matches = types.some((expected) => typeMatches(expected, value, actual))
    if (!matches) {
      errors.push(`${path}: expected type ${types.join(" | ")}, got ${actual}`)
      return
    }
  } else if (Array.isArray(schema.required) || isPlainObject(schema.properties)) {
    // A schema with `required`/`properties` but no explicit `type` is implicitly
    // an object schema. Enforce it here, because the per-key `required`/property
    // checks below only run when the value IS a plain object — otherwise a
    // non-object value (e.g. a bare string) would vacuously pass validation.
    if (!(schema.nullable === true && value === null) && !isPlainObject(value)) {
      errors.push(
        `${path}: expected an object (schema declares required/properties), got ${jsonTypeOf(value)}`
      )
      return
    }
  }

  if (typeof value === "string") {
    const minLength = asNumber(schema.minLength)
    const maxLength = asNumber(schema.maxLength)
    if (minLength !== null && value.length < minLength) {
      errors.push(`${path}: string is shorter than minLength ${minLength}`)
    }
    if (maxLength !== null && value.length > maxLength) {
      errors.push(`${path}: string is longer than maxLength ${maxLength}`)
    }
    if (typeof schema.pattern === "string") {
      if (value.length > PATTERN_MAX_INPUT_LENGTH) {
        // Don't run a synchronous regex over a huge string — the main amplifier
        // of catastrophic backtracking. Report instead of risking a CPU stall.
        errors.push(
          `${path}: string is too long (${value.length}) to validate against a pattern (max ${PATTERN_MAX_INPUT_LENGTH})`
        )
      } else {
        try {
          if (!new RegExp(schema.pattern).test(value)) {
            errors.push(`${path}: string does not match pattern ${schema.pattern}`)
          }
        } catch {
          errors.push(`${path}: schema pattern is not a valid regular expression`)
        }
      }
    }
  }

  if (typeof value === "number") {
    const minimum = asNumber(schema.minimum)
    const maximum = asNumber(schema.maximum)
    if (minimum !== null && value < minimum) {
      errors.push(`${path}: number is below minimum ${minimum}`)
    }
    if (maximum !== null && value > maximum) {
      errors.push(`${path}: number is above maximum ${maximum}`)
    }
  }

  if (Array.isArray(value)) {
    const minItems = asNumber(schema.minItems)
    const maxItems = asNumber(schema.maxItems)
    if (minItems !== null && value.length < minItems) {
      errors.push(`${path}: array has fewer than minItems ${minItems}`)
    }
    if (maxItems !== null && value.length > maxItems) {
      errors.push(`${path}: array has more than maxItems ${maxItems}`)
    }
    const items = schema.items
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      for (let index = 0; index < value.length; index += 1) {
        validateNode(
          items as Record<string, unknown>,
          value[index],
          `${path}[${index}]`,
          errors,
          depth + 1
        )
        if (errors.length >= MAX_ERRORS) return
      }
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === "string" && !hasOwn(value, key)) {
        errors.push(`${path}: missing required property "${key}"`)
      }
    }
    const properties = schema.properties
    if (isPlainObject(properties)) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!hasOwn(value, key)) continue
        if (typeof propertySchema !== "object" || propertySchema === null) continue
        validateNode(
          propertySchema as Record<string, unknown>,
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          errors,
          depth + 1
        )
        if (errors.length >= MAX_ERRORS) return
      }
    }
    if (schema.additionalProperties === false) {
      // Enforce even when `properties` is absent (then ANY key is unexpected) —
      // otherwise `{ type:"object", additionalProperties:false }` would vacuously
      // accept extra keys.
      const declaredKeys = isPlainObject(properties) ? properties : {}
      for (const key of Object.keys(value)) {
        if (!hasOwn(declaredKeys, key)) {
          errors.push(`${path}: unexpected property "${key}" (additionalProperties is false)`)
          if (errors.length >= MAX_ERRORS) return
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      // Schema-form additionalProperties: validate keys not covered by
      // `properties` against it instead of silently accepting them.
      const declared = isPlainObject(properties) ? properties : {}
      for (const [key, child] of Object.entries(value)) {
        if (hasOwn(declared, key)) continue
        validateNode(
          schema.additionalProperties as Record<string, unknown>,
          child,
          `${path}.${key}`,
          errors,
          depth + 1
        )
        if (errors.length >= MAX_ERRORS) return
      }
    }
  }
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === "string")
  return []
}

function typeMatches(expected: string, value: unknown, actual: string): boolean {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value)
  if (expected === "number") return typeof value === "number" && Number.isFinite(value)
  return expected === actual
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  const type = typeof value
  if (type === "object") return "object"
  return type
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  )
}
