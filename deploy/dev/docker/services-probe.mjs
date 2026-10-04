import { createHash, createHmac } from "node:crypto"
import { join } from "node:path"
import { request } from "node:http"
import { privateFile } from "./host.mjs"
import { validateProject } from "./lifecycle.mjs"

const digest = value => createHash("sha256").update(value).digest("hex")
const hmac = (key, value) => createHmac("sha256", key).update(value).digest()
const uri = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function localEndpoint(port) {
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || [3306, 9200, 9300, 8333, 9333, 8888].includes(port)) throw new Error("B00_LOOPBACK")
  return `http://127.0.0.1:${port}`
}

// Fixed literal host; no proxy, redirects, default profiles or external URL input.
export async function localHttp(port, method, path, { headers = {}, body = Buffer.alloc(0), signal, timeoutMs = 5000 } = {}) {
  localEndpoint(port)
  if (!["GET", "PUT", "POST", "DELETE", "HEAD"].includes(method) || !/^\/[a-zA-Z0-9_?=&%./-]*$/.test(path)) throw new Error("B00_HTTP_ARGUMENTS")
  const bytes = Buffer.from(body)
  if (bytes.length > 8192 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error("B00_HTTP_BOUND")
  if (signal?.aborted) throw new Error("B00_CANCELLED")
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = code => { if (!settled) { settled = true; reject(new Error(code)) } }
    const req = request({ hostname: "127.0.0.1", port, method, path, headers: { ...headers, "content-length": bytes.length }, agent: false }, res => {
      const chunks = []; let size = 0
      res.on("data", chunk => { size += chunk.length; if (size > 65536) { req.destroy(); fail("B00_HTTP_BOUND") } else chunks.push(chunk) })
      res.on("error", () => fail("B00_HTTP_IO"))
      res.on("end", () => { if (!settled) { settled = true; resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }) } })
    })
    const timer = setTimeout(() => { req.destroy(); fail("B00_HTTP_TIMEOUT") }, timeoutMs)
    const cancel = () => { req.destroy(); fail("B00_CANCELLED") }
    signal?.addEventListener("abort", cancel, { once: true })
    req.on("error", () => fail("B00_HTTP_IO"))
    req.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel) })
    req.end(bytes)
  })
}

