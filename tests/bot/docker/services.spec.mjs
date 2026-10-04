import test from "node:test"
import assert from "node:assert/strict"
import { argumentsFor } from "../../../deploy/dev/docker/cli.mjs"
import { localEndpoint, localHttp, s3Headers } from "../../../deploy/dev/docker/services-probe.mjs"

test("clients accept only literal local allocated ports and bounded requests", async () => {
  assert.equal(localEndpoint(54321), "http://127.0.0.1:54321")
  for (const port of ["https://remote", "54321", 3306, 9200, 8333, 0, 65536, NaN]) assert.throws(() => localEndpoint(port), /B00_LOOPBACK/)
  await assert.rejects(localHttp(54321, "GET", "//remote".replace("//", "http://")), /B00_HTTP_ARGUMENTS/)
  await assert.rejects(localHttp(54321, "PUT", "/", { body: Buffer.alloc(8193) }), /B00_HTTP_BOUND/)
  const c = new AbortController(); c.abort()
  await assert.rejects(localHttp(54321, "GET", "/", { signal: c.signal }), /B00_CANCELLED/)
})
test("S3 SigV4 signs payload, literal host and canonical query without default credentials", () => {
  const input = { port: 54321, method: "GET", path: "/synthetic", query: "z=two&a=one", body: Buffer.alloc(0), credentials: { accessKey: "synthetic-key", secretKey: "synthetic-secret" }, now: new Date("2026-10-04T12:00:00Z") }
  const result = s3Headers(input)
  assert.equal(result["x-amz-date"], "20261004T120000Z")
  assert.equal(result["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  assert.match(result.authorization, /^AWS4-HMAC-SHA256 Credential=synthetic-key\/20261004\/us-east-1\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[a-f0-9]{64}$/)
  assert.deepEqual(s3Headers({ ...input, query: "a=one&z=two" }), result)
  assert.notEqual(s3Headers({ ...input, body: Buffer.from("changed") }).authorization, result.authorization)
  assert.match(s3Headers({ ...input, badSignature: true }).authorization, /Signature=0{64}$/)
})
test("Docker CLI arguments remain explicit and require Java8 paths for start/test", () => {
  assert.deepEqual(argumentsFor(["status"]), { command: "status", tools: {} })
  assert.deepEqual(argumentsFor(["test", "--java", "/jdk/java", "--javac", "/jdk/javac", "--jdbc", "/jdbc.jar"]), { command: "test", tools: { java: "/jdk/java", javac: "/jdk/javac", jdbc: "/jdbc.jar" } })
  for (const argv of [["start"], ["status", "--java", "/java"], ["test", "--url", "https://remote"], ["unknown"]]) assert.throws(() => argumentsFor(argv), /B00_/)
})
