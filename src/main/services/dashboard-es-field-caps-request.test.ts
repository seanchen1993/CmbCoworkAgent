import { describe, expect, it } from "vitest"
import { prepareDashboardFieldCapsRequest } from "./dashboard-es-field-caps-request"
import { prepareDashboardEsQuery } from "./dashboard-es-query"

describe("ES 7.x field capabilities requests", () => {
  it("puts fields in the URL and keeps index_filter in the POST body", () => {
    const body = {
      fields: ["properties.constraintFiles", "properties.constraintFiles.keyword"],
      include_unmapped: true,
      index_filter: { range: { eventTime: { gte: "2026-10-01" } } }
    }
    const request = prepareDashboardFieldCapsRequest("devclaw_event", body)
    const url = new URL(request.path, "http://localhost")
    expect(request.method).toBe("POST")
    expect(url.pathname).toBe("/devclaw_event/_field_caps")
    expect(url.searchParams.get("fields")).toBe(body.fields.join(","))
    expect(url.searchParams.get("include_unmapped")).toBe("true")
    expect(JSON.parse(request.bodyText!)).toEqual({ index_filter: body.index_filter })
    expect(body.fields).toHaveLength(2)
  })

  it("does not send a body when only fields were requested and encodes URL metacharacters", () => {
    const request = prepareDashboardFieldCapsRequest("events-*", {
      fields: ["a&include_unmapped=true", " properties.* ", "properties.*"]
    })
    const url = new URL(request.path, "http://localhost")
    expect(url.searchParams.get("fields")).toBe("a&include_unmapped=true,properties.*")
    expect(url.searchParams.get("include_unmapped")).toBeNull()
    expect(request.bodyText).toBeUndefined()
  })

  it.each([undefined, null, [], "", [""], [" "], ["valid", null], 1])(
    "rejects invalid fields before contacting ES: %j",
    (fields) => {
      expect(() => prepareDashboardFieldCapsRequest("events", { fields })).toThrow("fields")
    }
  )

  it("also fixes the dashboard analysis query path without changing search requests", () => {
    const options = { indexByAlias: { event: "events", trace: "traces" } }
    const request = prepareDashboardEsQuery(
      { indexAlias: "event", operation: "field_caps", body: { fields: ["eventTime"] } },
      options
    )
    expect(new URL(request.path, "http://localhost").searchParams.get("fields")).toBe("eventTime")
    expect(request.bodyText).toBeUndefined()
    const other = prepareDashboardEsQuery(
      { indexAlias: "event", operation: "field_caps", body: { fields: ["properties.pluginId"] } },
      options
    )
    expect(other.audit.bodyHash).not.toBe(request.audit.bodyHash)
    expect(
      new URL(
        prepareDashboardEsQuery({ indexAlias: "event", operation: "field_caps" }, options).path,
        "http://localhost"
      ).searchParams.get("fields")
    ).toBe("*")
    const search = prepareDashboardEsQuery(
      { indexAlias: "trace", operation: "search", body: { size: 0 } },
      options
    )
    expect(search.path).toBe("/traces/_search?timeout=10s")
    expect(JSON.parse(search.bodyText!)).toMatchObject({ size: 0 })
  })
})
