/** Portable plugin code. Hashes prove byte consistency, not independent business acceptance.
 * The host's ordinary composition binding must establish the trusted producer/file identity. */
export function sha256(text: string): string {
  const bytes = Array.from(encodeURIComponent(text).matchAll(/%([\da-f]{2})|([^%])/gi),
    match => match[1] ? parseInt(match[1], 16) : match[2].charCodeAt(0))
  const size = bytes.length
  bytes.push(128)
  while (bytes.length % 64 !== 56) bytes.push(0)
  bytes.push(0, 0, 0, 0, (size * 8 >>> 24) & 255, (size * 8 >>> 16) & 255,
    (size * 8 >>> 8) & 255, size * 8 & 255)
  const primes: number[] = [], constants: number[] = [], state: number[] = []
  for (let candidate = 2; primes.length < 64; candidate++) {
    if (primes.some(prime => candidate % prime === 0)) continue
    primes.push(candidate)
    constants.push(Math.floor(Math.cbrt(candidate) * 4294967296) | 0)
    if (state.length < 8) state.push(Math.floor(Math.sqrt(candidate) * 4294967296) | 0)
  }
  const rotate = (word: number, bits: number) => word >>> bits | word << 32 - bits
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => {
      const start = offset + index * 4
      return bytes[start] << 24 | bytes[start + 1] << 16 | bytes[start + 2] << 8 | bytes[start + 3]
    })
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15], b = words[index - 2]
      words[index] = (words[index - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3) +
        words[index - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10)) | 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) + constants[index] + words[index]) | 0
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + first) | 0
      d = c; c = b; b = a; a = (first + second) | 0
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = state[index] + value | 0
  }
  return state.map(word => (word >>> 0).toString(16).padStart(8, "0")).join("")
}

export function inspectVerifiedArtifacts(content: string, requiredIds: string[]) {
  if (typeof content !== "string" || content.length > 262144 || !Array.isArray(requiredIds) ||
    !requiredIds.length || requiredIds.length > 64 || new Set(requiredIds).size !== requiredIds.length ||
    !requiredIds.every(id => /^[a-zA-Z0-9][\w.-]{0,79}$/.test(id))) throw Error("VERIFIED_INPUT_INVALID")
  const bundle = JSON.parse(content)
  if (bundle.apiVersion !== "devclaw.autobiz-context/v1" || !Array.isArray(bundle.files) ||
    !bundle.files.length || bundle.files.length > 128 || !bundle.producer ||
    ![bundle.producer.compositionRunId, bundle.producer.unitId, bundle.producer.engineRunId,
      bundle.producer.source?.pluginId, bundle.producer.source?.packageDigest,
      bundle.producer.evidenceDigest].every(value => typeof value === "string" && value.length > 0))
    throw Error("VERIFIED_INPUT_INVALID")
  const seen = new Set<string>()
  const artifacts = bundle.files.map((file: { id: string; path: string; digest: string;
    content: string; outputNodeId: string; checkedBy: { nodeId: string; checkId: string; contractDigest: string } }) => {
    if (typeof file.id !== "string" || seen.has(file.id) || typeof file.content !== "string" ||
      typeof file.path !== "string" || file.path.includes("\\") || file.path.split("/").some(part => !part || part === ".." || part === ".") ||
      !/^[a-f0-9]{64}$/.test(file.digest) || sha256(file.content) !== file.digest ||
      !file.outputNodeId || !file.checkedBy?.nodeId || !file.checkedBy.checkId ||
      !/^[a-f0-9]{64}$/.test(file.checkedBy.contractDigest)) throw Error("VERIFIED_CONTENT_INVALID")
    seen.add(file.id)
    // This adapter explicitly consumes JSON documents; binary/text formats need another adapter.
    const value = JSON.parse(file.content)
    return { id: file.id, path: file.path, digest: file.digest,
      outputNodeId: file.outputNodeId, checkedBy: file.checkedBy, value }
  })
  if (requiredIds.some(id => !seen.has(id))) throw Error("VERIFIED_INPUT_MISSING")
  return { bundleDigest: sha256(content), producer: bundle.producer, requiredIds: [...requiredIds], artifacts,
    acceptance: "producer-checked-content; consumer consistency only; business acceptance remains unchanged" }
}
