/**
 * Unit tests for shared MCP header resolution.
 *
 * Run with:
 *   npx tsx tests/mcp-headers.spec.ts
 */
import assert from "node:assert/strict"
import { resolveMcpHeaders } from "../src/main/mcp/headers.ts"

function testInjectsUserHeadersByDefault(): void {
  const headers = resolveMcpHeaders({
    headers: { "X-App": "plugin" },
    userInfo: {
      ystIdToken: "token-1",
      sapId: "sap-1",
      userName: "User Name"
    }
  })

  assert.equal(headers?.["X-App"], "plugin")
  assert.equal(headers?.yst_id_token, "token-1")
  assert.equal(headers?.sap_id, "sap-1")
  assert.equal(headers?.name, "User%20Name")
}

function testUserHeadersMatchExistingOverrideBehavior(): void {
  const headers = resolveMcpHeaders({
    headers: {
      yst_id_token: "configured-token",
      sap_id: "configured-sap",
      name: "configured-name"
    },
    userInfo: {
      ystIdToken: "user-token",
      sapId: "user-sap",
      userName: "User Name"
    }
  })

  assert.equal(headers?.yst_id_token, "user-token")
  assert.equal(headers?.sap_id, "user-sap")
  assert.equal(headers?.name, "User%20Name")
}

function testCanDisableUserHeaderInjection(): void {
  const headers = resolveMcpHeaders({
    headers: { "X-App": "plugin" },
    userInfo: {
      ystIdToken: "token-1",
      sapId: "sap-1",
      userName: "User Name"
    },
    injectUserHeaders: false
  })

  assert.deepEqual(headers, { "X-App": "plugin" })
}

testInjectsUserHeadersByDefault()
testUserHeadersMatchExistingOverrideBehavior()
testCanDisableUserHeaderInjection()

console.log("PASS MCP header injection defaults")
