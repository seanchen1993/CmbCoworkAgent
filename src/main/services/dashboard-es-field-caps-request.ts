/** ES 7.x reads fields from the URL, even for a POST request. */
export function prepareDashboardFieldCapsRequest(
  index: string,
  body: Record<string, unknown>
): { method: "POST"; path: string; bodyText?: string } {
  const { fields, include_unmapped, ...requestBody } = body
  const names = typeof fields === "string" ? fields.split(",") : fields
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || !name.trim())
  ) {
    throw new Error("ES field_caps requires a non-empty list of fields")
  }
  const parameters = new URLSearchParams({
    fields: [...new Set(names.map((name: string) => name.trim()))].join(",")
  })
  if (include_unmapped !== undefined) {
    if (typeof include_unmapped !== "boolean") {
      throw new Error("ES field_caps include_unmapped must be a boolean")
    }
    parameters.set("include_unmapped", String(include_unmapped))
  }
  return {
    method: "POST",
    path: `/${index}/_field_caps?${parameters}`,
    ...(Object.keys(requestBody).length ? { bodyText: JSON.stringify(requestBody) } : {})
  }
}
