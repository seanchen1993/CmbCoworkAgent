import { describe, expect, it } from "vitest"
import {
  redactAndTruncateSensitiveText,
  redactLogValue,
  redactLogValues,
  redactPossiblyTruncatedSensitiveText,
  redactSensitiveText
} from "./log-redaction"

describe("log redaction", () => {
  it("partially masks Chinese ID cards and mobile phone numbers", () => {
    const redacted = redactSensitiveText(
      "身份证 11010119900307123X，旧证 110101900307123，手机 13800138000 / +86-139-1234-5678"
    )

    expect(redacted).toBe(
      "身份证 110101********123X，旧证 110101*****7123，手机 138****8000 / +86-139-****-5678"
    )
  })

  it("redacts secret assignments, authorization headers, tokens, and private keys", () => {
    const jwt = "eyJabcdefghijk.abcdefghijklmnop.qrstuvwxyzabcdef"
    const redacted = redactSensitiveText(
      [
        'password="InternalPass123"',
        '"access_token":"internal-token-value"',
        "密码: 含 空格 的口令",
        "Authorization: Bearer abcdefghijklmnop",
        `jwt=${jwt}`,
        "-----BEGIN RSA PRIVATE KEY-----\nprivate-material\n-----END RSA PRIVATE KEY-----"
      ].join("\n")
    )

    expect(redacted).not.toContain("InternalPass123")
    expect(redacted).not.toContain("internal-token-value")
    expect(redacted).not.toContain("含 空格 的口令")
    expect(redacted).not.toContain("abcdefghijklmnop")
    expect(redacted).not.toContain("private-material")
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it("fails closed for unterminated private keys and truncated URL credentials", () => {
    const redactedKey = redactSensitiveText(
      [
        "before-key",
        "-----BEGIN RSA PRIVATE KEY-----",
        "private-key-material-without-an-end-marker"
      ].join("\n")
    )
    const redactedUrl = redactSensitiveText(
      "request=https://build-user:url-password-prefix…[truncated 4096 chars]"
    )
    const redactedAssignments = redactSensitiveText(
      "password=assignment-secret-prefix…[truncated 4096 chars]\n" +
        "authorization=Bearer authorization-secret-prefix…[truncated 4096 chars]"
    )

    expect(redactedKey).toContain("before-key")
    expect(redactedKey).not.toContain("private-key-material")
    expect(redactedKey).toContain("[REDACTED]")
    expect(redactedUrl).not.toContain("url-password-prefix")
    expect(redactedUrl).toContain("https://[REDACTED]…[truncated 4096 chars]")
    expect(redactedAssignments).not.toContain("assignment-secret-prefix")
    expect(redactedAssignments).not.toContain("authorization-secret-prefix")

    const completeBlock = redactSensitiveText(
      [
        "-----BEGIN PRIVATE KEY-----",
        "complete-private-material",
        "-----END PRIVATE KEY-----",
        "diagnostic-after-complete-key"
      ].join("\n")
    )
    expect(completeBlock).not.toContain("complete-private-material")
    expect(completeBlock).toContain("diagnostic-after-complete-key")

    const longCredential = `https://build-user:${"p".repeat(10_000)}@host/path`
    const boundedCredential = redactAndTruncateSensitiveText(
      longCredential,
      256,
      (omittedChars) => `\n...[truncated ${omittedChars} chars]`
    )
    expect(boundedCredential).not.toContain("p".repeat(32))
    expect(boundedCredential).toContain("https://[REDACTED]")

    const upstreamTruncatedCredential = redactPossiblyTruncatedSensitiveText(
      `request=https://build-user:${"upstream-password-fragment".repeat(100)}`
    )
    expect(upstreamTruncatedCredential).toContain("https://[REDACTED]")
    expect(upstreamTruncatedCredential).not.toContain("upstream-password-fragment")

    expect(redactSensitiveText("https://:empty-user-password@host/path")).toBe(
      "https://[REDACTED]@host/path"
    )
    expect(redactPossiblyTruncatedSensitiveText("https://:empty-user-password-prefix")).toBe(
      "https://[REDACTED]"
    )
  })

  it("fails closed for PII cut at an actual truncation boundary", () => {
    expect(redactAndTruncateSensitiveText("note=13800138000-tail", 15, "...[cut]")).toBe(
      "note=[REDACTED]...[cut]"
    )
    expect(redactAndTruncateSensitiveText("id=110101199003071234-tail", 20, "...[cut]")).toBe(
      "id=[REDACTED]...[cut]"
    )
    expect(redactAndTruncateSensitiveText("id=110101900307123-tail", 17, "...[cut]")).toBe(
      "id=[REDACTED]...[cut]"
    )
    expect(redactAndTruncateSensitiveText("email=zhangsan@example.com-tail", 22, "...[cut]")).toBe(
      "email=[REDACTED]...[cut]"
    )
    expect(redactAndTruncateSensitiveText("port=3000 extra", 9, "...[cut]")).toBe(
      "port=3000...[cut]"
    )
    expect(redactSensitiveText("open http://localhost:3000")).toContain("localhost:3000")
    expect(redactPossiblyTruncatedSensitiveText("note=1380013800")).toBe("note=[REDACTED]")
    expect(redactPossiblyTruncatedSensitiveText("id=11010190030712")).toBe("id=[REDACTED]")
    expect(redactSensitiveText("email=zhangsan@exampl…[truncated 5 chars]")).toBe(
      "email=[REDACTED]…[truncated 5 chars]"
    )
    const formattedPhone = "phone=+86-138-0013-8000-tail"
    const formattedPrefix = "phone=+86-138-0013-800"
    expect(redactAndTruncateSensitiveText(formattedPhone, formattedPrefix.length, "...[cut]")).toBe(
      "phone=[REDACTED]...[cut]"
    )
    expect(redactPossiblyTruncatedSensitiveText("phone=138 0013 800")).toBe("phone=[REDACTED]")
    expect(redactSensitiveText("phone=138-0013-800…[truncated 1 chars]")).toBe(
      "phone=[REDACTED]…[truncated 1 chars]"
    )
    expect(redactSensitiveText("jwt=eyJheader.eyJpayloadsecret…[truncated 20 chars]")).toBe(
      "jwt=[REDACTED]…[truncated 20 chars]"
    )
    expect(redactSensitiveText("auth sk-partialtoken…[truncated 20 chars]")).toBe(
      "auth [REDACTED]…[truncated 20 chars]"
    )
  })

  it("redacts assignment keys after shell, URL, and path boundaries", () => {
    const source =
      "/password=slash-secret \\token=windows-secret $password=dollar-secret " +
      "#access_token=fragment-secret |session id=session-secret"
    const redacted = redactSensitiveText(source)
    expect(redacted).not.toContain("slash-secret")
    expect(redacted).not.toContain("windows-secret")
    expect(redacted).not.toContain("dollar-secret")
    expect(redacted).not.toContain("fragment-secret")
    expect(redacted).not.toContain("session-secret")
    expect(redactSensitiveText("ordinarykey=safe")).toBe("ordinarykey=safe")
    expect(redactLogValue(/password=regexp-secret/)).not.toContain("regexp-secret")
    expect(redactSensitiveText("status=ok password=plain-secret")).toBe(
      "status=ok password=[REDACTED]"
    )
    expect(redactSensitiveText("password=two word secret")).toBe("password=[REDACTED]")
    for (const key of [
      "authorizationCode",
      "authorization-code",
      "authorization_code",
      "oauthCode",
      "oauth-code",
      "yst_code"
    ]) {
      expect(redactSensitiveText(`${key}=code-secret`)).not.toContain("code-secret")
    }
  })

  it("redacts a 64KiB no-match string in bounded linear time", () => {
    const input = "a".repeat(64 * 1024)
    const startedAt = performance.now()
    const redacted = redactSensitiveText(input)
    const elapsedMs = performance.now() - startedAt

    expect(redacted).toBe(input)
    expect(elapsedMs).toBeLessThan(250)
  })

  it("redacts assignment keys across and beyond the bounded classifier length", () => {
    for (const keyLength of [64, 65, 256, 257, 2_048]) {
      const suffix = "password"
      const key = `${"a".repeat(keyLength - suffix.length)}${suffix}`
      const redacted = redactSensitiveText(`${key}=SECRET-XYZ-PLAIN`)
      expect(redacted).not.toContain("SECRET-XYZ-PLAIN")
      expect(redacted).toContain("[REDACTED]")
    }
  })

  it("scans repeated URL authorities linearly without rescanning prior prefixes", () => {
    const buildInput = (chars: number): string =>
      "request https://host.example/path ".repeat(Math.ceil(chars / 34)).slice(0, chars)
    const measure = (input: string): number => {
      const startedAt = performance.now()
      for (let index = 0; index < 20; index += 1) redactSensitiveText(input)
      return performance.now() - startedAt
    }

    measure(buildInput(4 * 1024))
    const elapsed16KiB = measure(buildInput(16 * 1024))
    const elapsed32KiB = measure(buildInput(32 * 1024))
    const elapsed64KiB = measure(buildInput(64 * 1024))

    expect(elapsed32KiB).toBeLessThan(elapsed16KiB * 6 + 10)
    expect(elapsed64KiB).toBeLessThan(elapsed32KiB * 6 + 10)
    expect(elapsed64KiB).toBeLessThan(250)
  })

  it("bounds individual and aggregate string projection before scanning sensitive tails", () => {
    const oversized = `${"a".repeat(128 * 1024)}password=omitted-tail-secret`
    const redacted = redactLogValue(oversized) as string
    const manyStrings = redactLogValues(
      Array.from({ length: 16 }, (_, index) => `${index}:${"b".repeat(64 * 1024)}`)
    )

    expect(redacted.length).toBeLessThan(70 * 1024)
    expect(redacted).not.toContain("omitted-tail-secret")
    expect(redacted).toContain("[Truncated: text limit]")
    expect(manyStrings).toContain("[Truncated: text budget]")
  })

  it("bounds oversized typed PII fields before masking them", () => {
    const oversized = "9".repeat(2 * 1024 * 1024)
    const startedAt = performance.now()
    const results = ["phone", "email", "idCard", "bankCard"].map((fieldName) =>
      redactLogValue({ [fieldName]: oversized })
    )
    const elapsedMs = performance.now() - startedAt
    const serialized = JSON.stringify(results)

    expect(elapsedMs).toBeLessThan(500)
    expect(serialized.length).toBeLessThan(280 * 1024)
    expect(serialized).not.toContain("9".repeat(64))
    expect(serialized.match(/\[Truncated: text limit\]/g)).toHaveLength(4)
  })

  it("masks email addresses and Luhn-valid bank card numbers", () => {
    const redacted = redactSensitiveText(
      "联系 zhangsan@example.com，卡号 6222021234567894，普通编号 1234567890123456"
    )

    expect(redacted).toBe(
      "联系 z*******@example.com，卡号 622202******7894，普通编号 1234567890123456"
    )
  })

  it("uses field names to redact nested values that do not match a text pattern", () => {
    const input = {
      user: {
        idCard: "P1234567",
        contactPhone: "555-0100",
        email: "a@internal",
        bankCardNo: "1234567890",
        password: "short",
        passwordConfirmation: "short-again",
        authorizationHeader: "opaque",
        ystCode: "login-code",
        completionTokens: 128,
        note: "备用手机 13700001234"
      }
    }

    expect(redactLogValue(input)).toEqual({
      user: {
        idCard: "[REDACTED]",
        contactPhone: "[REDACTED]",
        email: "a******nal",
        bankCardNo: "[REDACTED]",
        password: "[REDACTED]",
        passwordConfirmation: "[REDACTED]",
        authorizationHeader: "[REDACTED]",
        ystCode: "[REDACTED]",
        completionTokens: 128,
        note: "备用手机 137****1234"
      }
    })
    expect(input.user.password).toBe("short")
  })

  it("redacts errors and circular structures without mutating the source", () => {
    const error = new Error("用户手机号 13612345678")
    error.name = "AuthError-13500002222"
    Object.assign(error, { authorization: "Bearer should-not-leak" })
    const source: Record<string, unknown> = { error, phone: "13500001111" }
    source.self = source

    const redacted = redactLogValue(source) as Record<string, unknown>
    const redactedError = redacted.error as Error & { authorization: string }

    expect(redacted.phone).toBe("135****1111")
    expect(redacted.self).toBe(redacted)
    expect(redactedError.message).toContain("136****5678")
    expect(redactedError.name).toBe("AuthError-135****2222")
    expect(redactedError.stack).not.toContain("13612345678")
    expect(redactedError.authorization).toBe("[REDACTED]")
    expect(error.message).toContain("13612345678")
  })

  it("bounds deeply nested arrays, maps, sets, and error causes without overflowing", () => {
    let deepArray: unknown = { password: "array-tail-secret" }
    let deepMap: unknown = { password: "map-tail-secret" }
    let deepSet: unknown = { password: "set-tail-secret" }
    let deepError: Error = new Error("password=error-tail-secret")
    delete deepError.stack

    for (let index = 0; index < 10_000; index += 1) {
      deepArray = [deepArray]
      deepMap = new Map([["next", deepMap]])
      deepSet = new Set([deepSet])
      const outerError = new Error("")
      delete outerError.stack
      Object.defineProperty(outerError, "cause", { value: deepError })
      deepError = outerError
    }

    const redactedArray = redactLogValue(deepArray)
    const redactedMap = redactLogValue(deepMap)
    const redactedSet = redactLogValue(deepSet)
    const redactedError = redactLogValue(deepError)

    let arrayCursor = redactedArray
    while (Array.isArray(arrayCursor)) arrayCursor = arrayCursor[0]
    expect(arrayCursor).toBe("[Truncated: depth limit]")

    let mapCursor = redactedMap
    while (mapCursor instanceof Map) mapCursor = mapCursor.get("next")
    expect(mapCursor).toBe("[Truncated: depth limit]")

    let setCursor = redactedSet
    while (setCursor instanceof Set) setCursor = setCursor.values().next().value
    expect(setCursor).toBe("[Truncated: depth limit]")

    let errorCursor = redactedError
    while (errorCursor instanceof Error) errorCursor = errorCursor.cause
    expect(errorCursor).toBe("[Truncated: depth limit]")

    expect(JSON.stringify(redactedArray)).not.toContain("array-tail-secret")
  })

  it("bounds collection entries and the total number of projected nodes", () => {
    const longArray = Array.from({ length: 1_000 }, (_, index) =>
      index === 999 ? "password=array-entry-secret" : index
    )
    const longMap = new Map<unknown, unknown>([["password", "map-entry-secret"]])
    const longSet = new Set<unknown>()
    for (let index = 0; index < 1_000; index += 1) {
      longMap.set(`entry-${index}`, index)
      longSet.add(index)
    }

    const redactedArray = redactLogValue(longArray) as unknown[]
    const redactedMap = redactLogValue(longMap) as Map<unknown, unknown>
    const redactedSet = redactLogValue(longSet) as Set<unknown>

    expect(redactedArray).toHaveLength(65)
    expect(redactedArray.at(-1)).toBe("[Truncated: entry limit]")
    expect(JSON.stringify(redactedArray)).not.toContain("array-entry-secret")
    expect(redactedMap.size).toBe(65)
    expect(redactedMap.get("password")).toBe("[REDACTED]")
    expect(redactedMap.get("[Truncated: entry limit]")).toBe("[Truncated: entry limit]")
    expect(redactedSet.size).toBe(65)
    expect(redactedSet.has("[Truncated: entry limit]")).toBe(true)

    const wideTree = Array.from({ length: 64 }, (_, branch) =>
      Array.from({ length: 64 }, (_, leaf) => ({
        note: `${branch}-${leaf}`,
        password: `node-secret-${branch}-${leaf}`
      }))
    )
    const projectedTree = JSON.stringify(redactLogValue(wideTree))
    expect(projectedTree).toContain("[Truncated: node limit]")
    expect(projectedTree).not.toContain("node-secret-")
  })

  it("stops projecting a plain object with 100,000 properties after the scan budget", () => {
    const wideObject: Record<string, number> = {}
    for (let index = 0; index < 100_000; index += 1) {
      wideObject[`property-${index}`] = index
    }

    const startedAt = performance.now()
    const redacted = redactLogValue(wideObject) as Record<string, unknown>
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(1_000)
    expect(Object.keys(redacted).length).toBeLessThanOrEqual(65)
    expect(redacted["[Truncated: entry limit]"]).toBe("[Truncated: entry limit]")
  })

  it("does not invoke getters and fails closed for hostile or revoked proxies", () => {
    let getterReads = 0
    const source = {
      safe: "手机 13800138000",
      get password(): string {
        getterReads += 1
        return "getter-secret"
      },
      get nested(): object {
        getterReads += 1
        return { token: "nested-getter-secret" }
      }
    }
    const ownKeysFailure = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("password=proxy-trap-secret")
        }
      }
    )
    const descriptorProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: (_target, key) => ({
          configurable: true,
          enumerable: true,
          value: key === "password" ? "descriptor-secret" : "ordinary"
        }),
        ownKeys: () => ["password"]
      }
    )
    const { proxy: revokedProxy, revoke } = Proxy.revocable([], {})
    revoke()
    const regexp = /ordinary-diagnostic/gi
    Object.defineProperties(regexp, {
      source: {
        get: () => {
          getterReads += 1
          console.error("regexp getter must not run")
          throw new Error("regexp getter must not run")
        }
      },
      flags: {
        get: () => {
          getterReads += 1
          console.error("regexp getter must not run")
          throw new Error("regexp getter must not run")
        }
      }
    })
    const bytes = new Uint8Array(8)
    Object.defineProperty(bytes, "byteLength", {
      get: () => {
        getterReads += 1
        console.error("typed array getter must not run")
        throw new Error("typed array getter must not run")
      }
    })
    const hostileConstructor = new Proxy(
      function HostileConstructor() {
        return undefined
      },
      {
        getOwnPropertyDescriptor: () => {
          getterReads += 1
          console.error("constructor proxy trap must not run")
          throw new Error("constructor proxy trap must not run")
        }
      }
    )
    Object.setPrototypeOf(bytes, { constructor: hostileConstructor })
    const dataView = new DataView(new ArrayBuffer(16))
    Object.defineProperty(dataView, "byteLength", {
      get: () => {
        getterReads += 1
        console.error("data view getter must not run")
        throw new Error("data view getter must not run")
      }
    })
    const rangeError = new RangeError("password=range-error-secret")
    const hostileError = new Error("safe fallback")
    for (const property of ["name", "message", "stack"] as const) {
      Object.defineProperty(hostileError, property, {
        configurable: true,
        get: () => {
          getterReads += 1
          console.error(`error ${property} getter must not run`)
          throw new Error(`error ${property} getter must not run`)
        }
      })
    }

    const redactedSource = redactLogValue(source) as Record<string, unknown>
    expect(getterReads).toBe(0)
    expect(redactedSource).toEqual({
      safe: "手机 138****8000",
      password: "[Getter]",
      nested: "[Getter]"
    })
    expect(redactLogValue(ownKeysFailure)).toBe("[Unserializable Object]")
    expect(redactLogValue(descriptorProxy)).toBe("[Unserializable Object]")
    expect(redactLogValue(revokedProxy)).toBe("[Unserializable Object]")
    expect(redactLogValue(regexp)).toBe("/ordinary-diagnostic/gi")
    expect(redactLogValue(bytes)).toBe("[Uint8Array 8 bytes]")
    expect(redactLogValue(dataView)).toBe("[DataView 16 bytes]")
    const redactedRangeError = redactLogValue(rangeError) as Error
    expect(redactedRangeError.name).toBe("RangeError")
    expect(redactedRangeError.message).toBe("password=[REDACTED]")
    const prepareStackTrace = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")?.value
    const usesNodeInternalFormatter =
      typeof prepareStackTrace === "function" &&
      Function.prototype.toString.call(prepareStackTrace).includes("internalPrepareStackTrace")
    if (usesNodeInternalFormatter) {
      expect(redactedRangeError.stack).toContain("RangeError")
      expect(redactedRangeError.stack).not.toContain("range-error-secret")
    } else {
      expect(redactedRangeError.stack).toBe("[Getter]")
    }
    Object.defineProperty(Function.prototype, "prepareStackTrace", {
      configurable: true,
      get: () => {
        getterReads += 1
        throw new Error("inherited prepareStackTrace must not run")
      }
    })
    const inheritedPrepareResult = redactLogValue(new TypeError("ordinary")) as Error
    Reflect.deleteProperty(Function.prototype, "prepareStackTrace")
    expect(inheritedPrepareResult.stack).toBe("[Getter]")
    const redactedHostileError = redactLogValue(hostileError) as Error
    expect(redactedHostileError.name).toBe("Error")
    expect(redactedHostileError.stack).toBe("[Getter]")
    expect(getterReads).toBe(0)
    expect(JSON.stringify(redactedSource)).not.toContain("getter-secret")
  })

  it("redacts numeric console arguments and preserves ordinary diagnostics", () => {
    const values = redactLogValues([
      13800138000,
      42,
      { keyboardKey: "Enter", completionTokens: 512, internalIp: "10.20.30.40" }
    ])

    expect(values).toEqual([
      "138****8000",
      42,
      { keyboardKey: "Enter", completionTokens: 512, internalIp: "10.20.30.40" }
    ])
    expect(redactLogValue("open http://localhost:3000")).toBe("open http://localhost:3000")
  })

  it("caps output when redaction replacements expand repeated credentials", () => {
    const source = "http://u:p@h/x ".repeat(8_000)
    const redacted = redactSensitiveText(source)

    expect(redacted.length).toBeLessThanOrEqual(64 * 1024 + 64)
    expect(redacted).not.toContain("u:p@")
    expect(redacted).toContain("[REDACTED]")
  })

  it("is idempotent", () => {
    const once = redactSensitiveText(
      "phone=13800138000 id=11010119900307123X token=internal-secret-token"
    )
    expect(redactSensitiveText(once)).toBe(once)
    expect(redactSensitiveText('{"access_token":"[redacted]"}')).toBe(
      '{"access_token":"[redacted]"}'
    )
  })
})
