import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { chmod, symlink, link, unlink } from "node:fs/promises"
import { withPartnerHttpFixture, partnerPrincipals } from "../../../deploy/dev/service/partner-http.mjs"
import { partnerBootstrapConfig, partnerProcessInfo } from "../../../deploy/dev/service/partner-dev.mjs"
import { partnerEntry, partnerCompose, partnerPrivateFile, partnerWrite } from "../../../deploy/dev/service/partner-dev-resources.mjs"
import { validateHttpPrincipals } from "../../../deploy/dev/service/http-fixture.mjs"
import { privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"

test("Partner fixture rejects noncallback or aborted work before credentials/resources", async () => {
  await assert.rejects(withPartnerHttpFixture(null), /PARTNER_CALLBACK/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(withPartnerHttpFixture(() => { throw Error("CALLBACK_MUST_NOT_RUN") }, { signal: controller.signal }))
})
test("Partner bootstrap credentials are independent and runtime access names match descriptor", () => {
  const one = partnerBootstrapConfig(), two = partnerBootstrapConfig()
  validateHttpPrincipals(one.identity.principals); validateHttpPrincipals(partnerPrincipals())
  assert.match(one.nodes[0].credential, /^dcn1_[a-f0-9]{64}$/)
  assert.notEqual(one.nodes[0].credential, two.nodes[0].credential)
  assert.equal(new Set(one.identity.bearers.map(value => value.token)).size, 2)
  assert.equal(one.access.every(value => value.capabilities.join() === "requirements.analyze" && value.workspaceRefs.join() === "view"), true)
  assert.equal(JSON.stringify(one).includes("password"), false)
})
test("Partner resource API refuses original dev and arbitrary paths before file or Docker reads", async () => {
  for (const project of ["devclaw-bot-dev", "../devclaw-bot-dev", "devclaw-bot-test-0000000000000000"])
    await assert.rejects(partnerEntry({ project }), /PARTNER_RESOURCE/)
})
test("Partner compose is one pinned isolated database with no original service mounts", () => {
  const value = partnerCompose({ project: "devclaw-bot-partner-dev", owner: "11111111-1111-1111-1111-111111111111", nonce: "22222222-2222-2222-2222-222222222222", role: "partner-dev", dir: "/private/owned/partner" })
  assert.deepEqual(Object.keys(value.services), ["mysql"])
  assert.deepEqual(Object.keys(value.volumes), ["data"])
  assert.deepEqual(Object.keys(value.secrets), ["root-password", "app-password", "app-client"])
  assert.equal(value.services.mysql.ports[0].host_ip, "127.0.0.1")
  assert.equal(value.services.mysql.restart, "no")
  assert.equal(value.services.mysql.environment.MYSQL_ROOT_PASSWORD, undefined)
  assert.equal(value.volumes.data.name, "devclaw-bot-partner-dev-data")
})
test("Partner private files preserve strict ownership/mode/link guards on read and replacement", async () => {
  const dir = await privateTemp(), path = join(dir, "private.json"), alias = join(dir, "alias.json")
  try {
    await partnerWrite(path, "long-private-fixture")
    await partnerWrite(path, "short")
    assert.equal(await partnerPrivateFile(path), "short")
    await chmod(path, 0o644)
    await assert.rejects(partnerPrivateFile(path), /PARTNER_RESOURCE/)
    await assert.rejects(partnerWrite(path, "replacement"), /PARTNER_RESOURCE/)
    await chmod(path, 0o600)
    await symlink(path, alias)
    await assert.rejects(partnerPrivateFile(alias), /PARTNER_RESOURCE/)
    await assert.rejects(partnerWrite(alias, "replacement"), /PARTNER_RESOURCE/)
    await unlink(alias); await link(path, alias)
    await assert.rejects(partnerPrivateFile(path), /PARTNER_RESOURCE/)
    await assert.rejects(partnerWrite(path, "replacement"), /PARTNER_RESOURCE/)
    await unlink(alias)
    assert.equal(await partnerPrivateFile(path), "short")
    await assert.rejects(partnerPrivateFile(path, 4), /PARTNER_RESOURCE/)
  } finally { await removePrivateTemp(dir) }
})
test("Partner process lookup treats initial confirmed ESRCH as absent without ps", async () => {
  const gone = Object.assign(Error("gone"), { code: "ESRCH" })
  assert.equal(await partnerProcessInfo(123, { exists() { throw gone }, read() { throw Error("MUST_NOT_READ") } }), null)
})
test("Partner process exit between kill0 and ps is confirmed absent, never a false running record", async () => {
  let count = 0; const gone = Object.assign(Error("gone"), { code: "ESRCH" })
  assert.equal(await partnerProcessInfo(123, { exists() { if (++count === 2) throw gone }, read() { throw Error("PS_EXIT_RACE") } }), null)
  assert.equal(count, 2)
})
test("Partner process diagnostics with live or reused PID remain errors, not permission to stop", async () => {
  const failure = Error("PS_FAILURE")
  await assert.rejects(partnerProcessInfo(123, { exists() {}, read() { throw failure } }), error => error === failure)
  const denied = Object.assign(Error("denied"), { code: "EPERM" })
  await assert.rejects(partnerProcessInfo(123, { exists() { throw denied }, read() { throw Error("MUST_NOT_READ") } }), error => error === denied)
})
test("Partner process identity still reads exact stamp and rejects invalid PID before probes", async () => {
  assert.equal(await partnerProcessInfo(123, { exists() {}, async read() { return "exact-owner-stamp" } }), "exact-owner-stamp")
  for (const pid of [0, 1, -1, "123", NaN]) await assert.rejects(partnerProcessInfo(pid, { exists() { throw Error("MUST_NOT_PROBE") }, read() { throw Error("MUST_NOT_READ") } }), /PARTNER_DEV/)
})
