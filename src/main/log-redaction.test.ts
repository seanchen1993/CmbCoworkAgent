import { describe, expect, it } from "vitest"
import { redactLogValue, redactLogValues, redactSensitiveText } from "./log-redaction"

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