export function s3Headers({ port, method, path, query = "", body = Buffer.alloc(0), credentials, now = new Date(), badSignature = false }) {
  localEndpoint(port)
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), date = dateTime.slice(0, 8)
  const scope = `${date}/us-east-1/s3/aws4_request`, payload = digest(body)
  const canonicalQuery = [...new URLSearchParams(query)].map(([k, v]) => [uri(k), uri(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(pair => pair.join("=")).join("&")
  const signed = "host;x-amz-content-sha256;x-amz-date"
  const canonical = `${method}\n${path}\n${canonicalQuery}\nhost:127.0.0.1:${port}\nx-amz-content-sha256:${payload}\nx-amz-date:${dateTime}\n\n${signed}\n${payload}`
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, date), "us-east-1"), "s3"), "aws4_request")
  const signature = badSignature ? "0".repeat(64) : hmac(key, `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${digest(canonical)}`).toString("hex")
  return { "x-amz-date": dateTime, "x-amz-content-sha256": payload, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope},SignedHeaders=${signed},Signature=${signature}` }
}

async function jsonResponse(response, status, reason) {
  if (response.status !== status) { const error = new Error(reason); error.httpStatus = response.status; throw error }
  try { return JSON.parse(response.bytes.toString("utf8")) } catch { throw new Error(reason) }
}

export async function servicesHealth(entry, ports, signal) {
  await validateProject(entry)
  const esPassword = (await privateFile(join(entry.dir, "es-password"))).trim()
  const authorization = `Basic ${Buffer.from(`elastic:${esPassword}`).toString("base64")}`
  const es = await jsonResponse(await localHttp(ports.es, "GET", "/", { headers: { authorization }, signal }), 200, "B00_ES_HEALTH")
  if (es.version?.number !== "8.19.22") throw new Error("B00_ES_VERSION")
  // A new single-node cluster can accept HTTP before its Basic license metadata
  // is installed. Wait only for that bounded null state; never accept a trial.
  let license
  for (let i = 0; i < 40; i++) {
    license = await jsonResponse(await localHttp(ports.es, "GET", "/_license", { headers: { authorization }, signal }), 200, "B00_ES_LICENSE")
    if (license.license) break
    if (signal?.aborted) throw new Error("B00_CANCELLED")
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (license.license?.type !== "basic" || license.license?.status !== "active") { const error = new Error("B00_ES_LICENSE"); error.licenseState = { type: ["basic", "trial"].includes(license.license?.type) ? license.license.type : "other_or_null", status: ["active", "expired", "inactive"].includes(license.license?.status) ? license.license.status : "other_or_null" }; throw error }
  const credentials = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  const s3 = await localHttp(ports.s3, "GET", "/", { headers: s3Headers({ port: ports.s3, method: "GET", path: "/", credentials }), signal })
  if (s3.status !== 200 || !s3.bytes.toString().includes("ListAllMyBucketsResult")) throw new Error("B00_S3_HEALTH")
  return { es: { version: es.version.number, license: "basic", authenticated: true }, s3: { version: "4.48", authenticated: true } }
}

export async function servicesProbe(entry, ports, phase, signal) {
  await validateProject(entry)
  if (entry.role !== "test" || !["create", "persist", "delete"].includes(phase)) throw new Error("B00_TEST_ONLY")
  const index = entry.project, bucket = entry.project, key = "proof.txt"
  const payload = Buffer.from(`中文合成🚀:${entry.project}`, "utf8"), contentHash = digest(payload)
  const esPassword = (await privateFile(join(entry.dir, "es-password"))).trim()
  const auth = `Basic ${Buffer.from(`elastic:${esPassword}`).toString("base64")}`
  const esRequest = (method, path, body) => localHttp(ports.es, method, path, { headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal })
  const credentials = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  const s3Request = (method, path, { query = "", body, anonymous = false, badSignature = false } = {}) => localHttp(ports.s3, method, `${path}${query ? `?${query}` : ""}`, { headers: anonymous ? {} : s3Headers({ port: ports.s3, method, path, query, body, credentials, badSignature }), body, signal })
  const checkS3 = (response, statuses, action) => { if (!statuses.includes(response.status)) { const error = new Error("B00_S3_STATUS"); error.httpStatus = response.status; error.serviceAction = action; throw error } return response }
  if (phase === "create") {
    await servicesHealth(entry, ports, signal)
    for (const headers of [{}, { authorization: `Basic ${Buffer.from("elastic:wrong").toString("base64")}` }]) if ((await localHttp(ports.es, "GET", "/", { headers, signal })).status !== 401) throw new Error("B00_ES_AUTH")
    for (const options of [{ anonymous: true }, { badSignature: true }]) checkS3(await s3Request("GET", "/", options), [403])
    await jsonResponse(await esRequest("PUT", `/${index}`, { mappings: { properties: { message: { type: "keyword" } } } }), 200, "B00_ES_CRUD")
    await jsonResponse(await esRequest("PUT", `/${index}/_doc/1?refresh=true`, { message: payload.toString("utf8") }), 201, "B00_ES_CRUD")
    checkS3(await s3Request("PUT", `/${bucket}`), [200])
    checkS3(await s3Request("PUT", `/${bucket}/${key}`, { body: payload }), [200])
  }
  if (phase !== "delete") {
    const read = await jsonResponse(await esRequest("GET", `/${index}/_doc/1`), 200, "B00_ES_CRUD")
    if (read._source?.message !== payload.toString("utf8")) throw new Error("B00_ES_CONTENT")
    const search = await jsonResponse(await esRequest("POST", `/${index}/_search`, { query: { term: { message: payload.toString("utf8") } } }), 200, "B00_ES_SEARCH")
    if (search.hits?.total?.value !== 1 || search.hits.hits[0]?._source?.message !== payload.toString("utf8")) throw new Error("B00_ES_SEARCH")
    const object = checkS3(await s3Request("GET", `/${bucket}/${key}`), [200], "object-get")
    if (!object.bytes.equals(payload) || digest(object.bytes) !== contentHash) throw new Error("B00_S3_CONTENT")
    const list = checkS3(await s3Request("GET", `/${bucket}`, { query: "list-type=2" }), [200], "object-list").bytes.toString("utf8")
    if (!list.includes(`<Key>${key}</Key>`) || !list.includes("<KeyCount>1</KeyCount>")) throw new Error("B00_S3_LIST")
  } else {
    await jsonResponse(await esRequest("DELETE", `/${index}`), 200, "B00_ES_DELETE")
    if ((await esRequest("GET", `/${index}/_doc/1`)).status !== 404) throw new Error("B00_ES_DELETE")
    checkS3(await s3Request("DELETE", `/${bucket}/${key}`), [204])
    checkS3(await s3Request("GET", `/${bucket}/${key}`), [404])
    checkS3(await s3Request("DELETE", `/${bucket}`), [204])
  }
  return { phase, index, bucket, key, sha256: contentHash, es: "verified", s3: "verified" }
}
