// Preserve the first post-restart response; later GETs are diagnosis, not a pass.
import { join } from "node:path"
import { createHash } from "node:crypto"
import { hostState, privateFile, docker } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, compose, resources, stop, cleanupTest, validateContainer } from "../../../deploy/dev/docker/lifecycle.mjs"
import { localHttp, s3Headers } from "../../../deploy/dev/docker/services-probe.mjs"

const state = await hostState(), entry = await prepareProject(state, { test: true })
console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
const bytes = Buffer.from("B00 中文持久化🚀"), sha = value => createHash("sha256").update(value).digest("hex")
try {
  const credentials = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  async function up() {
    await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "90", "--no-build", "--pull", "never", "s3"], { timeoutMs: 100000 })
    const c = (await resources(state, entry)).containers.s3
    return { container: c, port: validateContainer(c, entry, "s3") }
  }
  const request = (port, method, path, body, query = "") => localHttp(port, method, `${path}${query ? `?${query}` : ""}`, { headers: s3Headers({ port, method, path, query, body, credentials }), body })
  const path = `/${entry.project}/proof.txt`, started = await up()
  for (const [method, resource, body] of [["PUT", `/${entry.project}`], ["PUT", path, bytes]]) if ((await request(started.port, method, resource, body)).status !== 200) throw new Error("B00_S3_CREATE")
  const before = await request(started.port, "GET", path)
  if (before.status !== 200 || !before.bytes.equals(bytes)) throw new Error("B00_S3_CONTENT")
  console.log(JSON.stringify({ stage: "before-restart", status: before.status, sha256: sha(before.bytes) }))
  await stop(state, entry)
  const restarted = await up()
  const paths = (await docker(state, ["exec", restarted.container.Id, "find", "/data/state", "-maxdepth", "1", "-type", "f", "-name", "*.dat"], { stdoutOnly: true })).split("\n").filter(Boolean)
  const volumeIds = paths.map(path => {
    const match = path.match(/^\/data\/state\/(?:[a-zA-Z0-9_.-]+_)?([1-9][0-9]*)\.dat$/)
    if (!match) throw new Error("B00_S3_VOLUME_PATH")
    return match[1]
  })
  if (!volumeIds.length || volumeIds.length > 4) throw new Error("B00_S3_VOLUME_COUNT")
  for (let sample = 0; sample < 20; sample++) {
    let response, failure, list
    try { response = await request(restarted.port, "GET", path) } catch (e) { failure = ["B00_HTTP_IO", "B00_HTTP_TIMEOUT"].includes(e.message) ? e.message : "other" }
    try { list = await request(restarted.port, "GET", `/${entry.project}`, undefined, "list-type=2") } catch {}
    const text = response?.bytes.toString("utf8") ?? ""
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1]
    const errorCode = ["InternalError", "NoSuchKey", "NoSuchBucket", "SlowDown", "AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId"].includes(code) ? code : "other_or_missing"
    const registered = []
    for (const id of volumeIds) try {
      const value = JSON.parse(await docker(state, ["exec", restarted.container.Id, "wget", "-q", "-O", "-", "-T", "2", `http://127.0.0.1:9333/dir/lookup?volumeId=${id}`], { stdoutOnly: true, timeoutMs: 5000 }))
      if (value.locations?.some(location => location.url === "127.0.0.1:8080")) registered.push(id)
    } catch {}
    console.log(JSON.stringify({ stage: "post-restart", sample, httpStatus: response?.status ?? null, failure, contentMatch: response?.status === 200 && response.bytes.equals(bytes), bucketListStatus: list?.status ?? null, metadataKeyVisible: list?.status === 200 && list.bytes.toString().includes("<Key>proof.txt</Key>"), volumeIds, registered, errorCode, connectionRefused: /connection refused/i.test(text), volumeUnavailable: /(?:no.*location|volume.*not found|failed.*lookup|lookup.*failed)/i.test(text), timeout: /timeout|timed out/i.test(text) }))
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const logs = await docker(state, ["logs", "--tail", "100", restarted.container.Id], { timeoutMs: 10000, maxOutput: 65536 })
  console.log(JSON.stringify({ stage: "safe-log-classification", volumeRegistered: /register.*volume|volume.*register/i.test(logs), volumeUnavailable: /no.*location|volume.*not found/i.test(logs), permission: /permission denied/i.test(logs), connectionRefused: /connection refused/i.test(logs), raftLeader: /become leader|elected.*leader/i.test(logs) }))
} finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
