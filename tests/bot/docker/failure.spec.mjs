import test from "node:test"
import assert from "node:assert/strict"
import { finishFailedStart, classifyStartup } from "../../../deploy/dev/docker/lifecycle.mjs"

test("failed log read still attempts stopping and retains only the original failure", async () => {
  const original = new Error("B00_INJECTED")
  let stopped = 0
  await assert.rejects(finishFailedStart(original, async () => { throw new Error("secret sentinel") }, async () => { stopped++ }), (error) => error === original)
  assert.equal(stopped, 1)
  assert.equal(original.diagnosticsUnavailable, true)
  assert.equal(JSON.stringify(original).includes("sentinel"), false)
  const stopping = new Error("B00_INJECTED")
  await assert.rejects(finishFailedStart(stopping, async () => [], async () => { throw new Error("private output") }), (error) => error === stopping)
  assert.equal(stopping.stopFailed, true)
})
test("startup classification only returns fixed paths and bounded fields, never raw secrets", () => {
  const secret = "private-secret-sentinel"
  const c = { State: { Status: "exited", ExitCode: 255 }, Config: { WorkingDir: "/data" } }
  const data = classifyStartup("s3", c, `mkdir /data/filerldb2: permission denied ${secret}`)
  assert.deepEqual(data.permissionPaths, ["/data", "/data/filerldb2"])
  assert.equal(data.filerMetadata, true)
  assert.equal(JSON.stringify(data).includes(secret), false)
})
