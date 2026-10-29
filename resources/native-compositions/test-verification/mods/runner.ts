/** Fixed reporter runs outside test processes; test stdout is never evidence. */
export const runnerBootstrap = String.raw`
const fs = require("node:fs")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { run } = require("node:test")
const hash = value => createHash("sha256").update(value).digest("hex")
const fail = code => { throw Error(code) }
const object = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail("TEST_INPUT_INVALID")
}
const safePath = value => {
  if (typeof value !== "string" || !value || value.length > 160 || value.includes("\\") ||
      value.includes(":") || value.split("/").some(part => !part || part === "." || part === ".." ||
        /[<>"|?*\x00-\x1f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
    fail("TEST_PATH_INVALID")
  return value
}
const identity = value => [value.dev, value.ino, value.size, value.mtimeMs,
  process.platform === "win32" ? 0 : value.ctimeMs].join(":")
const ordinary = (value, directory = false) => {
  if (value.isSymbolicLink() || !(directory ? value.isDirectory() : value.isFile()) ||
      (!directory && value.nlink !== 1)) fail("TEST_FILE_TYPE_INVALID")
}
const root = process.cwd()
const rootStat = fs.lstatSync(root)
ordinary(rootStat, true)
const observed = new Map([[root, identity(rootStat)]])
function read(name, maxBytes) {
  safePath(name)
  let target = root
  const parts = name.split("/")
  for (const part of parts.slice(0, -1)) {
    target = path.join(target, part)
    const info = fs.lstatSync(target)
    ordinary(info, true)
    observed.set(target, identity(info))
  }
  target = path.join(target, parts.at(-1))
  const before = fs.lstatSync(target)
  ordinary(before)
  if (before.size > maxBytes) fail("TEST_FILE_LIMIT")
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let raw
  try {
    const opened = fs.fstatSync(fd)
    ordinary(opened)
    if (identity(opened) !== identity(before)) fail("TEST_FILE_CHANGED")
    raw = Buffer.alloc(before.size + 1)
    const length = fs.readSync(fd, raw, 0, raw.length, 0)
    raw = raw.subarray(0, length)
    if (length !== before.size || identity(fs.fstatSync(fd)) !== identity(before) ||
        identity(fs.lstatSync(target)) !== identity(before)) fail("TEST_FILE_CHANGED")
  } finally { fs.closeSync(fd) }
  observed.set(target, identity(before))
  return raw
}
function sources(rows, referenced) {
  if (!Array.isArray(rows) || rows.length > 7) fail("TEST_SOURCE_LIMIT")
  const ids = new Set(), paths = new Set()
  let total = 0
  const result = rows.map(row => {
    object(row, referenced ? ["artifactId", "path", "maxBytes", "bytes", "sha256"] :
      ["artifactId", "path", "maxBytes"])
    if (typeof row.artifactId !== "string" || !/^[A-Za-z0-9][\w.-]{0,99}$/.test(row.artifactId) ||
        ids.has(row.artifactId) || ![28000, 524288].includes(row.maxBytes)) fail("TEST_SOURCE_INVALID")
    safePath(row.path)
    if (paths.has(row.path.toLowerCase())) fail("TEST_SOURCE_INVALID")
    ids.add(row.artifactId); paths.add(row.path.toLowerCase())
    const raw = read(row.path, row.maxBytes)
    total += raw.length
    const value = { artifactId: row.artifactId, path: row.path, maxBytes: row.maxBytes,
      bytes: raw.length, sha256: hash(raw) }
    if (referenced && (value.bytes !== row.bytes || value.sha256 !== row.sha256))
      fail("TEST_SOURCE_CHANGED")
    return value
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (total > 1048576) fail("TEST_SOURCE_LIMIT")
  return hash(JSON.stringify(result))
}
function tests(files) {
  if (!Array.isArray(files) || !files.length || files.length > 4 ||
      new Set(files.map(file => String(file).toLowerCase())).size !== files.length)
    fail("TEST_FILES_INVALID")
  return hash(JSON.stringify(files.map(file => {
    safePath(file)
    if (!/\.(?:test|spec)\.(?:cjs|mjs|js)$/.test(file)) fail("TEST_FILES_INVALID")
    const raw = read(file, 262144)
    return { path: file, bytes: raw.length, sha256: hash(raw) }
  })))
}
function subjects(files) {
  if (!Array.isArray(files) || files.length > 8 ||
      new Set(files.map(file => String(file).toLowerCase())).size !== files.length)
    fail("TEST_SUBJECTS_INVALID")
  let total = 0
  const rows = files.map(file => {
    const raw = read(file, 262144)
    total += raw.length
    if (total > 1048576) fail("TEST_SUBJECT_LIMIT")
    return { path: file, bytes: raw.length, sha256: hash(raw) }
  })
  return hash(JSON.stringify(rows))
}
function unchanged() {
  for (const [name, expected] of observed) {
    const actual = fs.lstatSync(name)
    ordinary(actual, name === root || actual.isDirectory())
    if (identity(actual) !== expected) fail("TEST_FILE_CHANGED")
  }
}
async function main() {
  const raw = process.argv[2]
  if (Buffer.byteLength(raw) > 16384) fail("TEST_INPUT_LIMIT")
  const request = JSON.parse(raw)
  if (request.mode === "reference") {
    object(request, ["mode", "reference", "files", "subjects"])
    const ref = request.reference
    object(ref, ["protocol", "projectId", "stageId", "version", "pluginDigest",
      "workspaceIdentity", "current", "sources", ...(Object.hasOwn(ref, "configuration") ? ["configuration"] : [])])
    if (ref.protocol !== "devclaw.artifact-input/v1" ||
        ![ref.projectId, ref.stageId].every(value => typeof value === "string" && value.length > 0 && value.length <= 256) ||
        !Number.isSafeInteger(ref.version) || ref.version < 1 ||
        ![ref.pluginDigest, ref.workspaceIdentity].every(value => /^[a-f0-9]{64}$/.test(value)))
      fail("TEST_REFERENCE_INVALID")
    const current = ref.current
    object(current, ["artifactId", "path", "maxBytes", "bytes", "sha256"])
    if (current.maxBytes !== 28000 || !Number.isSafeInteger(current.bytes) || current.bytes < 0)
      fail("TEST_REFERENCE_INVALID")
    const content = read(current.path, current.maxBytes)
    if (content.length !== current.bytes || hash(content) !== current.sha256) fail("TEST_REPORT_CHANGED")
    if (ref.sources.some(row => row.path.toLowerCase() === current.path.toLowerCase() || row.artifactId === current.artifactId))
      fail("TEST_REFERENCE_INVALID")
    const sourceFingerprint = sources(ref.sources, true)
    const selection = JSON.parse(content.toString("utf8"))
    object(selection, ["protocol", "runId", "executionId"])
    if (selection.protocol !== "devclaw.test-report-selection/v1" ||
        ![selection.runId, selection.executionId].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)))
      fail("TEST_SELECTION_INVALID")
    const testsFingerprint = request.files === null ? null : tests(request.files)
    const subjectFingerprint = request.subjects === null ? null : subjects(request.subjects)
    unchanged()
    return { selection, sourceFingerprint, testsFingerprint, subjectFingerprint }
  }
  object(request, ["mode", "files", "sources", "subjects", "timeoutMs"])
  if (request.mode !== "execute" || !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 100 || request.timeoutMs > 300000) fail("TEST_INPUT_INVALID")
  const sourceFingerprint = sources(request.sources, false)
  const testsFingerprint = tests(request.files)
  const subjectFingerprint = subjects(request.subjects)
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 }
  let runnerFailed = false, completed = false
  // Each test file is isolated. Test console/stdout/stderr events are deliberately ignored.
  const stream = run({ files: request.files, concurrency: false, isolation: "process",
    execArgv: [], timeout: request.timeoutMs, forceExit: true })
  for await (const event of stream) {
    if (event.type === "test:summary" && event.data.file === undefined) {
      completed = true
      runnerFailed = !event.data.success
    }
    if (event.type === "test:fail") runnerFailed = true
    if (!["test:pass", "test:fail"].includes(event.type) || event.data.details?.type === "suite" ||
        !Number.isSafeInteger(event.data.line) || event.data.line < 1 ||
        request.files.some(file => path.resolve(file) === path.resolve(event.data.name))) continue
    counts.total++
    if (event.data.skip || event.data.todo) counts.skipped++
    else if (event.type === "test:pass") counts.passed++
    else counts.failed++
    if (counts.total > 100000) fail("TEST_CASE_LIMIT")
  }
  unchanged()
  // Hash again: unchanged timestamps alone do not prove immutable input bytes.
  if (tests(request.files) !== testsFingerprint || sources(request.sources, false) !== sourceFingerprint ||
      subjects(request.subjects) !== subjectFingerprint)
    fail("TEST_FILE_CHANGED")
  unchanged()
  const passed = completed && !runnerFailed && counts.total > 0 && counts.passed > 0 &&
    counts.failed === 0 && counts.skipped === 0
  return { passed, runner: "node-test/v1", sourceFingerprint, testsFingerprint, subjectFingerprint, counts }
}
main().then(value => {
  process.stdout.write(JSON.stringify(value))
  process.exitCode = value.passed === false ? 1 : 0
}).catch(error => {
  const code = /^TEST_[A-Z_]+$/.test(error.message) ? error.message : "TEST_EXECUTION_UNAVAILABLE"
  process.stdout.write(JSON.stringify({ passed: false, errors: [{ code }], warnings: [] }))
  process.exitCode = 1
})
`

export function adapterInvocation(
  input: { mode: string; timeoutMs?: number } & Record<string, unknown>
) {
  // A stdin script avoids Node propagating an eval bootstrap into isolated test children.
  return {
    argv: ["node", "-", JSON.stringify(input)],
    init: {
      integrity: "native" as const,
      stdin: runnerBootstrap,
      timeoutMs: input.mode === "execute" ? input.timeoutMs! + 5000 : 30000,
      env: { NODE_OPTIONS: "", NODE_PATH: "" }
    }
  }
}

export function parseAdapterResult<T>(result: { stdout: string; exitCode: number }) {
  let value: { passed?: boolean }
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw Error("TEST_ADAPTER_RESULT_INVALID")
  }
  if (
    ![0, 1].includes(result.exitCode) ||
    typeof value !== "object" ||
    !value ||
    (result.exitCode === 0 && value.passed === false) ||
    (result.exitCode !== 0 && value.passed !== false)
  )
    throw Error("TEST_ADAPTER_RESULT_INVALID")
  return { value: value as T, exitCode: result.exitCode }
}
