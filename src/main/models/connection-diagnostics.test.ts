import { expect, it } from "vitest"
import { modelConnectionHint } from "./connection-diagnostics"

const failure = (code: string) =>
  Object.assign(new Error("private-key@private-host:8443?token=private-token"), { code })

it.each([
  ["ENOTFOUND", "域名"],
  ["EAI_AGAIN", "域名"],
  ["ECONNREFUSED", "拒绝连接"],
  ["UND_ERR_CONNECT_TIMEOUT", "超时"],
  ["UND_ERR_HEADERS_TIMEOUT", "未及时响应"],
  ["UND_ERR_BODY_TIMEOUT", "超时"],
  ["UND_ERR_SOCKET", "断开"],
  ["CERT_HAS_EXPIRED", "过期"],
  ["CERT_NOT_YET_VALID", "尚未生效"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "域名不匹配"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "可信证书"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "可信证书"]
])("diagnoses native %s without echoing private connection data", (code, hint) => {
  const result = modelConnectionHint(new TypeError("fetch failed", { cause: failure(code) }))
  expect(result).toContain(hint)
  expect(result).not.toContain("private")
})

it("recognizes nested address-attempt failures and terminates on cycles", () => {
  const outer = new Error("outer")
  outer.cause = new AggregateError([outer, failure("ECONNREFUSED")])
  expect(modelConnectionHint(outer)).toContain("拒绝连接")
  outer.cause = outer
  expect(modelConnectionHint(outer)).toBeUndefined()
})

it("does not treat response objects, message text or unknown codes as native diagnostics", () => {
  for (const value of [
    { code: "ENOTFOUND" },
    new Error("ENOTFOUND private-credential"),
    new Error("fetch failed", { cause: { code: "ENOTFOUND" } }),
    failure("constructor"),
    failure("unknown"),
    "ENOTFOUND"
  ])
    expect(modelConnectionHint(value)).toBeUndefined()
})

it("bounds nested error traversal", () => {
  let error: Error = failure("ENOTFOUND")
  for (let index = 0; index < 64; index++) error = new Error("wrapper", { cause: error })
  expect(modelConnectionHint(error)).toBeUndefined()
})
