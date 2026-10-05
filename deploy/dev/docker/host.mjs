import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { mkdir, readFile, writeFile, lstat, realpath, access } from "node:fs/promises"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { parseDocument } from "yaml"
import { run } from "../process.mjs"

export const PROFILE = "devclaw-bot"
export const BASE = join(homedir(), ".devclaw-bot-b00")
export const RUNTIME = join(BASE, "runtime")
export const SOCKET = join(BASE, "colima", PROFILE, "docker.sock")
export const TOOLS = { docker: "/opt/homebrew/bin/docker", colima: "/opt/homebrew/bin/colima", compose: "/opt/homebrew/bin/docker-compose" }
const OWNER_FILE = join(BASE, "owner.json")

export function rejectInherited(env = process.env) {
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "COLIMA_HOME", "COLIMA_PROFILE", "LIMA_HOME", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (env[key] !== undefined) throw new Error("B00_HOST_OVERRIDE")
  }
}

export async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 })
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error("B00_PRIVATE_DIRECTORY")
  return s
}

export async function privateFile(path) {
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) throw new Error("B00_PRIVATE_FILE")
  return readFile(path, "utf8")
}

export async function hostState({ create = false } = {}) {
  rejectInherited()
  if (Number(process.versions.node.split(".")[0]) !== 22 || process.platform !== "darwin" || process.arch !== "arm64") throw new Error("B00_PLATFORM")
  if (create) {
    try {
      await privateDirectory(BASE, true)
      await writeFile(OWNER_FILE, JSON.stringify({ kind: "devclaw-bot-b00-v1", id: randomUUID() }) + "\n", { mode: 0o600, flag: "wx" })
    } catch (error) { if (error.code !== "EEXIST") throw error }
    // Colima 0.10.3 only honors COLIMA_HOME if that directory already exists.
    // An existing base without the exact owner marker is never adopted.
    const owner = JSON.parse(await privateFile(OWNER_FILE))
    if (owner.kind !== "devclaw-bot-b00-v1") throw new Error("B00_OWNER")
    for (const path of [RUNTIME, join(BASE, "client"), join(BASE, "colima"), join(BASE, "cache")]) {
      try { await privateDirectory(path, true) } catch (error) { if (error.code !== "EEXIST") throw error }
      await privateDirectory(path)
    }
    try { await writeFile(join(BASE, "client", "config.json"), JSON.stringify({ auths: {}, cliPluginsExtraDirs: ["/opt/homebrew/lib/docker/cli-plugins"] }) + "\n", { mode: 0o600, flag: "wx" }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
  }
  await privateDirectory(BASE)
  await privateDirectory(RUNTIME)
  await privateDirectory(join(BASE, "client"))
  const owner = JSON.parse(await privateFile(OWNER_FILE))
  if (owner.kind !== "devclaw-bot-b00-v1" || !/^[a-f0-9-]{36}$/.test(owner.id)) throw new Error("B00_OWNER")
  const client = JSON.parse(await privateFile(join(BASE, "client", "config.json")))
  if (JSON.stringify(client) !== JSON.stringify({ auths: {}, cliPluginsExtraDirs: ["/opt/homebrew/lib/docker/cli-plugins"] })) throw new Error("B00_CLIENT_CONFIG")
  for (const executable of Object.values(TOOLS)) {
    if (!isAbsolute(executable)) throw new Error("B00_TOOL_PATH")
    await access(executable, constants.X_OK)
  }
  await privateDirectory(join(BASE, "colima"))
  return { owner, env: { HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC", COLIMA_HOME: join(BASE, "colima"), COLIMA_CACHE_HOME: join(BASE, "cache"), DOCKER_CONFIG: join(BASE, "client") } }
}

export async function colima(state, args, options = {}) {
  return run(TOOLS.colima, ["--profile", PROFILE, ...args], { env: state.env, cwd: BASE, ...options })
}

export function vmSpec() {
  return {
    cpu: 2, disk: 30, memory: 4, arch: "aarch64", runtime: "docker", modelRunner: "docker", hostname: "colima-devclaw-bot",
    kubernetes: { enabled: false, version: "v1.35.0+k3s1", k3sArgs: ["--disable=traefik"], port: 0 },
    autoActivate: false,
    network: { address: false, mode: "shared", interface: "en0", preferredRoute: false, dns: null, dnsHosts: {}, hostAddresses: false, gatewayAddress: "192.168.5.2" },
    forwardAgent: false, docker: {}, vmType: "vz", portForwarder: "ssh", rosetta: true, binfmt: true, nestedVirtualization: false,
    mountType: "virtiofs", mountInotify: false, cpuType: "", provision: null, sshConfig: false, sshPort: 0,
    mounts: [{ location: RUNTIME, writable: false }], diskImage: "", forceDiskImage: false, rootDisk: 20, env: {}
  }
}

export function validateVmText(text) {
  // Parse the complete document, reject duplicate keys/aliases/unknown fields,
  // and compare nested fields at their real paths. No windowed text assertions.
  const document = parseDocument(text, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length) throw new Error("B00_VM_CONFIGURATION")
  let config
  try { config = document.toJS({ maxAliasCount: 0 }) } catch { throw new Error("B00_VM_CONFIGURATION") }
  if (!isDeepStrictEqual(config, vmSpec())) throw new Error("B00_VM_CONFIGURATION")
  return config
}

export async function validateVm(state) {
  validateVmText(await readFile(join(BASE, "colima", PROFILE, "colima.yaml"), "utf8"))
  const profile = JSON.parse(await privateFile(join(BASE, "profile-owner.json")))
  if (profile.id !== state.owner.id || profile.profile !== PROFILE) throw new Error("B00_PROFILE_OWNER")
}

export async function daemon(state) {
  await validateVm(state)
  const stat = await lstat(SOCKET)
  if (!stat.isSocket() || stat.uid !== process.getuid() || await realpath(SOCKET) !== SOCKET) throw new Error("B00_LOCAL_SOCKET")
  const info = JSON.parse(await docker(state, ["info", "--format", "{{json .}}"], { stdoutOnly: true }))
  if (info.Name !== "colima-devclaw-bot" || info.OSType !== "linux" || !["aarch64", "arm64"].includes(info.Architecture)) throw new Error("B00_DAEMON_PROFILE")
  const idFile = join(BASE, "daemon-id.json")
  let saved
  try { saved = JSON.parse(await privateFile(idFile)) } catch (error) {
    if (error.code !== "ENOENT") throw error
    await writeFile(idFile, JSON.stringify({ id: info.ID }) + "\n", { mode: 0o600, flag: "wx" })
    saved = { id: info.ID }
  }
  if (!saved.id || saved.id !== info.ID) throw new Error("B00_DAEMON_ID")
  return { id: info.ID, name: info.Name, architecture: info.Architecture, version: info.ServerVersion }
}

export async function docker(state, args, options = {}) {
  return run(TOOLS.docker, ["--config", join(BASE, "client"), "--host", `unix://${SOCKET}`, ...args], { cwd: BASE, env: state.env, ...options })
}

export async function vmStart(state) {
  const marker = join(BASE, "profile-owner.json")
  let existing = true
  try { await lstat(join(BASE, "colima", PROFILE)) } catch (error) {
    if (error.code !== "ENOENT") throw error
    existing = false
    try { await writeFile(marker, JSON.stringify({ id: state.owner.id, profile: PROFILE }) + "\n", { mode: 0o600, flag: "wx" }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
  }
  const owner = JSON.parse(await privateFile(marker))
  if (owner.id !== state.owner.id || owner.profile !== PROFILE) throw new Error("B00_PROFILE_OWNER")
  if (existing) await validateVm(state)
  await colima(state, ["start", "--cpus", "2", "--memory", "4", "--disk", "30", "--arch", "aarch64", "--runtime", "docker", "--vm-type", "vz", "--vz-rosetta", "--mount", RUNTIME, "--mount-type", "virtiofs", "--activate=false", "--ssh-config=false", "--template=false", "--ssh-agent=false", "--kubernetes=false", "--network-address=false", "--network-host-addresses=false"], { timeoutMs: 1800000, maxOutput: 262144 })
  return daemon(state)
}

export async function vmStop(state) {
  await validateVm(state)
  await colima(state, ["stop"], { timeoutMs: 90000 })
  return { profile: PROFILE, status: "stopped", data: "preserved" }
}
