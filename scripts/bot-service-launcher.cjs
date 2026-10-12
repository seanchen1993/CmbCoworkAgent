/* eslint-disable @typescript-eslint/no-require-imports -- This Node bootstrap verifies artifacts before loading the Host. */
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

function samePhysicalFile(before, after) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.nlink === 1 &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs
  )
}

function readBoundedJson(root, relative, maximum, expected) {
  const filename = path.join(root, relative)
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("Service metadata is a symbolic link.")
  }
  const stat = fs.lstatSync(filename)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maximum ||
    (expected && stat.size !== expected.bytes)
  )
    throw new Error("Service manifest exceeds its limit or is not a physical file.")
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!samePhysicalFile(stat, fs.fstatSync(fd)))
      throw new Error("Service manifest changed before reading.")
    const raw = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < raw.length) {
      const bytes = fs.readSync(fd, raw, offset, raw.length - offset, offset)
      if (!bytes) throw new Error("Service manifest changed while reading.")
      offset += bytes
    }
    const after = fs.fstatSync(fd)
    if (!samePhysicalFile(stat, after)) throw new Error("Service manifest changed while reading.")
    const named = fs.lstatSync(filename)
    if (
      !samePhysicalFile(stat, named) ||
      (expected && crypto.createHash("sha256").update(raw).digest("hex") !== expected.sha256)
    )
      throw new Error("Service metadata identity or digest changed.")
    return JSON.parse(raw.toString("utf8"))
  } finally {
    fs.closeSync(fd)
  }
}

function readManifest(root) {
  return readBoundedJson(root, "build-manifest.json", 2 * 1024 * 1024)
}

function artifactBudget(root, manifest) {
  const pin = manifest.nativeDistribution
  if (pin === undefined || pin === null) return 512 * 1024 * 1024
  if (
    typeof pin !== "object" ||
    Array.isArray(pin) ||
    Object.keys(pin).sort().join(",") !== "arch,format,manifestSha256,platform" ||
    pin.format !== 1 ||
    !["win32", "linux"].includes(pin.platform) ||
    !["x64", "arm64"].includes(pin.arch) ||
    typeof pin.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.manifestSha256)
  )
    throw new Error("Invalid native service distribution pin.")
  const readPinned = (relative, maximum, digest) => {
    const records = manifest.files.filter(
      (entry) => entry && typeof entry === "object" && entry.path === relative
    )
    const entry = records[0]
    if (
      records.length !== 1 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > maximum ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (digest && entry.sha256 !== digest)
    )
      throw new Error("Native service metadata is not independently pinned.")
    return readBoundedJson(root, relative, maximum, entry)
  }
  const namespace = "out/resources/bot-native-sandbox"
  const installed = readPinned(`${namespace}/distribution-pin.json`, 4096)
  if (
    !installed ||
    typeof installed !== "object" ||
    Array.isArray(installed) ||
    Object.keys(installed).sort().join(",") !== "arch,format,manifestSha256,platform" ||
    installed.format !== pin.format ||
    installed.platform !== pin.platform ||
    installed.arch !== pin.arch ||
    installed.manifestSha256 !== pin.manifestSha256
  )
    throw new Error("Native service installed seal differs from its pin.")
  const native = readPinned(
    `${namespace}/${pin.platform}-${pin.arch}/bot-native-sandbox.json`,
    64 * 1024,
    pin.manifestSha256
  )
  if (
    !native ||
    typeof native !== "object" ||
    Array.isArray(native) ||
    native.format !== 1 ||
    native.platform !== pin.platform ||
    native.arch !== pin.arch
  )
    throw new Error("Native service manifest target differs from its pin.")
  // This grants only a bounded artifact-read budget, never native command authority.
  // The runtime retains full package/probe checks before any user effect.
  return 2 * 1024 * 1024 * 1024
}

function verifyService(root) {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major !== 22 || minor < 16)
    throw new Error("CMBDevClaw Bot service requires Node.js 22.16 or later within Node.js 22.")
  const manifestPath = path.join(root, "build-manifest.json")
  const manifestIdentity = fs.lstatSync(manifestPath)
  const manifest = readManifest(root)
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 16384 ||
    !/^[a-f0-9]{24}$/.test(manifest.buildId)
  )
    throw new Error("Invalid service build manifest.")
  const maximum = artifactBudget(root, manifest)
  let total = 0
  const seen = new Set()
  const verified = [{ filename: manifestPath, identity: manifestIdentity }]
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length > 1024 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.includes(":") ||
      [...entry.path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 512 * 1024 * 1024 ||
      seen.has(entry.path)
    )
      throw new Error("Invalid service artifact identity.")
    seen.add(entry.path)
    total += entry.bytes
    if (total > maximum) throw new Error("Service artifacts exceed their limit.")
    let current = root
    for (const part of entry.path.split("/")) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Service artifact is a symbolic link.")
    }
    const stat = fs.lstatSync(current)
    if (!stat.isFile() || stat.size !== entry.bytes || stat.nlink !== 1)
      throw new Error("Service artifact identity changed.")
    const hash = crypto.createHash("sha256")
    const descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      if (!samePhysicalFile(stat, fs.fstatSync(descriptor)))
        throw new Error("Service artifact changed before reading.")
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      while (offset < entry.bytes) {
        const bytes = fs.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, entry.bytes - offset),
          offset
        )
        if (!bytes) throw new Error("Service artifact changed while reading.")
        hash.update(buffer.subarray(0, bytes))
        offset += bytes
      }
      const opened = fs.fstatSync(descriptor)
      if (
        !samePhysicalFile(stat, opened) ||
        !samePhysicalFile(stat, fs.lstatSync(current)) ||
        hash.digest("hex") !== entry.sha256
      )
        throw new Error("Service artifact digest changed.")
    } finally {
      fs.closeSync(descriptor)
    }
    verified.push({ filename: current, identity: stat })
  }
  if (!seen.has("out/main/bot-host.js")) throw new Error("Service Host artifact is missing.")
  // A large later artifact may take time to hash. Recheck the complete observed
  // set so an ordinary update of an earlier member cannot validate a mixed build.
  for (const { filename, identity } of verified)
    if (!samePhysicalFile(identity, fs.lstatSync(filename)))
      throw new Error("Service artifact set changed during verification.")
  return manifest
}

if (require.main === module) {
  try {
    verifyService(__dirname)
    require("./out/main/bot-host.js")
  } catch (error) {
    console.error("[CMBDevClaw Bot]", error instanceof Error ? error.message : "Startup failed")
    process.exitCode = 1
  }
}
module.exports = { verifyService }
