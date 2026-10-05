import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const files = ["schemas.json", "openapi.json", "state-transitions.json"]
const selected = new Set(["createBot", "getBot", "createBotVersion", "createGroup", "getGroup", "updateGroupMembers"])
const annotations = ["description", "title"]
const identifier = /^[A-Za-z][A-Za-z0-9]*$/
const fail = (where, reason) => { throw new Error(`${where}: ${reason}`) }
const keys = (value, allowed, where) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(where, "nonobject structure")
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unsupported keyword ${key}`)
}
const upper = value => value[0].toUpperCase() + value.slice(1)
const enumKey = value => value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()
const javaName = value => {
  const name = value.replace(/[^A-Za-z0-9]+(.)/g, (_, letter) => letter.toUpperCase())
  if (!identifier.test(name) || ["class", "enum", "interface", "default", "package", "public", "private", "protected", "static", "final", "return", "new", "this", "void", "long", "boolean", "null", "true", "false", "switch", "case", "if", "else", "for", "while", "try", "catch", "throw", "throws", "extends", "implements", "instanceof", "import", "int", "byte", "short", "char", "float", "double", "super", "abstract", "assert", "break", "continue", "do", "native", "strictfp", "synchronized", "transient", "volatile", "const", "goto"].includes(name)) fail(value, "unsupported Java identifier")
  return name
}

// The operation allowlist scopes traversal; every payload/parameter type comes from OpenAPI.
export function generate(documents, digest = "in-memory-fixture") {
  const openapi = documents["openapi.json"]
  if (openapi?.openapi !== "3.1.0") fail("openapi.json", "unsupported dialect")
  for (const file of ["schemas.json", "state-transitions.json"])
    if (documents[file]?.$schema !== "https://json-schema.org/draft/2020-12/schema") fail(file, "unsupported dialect")
  keys(documents["schemas.json"], ["$schema", "$id", "$defs"], "schemas.json")
  keys(documents["state-transitions.json"], ["$schema", "$id", "$defs", "x-state-transitions", "x-reconciliation", "x-mode-capabilities"], "state-transitions.json")
  const reachable = new Map(), declarations = new Map(), processing = new Set()
  const declare = (name, text) => {
    javaName(name)
    if (declarations.has(name) && declarations.get(name) !== text) fail(name, "Java declaration collision")
    declarations.set(name, text)
  }
  function reference(ref, file) {
    if (typeof ref !== "string") fail(file, "invalid reference")
    const match = /^(?:(\.\/)?(schemas\.json|state-transitions\.json))?#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(ref)
    if (!match) fail(file, `nonlocal/unsupported reference ${ref}`)
    const target = match[2] ?? file, name = match[3], schema = documents[target]?.$defs?.[name]
    if (!schema) fail(ref, "unresolved reference")
    const id = `${target}#/$defs/${name}`
    if (reachable.has(id)) return reachable.get(id)
    if (processing.has(id)) fail(id, "recursive schema unsupported")
    processing.add(id)
    const type = visit(schema, target, name, id)
    processing.delete(id)
    reachable.set(id, type)
    return type
  }
  function refinement(value, parent, file, where) {
    keys(value, ["type", "properties", "required"], where)
    if (value.type !== "object") fail(where, "object refinement required")
    keys(value.properties, Object.keys(parent.properties), where + "/properties")
    if (!Array.isArray(value.required) || value.required.some(key => !Object.hasOwn(value.properties, key))) fail(where, "invalid refinement required")
    for (const [key, child] of Object.entries(value.properties)) {
      keys(child, ["const"], where + "/" + key)
      if (!["string", "boolean"].includes(typeof child.const)) fail(where, "unsupported refinement const")
      let base = parent.properties[key]
      const seen = new Set()
      while (base.$ref) {
        if (seen.has(base.$ref)) fail(where, "recursive refinement reference")
        seen.add(base.$ref)
        const match = /^(?:(?:\.\/)?(schemas\.json|state-transitions\.json))?#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(base.$ref)
        if (!match) fail(where, "nonlocal refinement reference")
        base = documents[match[1] ?? file]?.$defs?.[match[2]]
        if (!base) fail(where, "unresolved refinement reference")
      }
      if (base.type !== typeof child.const || (base.enum && !base.enum.includes(child.const))) fail(where, "incompatible refinement const")
    }
  }
  function visit(schema, file, name, where) {
    if (schema?.$ref !== undefined) {
      keys(schema, ["$ref", ...annotations], where)
      return reference(schema.$ref, file)
    }
    const shape = {
      string: ["minLength", "maxLength", "pattern", "format", "enum"],
      integer: ["minimum", "maximum"], boolean: [],
      array: ["items", "minItems", "maxItems", "uniqueItems"],
      object: ["properties", "required", "additionalProperties", "if", "then"]
    }[schema?.type]
    if (!shape) fail(where, "unsupported/missing schema type")
    keys(schema, ["type", ...annotations, ...shape], where)
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"])
      if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail(where, `invalid ${key}`)
    if (schema.minLength > schema.maxLength || schema.minItems > schema.maxItems) fail(where, "inverted bounds")
    switch (schema.type) {
      case "string": {
        if (schema.pattern !== undefined) {
          if (typeof schema.pattern !== "string") fail(where, "invalid pattern")
          try { new RegExp(schema.pattern, "u") } catch { fail(where, "invalid pattern") }
        }
        if (schema.format !== undefined && schema.format !== "date-time") fail(where, "unsupported format")
        if (schema.enum === undefined) return "String"
        if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(value => typeof value !== "string") || new Set(schema.enum).size !== schema.enum.length) fail(where, "unsupported enum")
        const names = schema.enum.map(enumKey)
        if (names.some(value => !/^[A-Z][A-Z0-9_]*$/.test(value)) || new Set(names).size !== names.length) fail(where, "enum identifier collision")
        declare(name, `    public enum ${name} {\n${schema.enum.map((value, index) => `        ${names[index]}(${JSON.stringify(value)})`).join(",\n")};\n        private final String wire;\n        ${name}(String wire) { this.wire = wire; }\n        @JsonValue public String wire() { return wire; }\n        @JsonCreator public static ${name} fromWire(String wire) {\n            for (${name} value : values()) if (value.wire.equals(wire)) return value;\n            throw new IllegalArgumentException("Unknown ${name} wire value");\n        }\n    }`)
        return name
      }
      case "integer":
        if (!Number.isSafeInteger(schema.minimum) || !Number.isSafeInteger(schema.maximum) || schema.minimum > schema.maximum) fail(where, "finite safe integer bounds required")
        return "Long"
      case "boolean": return "Boolean"
      case "array":
        if (!Number.isSafeInteger(schema.maxItems) || (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean")) fail(where, "bounded array required")
        return `List<${visit(schema.items, file, name + "Item", where + "/items")}>`
      case "object": {
        if (schema.additionalProperties !== false) fail(where, "open object unsupported")
        keys(schema.properties, Object.keys(schema.properties ?? {}), where + "/properties")
        const required = schema.required ?? []
        if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(key => !Object.hasOwn(schema.properties, key))) fail(where, "invalid required")
        if (schema.if !== undefined || schema.then !== undefined) {
          if (!schema.if || !schema.then) fail(where, "paired if/then required")
          refinement(schema.if, schema, file, where + "/if")
          refinement(schema.then, schema, file, where + "/then")
        }
        const fields = Object.entries(schema.properties).map(([key, child]) => {
          const field = javaName(key)
          if (field !== key) fail(where, "property Java name mismatch")
          const type = visit(child, file, name + upper(key), where + "/properties/" + key)
          return `        @JsonProperty(value = ${JSON.stringify(key)}, required = ${required.includes(key)})\n${required.includes(key) ? "        @JsonInclude(JsonInclude.Include.ALWAYS)\n" : ""}        public ${type} ${field};`
        })
        declare(name, `    @JsonInclude(JsonInclude.Include.NON_NULL)\n    public static final class ${name} {\n${fields.join("\n")}\n    }`)
        return name
      }
    }
  }
  function component(value, where, seen = new Set()) {
    if (!value?.$ref) return value
    keys(value, ["$ref"], where)
    if (typeof value.$ref !== "string" || !/^#\/components\/(parameters|requestBodies|responses|headers)\/[A-Za-z][A-Za-z0-9]*$/.test(value.$ref)) fail(where, "nonlocal component reference")
    if (seen.has(value.$ref)) fail(where, "component reference cycle")
    seen.add(value.$ref)
    const target = value.$ref.slice(2).split("/").reduce((node, key) => node?.[key], openapi)
    if (!target) fail(where, "unresolved component")
    return component(target, where, seen)
  }
  const payload = (value, where) => {
    const content = component(value, where)?.content
    if (!content || Object.keys(content).length !== 1 || !content["application/json"]?.schema) fail(where, "JSON schema payload required")
    return visit(content["application/json"].schema, "openapi.json", upper(where.replace(/[^A-Za-z0-9]/g, "")), where)
  }
  const operations = []
  for (const [path, item] of Object.entries(openapi.paths ?? {})) for (const [method, operation] of Object.entries(item)) {
    if (!selected.has(operation?.operationId)) continue
    const id = operation.operationId
    if (operations.some(value => value.id === id)) fail(id, "duplicate operation")
    if (!["get", "post", "put"].includes(method)) fail(id, "unsupported method")
    const args = [], parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
    const parameterNames = new Set()
    for (const parameterRef of parameters) {
      const parameter = component(parameterRef, id)
      if (!["header", "path"].includes(parameter?.in) || parameter.required !== true || parameterNames.has(parameter.name)) fail(id, "unsupported/duplicate parameter")
      parameterNames.add(parameter.name)
      const type = visit(parameter.schema, "openapi.json", upper(id) + "Parameter", id + "/" + parameter.name)
      args.push(`${type} ${javaName(parameter.name[0].toLowerCase() + parameter.name.slice(1))}`)
    }
    const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
    if (pathNames.some(name => !parameters.some(ref => { const p = component(ref, id); return p.in === "path" && p.name === name }))) fail(id, "missing path parameter")
    if (operation.requestBody) args.push(`${payload(operation.requestBody, id + "Request")} body`)
    const results = new Set(), errors = new Set()
    for (const [status, responseRef] of Object.entries(operation.responses ?? {})) {
      if (!/^[245][0-9]{2}$/.test(status)) fail(id, "unsupported response status")
      const response = component(responseRef, id)
      const type = payload(response, id + "Response" + status)
      ;(status.startsWith("2") ? results : errors).add(type)
      for (const [header, ref] of Object.entries(response.headers ?? {})) visit(component(ref, id).schema, "openapi.json", upper(id) + "Header" + javaName(header), id + "/header/" + header)
    }
    if (results.size !== 1 || errors.size !== 1) fail(id, "single success/error type required")
    operations.push({ id, method, path, args, result: [...results][0], error: [...errors][0] })
  }
  if (operations.length !== selected.size) fail("OpenAPI", "six selected operations required")
  operations.sort((a, b) => a.id.localeCompare(b.id, "en"))
  const text = [
    "// Generated offline by scripts/generate-bot-java-contracts.mjs. DO NOT EDIT.",
    `// Exact source SHA-256: ${digest}`,
    "// Structural DTOs only; original Schema bounds, required/null and if/then need runtime validation.",
    `// Reachable definitions: ${[...reachable.keys()].sort().join(", ")}`,
    "package com.devclaw.botcontrol.contracts;", "",
    "import java.util.List;", "import com.fasterxml.jackson.annotation.JsonCreator;",
    "import com.fasterxml.jackson.annotation.JsonInclude;", "import com.fasterxml.jackson.annotation.JsonProperty;",
    "import com.fasterxml.jackson.annotation.JsonValue;", "",
    "public final class BotContracts {", "    private BotContracts() {}", "",
    ...[...declarations.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, value]) => value + "\n"),
    "    // Typed consumer port only; no server, implementation or authorization implied.",
    "    public interface Operations {",
    ...operations.map(op => `        // ${op.method.toUpperCase()} ${op.path}; error: ${op.error}\n        ${op.result} ${op.id}(${op.args.join(", ")});`),
    "    }", "}", ""
  ].join("\n")
  return { text, reachable: [...reachable.keys()].sort(), operations }
}

export function main(args = process.argv.slice(2)) {
  let check = false, contractDir = resolve(root, "contracts/bot/v1"), output = resolve(root, "services/bot-control/src/main/java/com/devclaw/botcontrol/contracts/BotContracts.java")
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) fail("arguments", "duplicate flag")
    seen.add(flag)
    if (flag === "--check") check = true
    else if (["--contract-dir", "--output"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) {
      if (flag === "--contract-dir") contractDir = resolve(args[++i]); else output = resolve(args[++i])
    } else fail("arguments", "unsupported argument")
  }
  const documents = {}, hash = createHash("sha256")
  for (const file of files) { const bytes = readFileSync(resolve(contractDir, file)); hash.update(file + "\0").update(bytes); documents[file] = JSON.parse(bytes.toString("utf8")) }
  const result = generate(documents, hash.digest("hex"))
  if (check) {
    let existing
    try { existing = readFileSync(output, "utf8") } catch (error) { if (error.code !== "ENOENT") throw error }
    if (existing !== result.text) fail(output, "generated Java drift (run generator explicitly)")
  } else { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, result.text) }
  console.log(`Bot Java contracts: ${result.operations.length} operations, ${result.reachable.length} reachable definitions; ${check ? "checked without writes" : "generated"}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
