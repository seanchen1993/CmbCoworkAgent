import { describe, expect, it } from "vitest"
import { BackendNotConfiguredError, isBackendNotConfiguredError, resolveBackendEndpoint } from "./backend-endpoint"

describe("optional backend endpoints", () => {
  it.each([undefined, null, "", "  ", "/proxy", "./proxy", "proxy", "api/proxy", "//host", "file:///C:/gw", "ftp://host"])(
    "rejects %s before fetch in a packaged file document", (base) => {
      expect(() => resolveBackendEndpoint(base, "/api/list", "市场", "file:"))
        .toThrow(BackendNotConfiguredError)
    }
  )

  it("preserves configured prefix and concatenation without exposing configuration in errors", () => {
    expect(resolveBackendEndpoint("https://example.test/prefix", "/api/list", "市场", "file:"))
      .toBe("https://example.test/prefix/api/list")
    expect(resolveBackendEndpoint("http://localhost:3000/", "/api/list", "市场", "file:"))
      .toBe("http://localhost:3000//api/list")
    expect(() => resolveBackendEndpoint("https://", "/list", "市场", "file:"))
      .toThrow("未配置有效的市场地址，本地功能仍可使用。")
  })

  it.each(["http:", "https:"])("preserves valid same-origin proxy paths on %s", (protocol) => {
    expect(resolveBackendEndpoint("", "/api/list", "市场", protocol)).toBe("/api/list")
    expect(resolveBackendEndpoint("/proxy", "/api/list", "市场", protocol)).toBe("/proxy/api/list")
    expect(resolveBackendEndpoint("./proxy", "/api/list", "市场", protocol)).toBe("./proxy/api/list")
    expect(resolveBackendEndpoint("proxy", "/api/list", "市场", protocol)).toBe("proxy/api/list")
    expect(resolveBackendEndpoint("api/proxy", "/api/list", "市场", protocol)).toBe("api/proxy/api/list")
    expect(resolveBackendEndpoint("//gateway.test/proxy", "/api/list", "市场", protocol))
      .toBe("//gateway.test/proxy/api/list")
  })

  it.each(["javascript:alert(1)", "data:text/plain,hello", "file:///C:/gw", "ftp://host", "mailto:host"])(
    "rejects non-HTTP schemes even on a web document: %s", (base) => {
      expect(() => resolveBackendEndpoint(base, "/api/list", "市场", "https:"))
        .toThrow(BackendNotConfiguredError)
    }
  )

  it("does not classify transport errors or copied codes as local configuration failures", () => {
    expect(isBackendNotConfiguredError(new BackendNotConfiguredError("市场"))).toBe(true)
    expect(isBackendNotConfiguredError(new TypeError("Failed to fetch"))).toBe(false)
    expect(isBackendNotConfiguredError({ code: "BACKEND_NOT_CONFIGURED" })).toBe(false)
  })
})
