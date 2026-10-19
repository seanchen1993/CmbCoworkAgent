import { parseFunctionUserConfig } from "../../shared/mods/v2/user-config"

const credentialKey = /(?:token|secret|password|api[-_]?key|authorization|credential)/i
const placeholder = /^\$\{[^{}]+\}$/
const schemaMetadata = new Set([
  "type",
  "title",
  "description",
  "required",
  "options",
  "multiple",
  "sensitive",
  "min",
  "max"
])

/** Display projection only. Original package bytes, configuration and hashes are never changed. */
export function redactPluginSourceCredentials(input: unknown): {
  value: unknown
  redacted: boolean
} {
  let redacted = false
  const hideValue = (value: unknown, typedSecret = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => hideValue(item, typedSecret))
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, hideValue(item, typedSecret)])
      )
    if (typeof value === "string") {
      if (!value.trim() || placeholder.test(value)) return value
      redacted = true
      return "[redacted]"
    }
    if (typedSecret && (typeof value === "boolean" || typeof value === "number")) {
      redacted = true
      return "[redacted]"
    }
    return value
  }
  const visit = (value: unknown, inheritedCredential = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, inheritedCredential))
    if (!value || typeof value !== "object") return inheritedCredential ? hideValue(value) : value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === "userConfig" && item && typeof item === "object" && !Array.isArray(item)) {
          return [
            key,
            Object.fromEntries(
              Object.entries(item).map(([fieldKey, declaration]) => {
                let field: Record<string, unknown> | undefined
                try {
                  // Validate the real supported schema instead of interpreting a password-shaped
                  // object as a configuration field. Human labels are metadata, never credentials.
                  field = parseFunctionUserConfig({ [fieldKey]: declaration })![fieldKey]
                } catch {
                  // A malformed declaration carrying an explicit sensitive marker still cannot
                  // expose its default merely because native schema validation rejected it.
                  if (declaration && typeof declaration === "object" && !Array.isArray(declaration))
                    field = declaration as Record<string, unknown>
                }
                if (!field)
                  return [
                    fieldKey,
                    visit(declaration, inheritedCredential || credentialKey.test(fieldKey))
                  ]
                const secret =
                  inheritedCredential || field.sensitive === true || credentialKey.test(fieldKey)
                return [
                  fieldKey,
                  Object.fromEntries(
                    Object.entries(field).map(([name, entry]) => [
                      name,
                      secret && name === "default"
                        ? hideValue(entry, field.sensitive === true)
                        : schemaMetadata.has(name)
                          ? entry
                          : visit(entry, secret || credentialKey.test(name))
                    ])
                  )
                ]
              })
            )
          ]
        }
        return [key, visit(item, inheritedCredential || credentialKey.test(key))]
      })
    )
  }
  const value = visit(input)
  return { value, redacted }
}
