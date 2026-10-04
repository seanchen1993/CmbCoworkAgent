import test from "node:test"
import assert from "node:assert/strict"
import { registeredLookup, volumeIdsFromPaths, waitForS3 } from "../../../deploy/dev/docker/readiness.mjs"

test("readiness requires authenticated API and every existing registered volume", async () => {
  let calls = 0
  assert.deepEqual(await waitForS3(async () => ({ apiReady: true, volumes: ["1"], registered: ++calls > 1 ? ["1"] : [] }), { pauseMs: 1, timeoutMs: 100 }), { authenticated: true, registeredVolumeIds: ["1"] })
  assert.equal(calls, 2)
  assert.deepEqual(await waitForS3(async () => ({ apiReady: true, volumes: [], registered: [] })), { authenticated: true, registeredVolumeIds: [] })
  await assert.rejects(waitForS3(async () => ({ apiReady: true, volumes: ["1"], registered: [] }), { pauseMs: 1, timeoutMs: 10 }), /B00_S3_READY_TIMEOUT/)
  const c = new AbortController(); c.abort()
  await assert.rejects(waitForS3(async () => { throw new Error("not called") }, { signal: c.signal }), /B00_CANCELLED/)
  let badCalls = 0
  await assert.rejects(waitForS3(async () => { badCalls++; throw new Error("B00_S3_AUTH") }), /B00_S3_AUTH/)
  assert.equal(badCalls, 1)
})
test("exact volume paths and fixed lookup location reject unsafe or malformed metadata", () => {
  assert.deepEqual(volumeIdsFromPaths("/data/state/bucket_2.dat\n/data/state/1.dat"), ["1", "2"])
  for (const value of ["/etc/1.dat", "/data/state/../1.dat", "/data/state/a.dat", "/data/state/4294967296.dat", "/data/state/1.dat\n/data/state/bucket_1.dat"]) assert.throws(() => volumeIdsFromPaths(value), /B00_S3_VOLUME/)
  const wire = body => `HTTP/1.1 200 OK\n${JSON.stringify(body)}\nB00_LOOKUP_EXIT=0\n`
  assert.equal(registeredLookup(wire({ locations: [{ url: "127.0.0.1:8080" }] })), true)
  assert.equal(registeredLookup(wire({ locations: [] })), false)
  assert.equal(registeredLookup("HTTP/1.1 404 Not Found\nB00_LOOKUP_EXIT=1\n"), false)
  assert.throws(() => registeredLookup(wire({ locations: [{ url: "remote:8080" }] })), /B00_S3_VOLUME_LOCATION/)
  assert.throws(() => registeredLookup(wire({})), /B00_S3_LOOKUP_BODY/)
  assert.throws(() => registeredLookup("HTTP/1.1 403 Forbidden\nB00_LOOKUP_EXIT=1\n"), /B00_S3_LOOKUP_STATUS/)
})
