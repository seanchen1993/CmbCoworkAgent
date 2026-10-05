import { operations as positives } from "../../../contracts/bot/v1/fixtures/positive.mjs"

export function parityFixtures(documents, closure) {
  const defs = documents["schemas.json"].$defs, result = []
  const add = (id, schema, value, raw) => result.push({ id, schema, json: raw ?? JSON.stringify(value) })
  function sample(schema) {
    if (schema.$ref) return sample(defs[schema.$ref.split("/").at(-1)])
    if (schema.enum) return schema.enum[0]
    if (schema.type === "string") return schema.format ? "2026-10-01T12:00:00Z" : "a"
    if (schema.type === "integer") return schema.minimum
    if (schema.type === "boolean") return false
    if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items))
    return Object.fromEntries((schema.required ?? []).map(key => [key, sample(schema.properties[key])]))
  }
  const names = closure.reachable.map(ref => ref.split("/$defs/")[1])
  for (const name of names) {
    const schema = defs[name], value = sample(schema)
    add(`definition.${name}.positive`, name, value)
    add(`definition.${name}.null`, name, null)
    function constraints(child, base, path, label) {
      if (child.$ref) child = defs[child.$ref.split("/").at(-1)]
      const mutate = replacement => {
        if (!path.length) return replacement
        const copy = structuredClone(base)
        let current = copy
        for (const key of path.slice(0, -1)) current = current[key]
        current[path.at(-1)] = replacement
        return copy
      }
      if (child.enum) {
        for (const wire of child.enum) add(`${label}.enum.${wire}`, name, mutate(wire))
        add(`${label}.enum.invalid`, name, mutate("INVALID_WIRE"))
      }
      if (child.type === "string") {
        if (child.minLength !== undefined) add(`${label}.length.below`, name, mutate(""))
        if (child.maxLength !== undefined) {
          for (const char of ["中", "😀"]) {
            add(`${label}.length.${char}.max`, name, mutate(char.repeat(child.maxLength)))
            add(`${label}.length.${char}.over`, name, mutate(char.repeat(child.maxLength + 1)))
          }
        }
      }
      if (child.type === "integer") {
        for (const n of [child.minimum - 1, child.minimum, child.maximum, child.maximum + 1, 1.5, "1", false]) add(`${label}.integer.${JSON.stringify(n)}`, name, mutate(n))
      }
      if (child.type === "boolean") { add(`${label}.boolean.true`, name, mutate(true)); add(`${label}.boolean.string`, name, mutate("false")) }
      if (child.type === "array") {
        add(`${label}.array.empty`, name, mutate([]))
        const one = sample(child.items)
        add(`${label}.array.duplicate`, name, mutate([one, one]))
        // Distinct legal IDs or closed structures test both size and uniqueItems independently.
        const many = Array.from({ length: child.maxItems }, (_, index) => {
          const value = structuredClone(one)
          const item = child.items.$ref ? defs[child.items.$ref.split("/").at(-1)] : child.items
          if (typeof value === "string") return item.enum ? item.enum[index % item.enum.length] : `id${index}`
          for (const key of Object.keys(value)) if (/Id$/.test(key)) value[key] = `id${index}`
          return value
        })
        add(`${label}.array.max`, name, mutate(many))
        add(`${label}.array.over`, name, mutate([...many, one]))
      }
      if (child.type === "object") {
        const extra = { ...sample(child), unexpectedField: true }
        add(`${label}.object.unknown`, name, mutate(extra))
        for (const [key, field] of Object.entries(child.properties)) {
          const parent = sample(child), missing = { ...parent }; delete missing[key]
          add(`${label}.${key}.missing`, name, mutate(missing))
          add(`${label}.${key}.null`, name, mutate({ ...parent, [key]: null }))
          constraints(field, base, [...path, key], label + "." + key)
        }
      }
    }
    constraints(schema, value, [], `definition.${name}`)
  }
  const api = documents["openapi.json"]
  const deref = value => value.$ref ? value.$ref.slice(2).split("/").reduce((node, key) => node[key], api) : value
  const schemaName = schema => schema.$ref.split("/").at(-1)
  for (const operation of closure.operations) {
    const original = api.paths[operation.path][operation.method], fixture = positives.find(value => value.operationId === operation.id)
    if (original.requestBody) add(`operation.${operation.id}.request`, schemaName(deref(original.requestBody).content["application/json"].schema), fixture.request.body)
    for (const [status, ref] of Object.entries(original.responses)) {
      const success = fixture.responses.find(value => String(value.status) === status)
      const code = Object.keys(api["x-error-status"]).find(key => String(api["x-error-status"][key]) === status)
      add(`operation.${operation.id}.response.${status}`, schemaName(deref(ref).content["application/json"].schema), success?.body ?? { requestId: "request1", error: { code, message: "Safe synthetic error", retryable: false } })
    }
    for (const ref of api.paths[operation.path].parameters ?? []) {
      const parameter = deref(ref)
      add(`operation.${operation.id}.parameter.${parameter.name}`, schemaName(parameter.schema), parameter.in === "path" ? fixture.request.path[parameter.name] : fixture.request.headers[parameter.name])
    }
  }
  for (const end of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) for (const name of ["Id", "UtcDateTime"]) add(`pattern.${name}.suffix.${JSON.stringify(end)}`, name, (name === "Id" ? "id1" : "2026-10-01T12:00:00Z") + end)
  for (const date of ["2026-10-01T12:00:00Z", "2026-10-01t12:00:00Z", "2026-10-01T12:00:00z", "2026-02-30T12:00:00Z", "2026-13-01T12:00:00Z", "2026-00-01T12:00:00Z", "2026-01-00T12:00:00Z", "2026-10-01T12:00:00+00:00", "2016-12-31T23:59:60Z", "2016-12-31T22:59:60Z"]) add(`date.${date}`, "UtcDateTime", date)
  for (let count = 1; count <= 10; count++) add(`date.fraction.${count}`, "UtcDateTime", `2026-10-01T12:00:00.${"1".repeat(count)}Z`)
  for (const json of ["1", "1.0", "1e0", "9007199254740991", "9007199254740992", "0", "-1", "1.5"]) add(`version.raw.${json}`, "Version", undefined, json)
  for (const retryable of [true, false]) for (const code of ["OUTCOME_UNKNOWN", "INVALID_PAYLOAD"]) add(`conditional.${code}.${retryable}`, "ErrorResponse", { requestId: "request1", error: { code, message: "Safe error", retryable } })
  if (new Set(result.map(value => value.id)).size !== result.length) throw new Error("B01_PARITY_DUPLICATE_ID")
  return result
}
