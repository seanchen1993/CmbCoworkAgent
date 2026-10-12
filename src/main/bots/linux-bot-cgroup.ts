import { performance } from "node:perf_hooks"
import { constants } from "node:fs"
import { open, lstat, mkdir, realpath, rmdir, statfs } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"

const decimal = z.string().regex(/^[0-9]+$/)
export const linuxBotResourceLimits = z
  .object({
    pids: z.number().int().min(16).max(4096),
    memoryBytes: z
      .number()
      .int()
      .min(256 * 1024 * 1024)
      .max(16 * 1024 * 1024 * 1024)
  })
  .strict()
export type LinuxBotResourceLimits = z.infer<typeof linuxBotResourceLimits>
export const DEFAULT_LINUX_BOT_RESOURCE_LIMITS: LinuxBotResourceLimits = {
  pids: 512,
  memoryBytes: 2 * 1024 * 1024 * 1024
}
const controlPin = z.object({ dev: decimal, ino: decimal }).strict()

export const linuxBotCgroupScope = z
  .object({
    format: z.literal(1),
    kind: z.literal("verified-linux-cgroup-v2"),
    nonce: z.string().uuid(),
    root: z.object({ path: z.string().min(1).max(4096), dev: decimal, ino: decimal }).strict(),
    leaf: z.object({ path: z.string().min(1).max(4096), dev: decimal, ino: decimal }).strict(),
    limits: linuxBotResourceLimits,
    controllers: z.object({ pids: controlPin, memory: controlPin }).strict(),
    bootId: z.string().uuid()
  })
  .strict()
export type LinuxBotCgroupScope = z.infer<typeof linuxBotCgroupScope>
const CGROUP2_MAGIC = 0x63677270n
async function boundedControl(path: string, maximum = 4096): Promise<string> {
  const pin = await lstat(path, { bigint: true })
  if (!pin.isFile() || pin.isSymbolicLink()) throw new Error("Cgroup control file is unsafe")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await file.stat({ bigint: true })
    if (current.dev !== pin.dev || current.ino !== pin.ino)
      throw new Error("Cgroup control file changed")
    const buffer = Buffer.allocUnsafe(maximum + 1),
      read = await file.read(buffer, 0, buffer.length, 0)
    if (read.bytesRead > maximum) throw new Error("Cgroup control value exceeds bound")
    return buffer.subarray(0, read.bytesRead).toString("utf8")
  } finally {
    await file.close()
  }
}
async function writeControl(path: string, value: string): Promise<void> {
  const pin = await lstat(path, { bigint: true })
  if (!pin.isFile() || pin.isSymbolicLink()) throw new Error("Cgroup control file is unsafe")
  const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    const current = await file.stat({ bigint: true })
    if (current.dev !== pin.dev || current.ino !== pin.ino)
      throw new Error("Cgroup control file changed")
    const buffer = Buffer.from(value),
      written = await file.write(buffer, 0, buffer.length, null)
    if (written.bytesWritten !== buffer.length) throw new Error("Incomplete cgroup control write")
  } finally {
    await file.close()
  }
}
export function parseCgroupPopulated(value: string): boolean {
  const lines = value.trim().split("\n"),
    matches = lines.filter((line) => line.startsWith("populated "))
  if (matches.length !== 1 || !/^populated [01]$/.test(matches[0]))
    throw new Error("Invalid cgroup events")
  return matches[0] === "populated 1"
}
export async function assertLinuxBotCgroup(
  scope: LinuxBotCgroupScope,
  checkLimits = true
): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux cgroup is unavailable on this system")
  const value = linuxBotCgroupScope.parse(scope)
  if (value.leaf.path !== join(value.root.path, `cmb-bot-${value.nonce}`))
    throw new Error("Invalid cgroup resource origin")
  for (const pin of [value.root, value.leaf]) {
    const now = await lstat(pin.path, { bigint: true })
    if (
      !isAbsolute(pin.path) ||
      resolve(pin.path) !== pin.path ||
      (await realpath(pin.path)) !== pin.path ||
      now.isSymbolicLink() ||
      !now.isDirectory() ||
      String(now.dev) !== pin.dev ||
      String(now.ino) !== pin.ino
    )
      throw new Error("Linux cgroup identity changed")
    if ((await statfs(pin.path, { bigint: true })).type !== CGROUP2_MAGIC)
      throw new Error("Linux resource requires real cgroup v2")
  }
  if (checkLimits)
    for (const [name, expected, identity] of [
      ["pids.max", String(value.limits.pids), value.controllers.pids],
      ["memory.max", String(value.limits.memoryBytes), value.controllers.memory]
    ] as const) {
      const path = join(value.leaf.path, name),
        now = await lstat(path, { bigint: true })
      if (
        now.isSymbolicLink() ||
        !now.isFile() ||
        String(now.dev) !== identity.dev ||
        String(now.ino) !== identity.ino ||
        (await boundedControl(path, 128)).trim() !== expected
      )
        throw new Error("Linux Bot controller limit changed")
    }
  const boot = (await boundedControl("/proc/sys/kernel/random/boot_id", 128)).trim()
  if (boot !== value.bootId) throw new Error("Linux cgroup belongs to another kernel boot")
}
/** Deployment supplies an actually delegated cgroup-v2 directory. No cgroup
 * mount creation, elevated command, model-selected root or default fallback. */
export async function allocateLinuxBotCgroup(
  root: string,
  nonce: string = randomUUID(),
  rawLimits: LinuxBotResourceLimits = DEFAULT_LINUX_BOT_RESOURCE_LIMITS
): Promise<LinuxBotCgroupScope> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    (await realpath(root)) !== root
  )
    throw new Error("An actual delegated Linux cgroup is required")
  const limits = linuxBotResourceLimits.parse(rawLimits)
  const rootPin = await lstat(root, { bigint: true })
  if (
    rootPin.isSymbolicLink() ||
    !rootPin.isDirectory() ||
    (await statfs(root, { bigint: true })).type !== CGROUP2_MAGIC
  )
    throw new Error("Delegated root is not cgroup v2")
  // Root's unrelated existing processes/controllers are never moved or killed.
  const path = join(root, `cmb-bot-${z.string().uuid().parse(nonce)}`)
  await mkdir(path, { mode: 0o700 })
  try {
    // Deployment must delegate these controllers on the parent beforehand.
    // No parent controller, quota or Pod limit is silently changed here.
    await writeControl(join(path, "pids.max"), String(limits.pids))
    await writeControl(join(path, "memory.max"), String(limits.memoryBytes))
    const pids = await lstat(join(path, "pids.max"), { bigint: true }),
      memory = await lstat(join(path, "memory.max"), { bigint: true })
    const pin = await lstat(path, { bigint: true })
    const scope = linuxBotCgroupScope.parse({
      format: 1,
      kind: "verified-linux-cgroup-v2",
      nonce,
      limits,
      controllers: {
        pids: { dev: String(pids.dev), ino: String(pids.ino) },
        memory: { dev: String(memory.dev), ino: String(memory.ino) }
      },
      root: { path: root, dev: String(rootPin.dev), ino: String(rootPin.ino) },
      leaf: { path, dev: String(pin.dev), ino: String(pin.ino) },
      bootId: (await boundedControl("/proc/sys/kernel/random/boot_id", 128)).trim()
    })
    await assertLinuxBotCgroup(scope)
    if (parseCgroupPopulated(await boundedControl(join(path, "cgroup.events"))))
      throw new Error("New cgroup is populated")
    // cgroup.kill is mandatory, not a best-effort SIGTERM/PID enumeration route.
    const kill = await open(join(path, "cgroup.kill"), constants.O_WRONLY | constants.O_NOFOLLOW)
    await kill.close()
    return scope
  } catch (error) {
    await rmdir(path).catch(() => {})
    throw error
  }
}
/** Called inside the fresh immutable owner BEFORE it starts the worker. The
 * process writes its own live PID, never a saved/possibly reused foreign PID. */
export async function enterLinuxBotCgroup(scope: LinuxBotCgroupScope): Promise<void> {
  await assertLinuxBotCgroup(scope)
  if (parseCgroupPopulated(await boundedControl(join(scope.leaf.path, "cgroup.events"))))
    throw new Error("Cgroup was populated before owner admission")
  await writeControl(join(scope.leaf.path, "cgroup.procs"), String(process.pid))
  await assertLinuxBotCgroup(scope)
  if (!parseCgroupPopulated(await boundedControl(join(scope.leaf.path, "cgroup.events"))))
    throw new Error("Owner did not enter cgroup")
  const listed = (await boundedControl(join(scope.leaf.path, "cgroup.procs"), 32 * 1024))
    .trim()
    .split("\n")
  if (!listed.includes(String(process.pid)))
    throw new Error("Owner cgroup assignment was not acknowledged")
}
/** Independent witness starts outside the leaf BEFORE owner self-admission.
 * It invokes cgroup.kill on authenticated owner IPC EOF, then publishes proof
 * only after the kernel reports populated=0 on the same pinned leaf. */
export async function closeLinuxBotCgroup(
  scope: LinuxBotCgroupScope,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  await assertLinuxBotCgroup(scope, false)
  await writeControl(join(scope.leaf.path, "cgroup.kill"), "1")
  const until = performance.now() + 10_000
  while (parseCgroupPopulated(await boundedControl(join(scope.leaf.path, "cgroup.events")))) {
    signal?.throwIfAborted()
    if (performance.now() >= until) throw new Error("Linux cgroup did not empty")
    await delay(20, undefined, { signal })
  }
  await assertLinuxBotCgroup(scope, false)
}
/** Closed-only coordinator cleanup. Never infer closure from pathname/UUID
 * absence; witness receipt and kernel emptiness both precede removal. */
export async function removeClosedLinuxBotCgroup(scope: LinuxBotCgroupScope): Promise<void> {
  await assertLinuxBotCgroup(scope, false)
  if (parseCgroupPopulated(await boundedControl(join(scope.leaf.path, "cgroup.events"))))
    throw new Error("Cannot remove a live Linux resource")
  if (
    dirname(scope.leaf.path) !== scope.root.path ||
    basename(scope.leaf.path) !== `cmb-bot-${scope.nonce}`
  )
    throw new Error("Invalid cgroup cleanup path")
  await rmdir(scope.leaf.path)
}

/** Idempotent cleanup requires an already validated immutable closure proof.
 * A new boot cannot revive the old resource; do not signal or touch its old
 * path there. On the same boot, a reused leaf inode is never deletion authority. */
export async function removeProvenClosedLinuxBotCgroup(scope: LinuxBotCgroupScope): Promise<void> {
  linuxBotCgroupScope.parse(scope)
  if (process.platform !== "linux") throw new Error("Linux native cleanup requires Linux")
  const boot = (await boundedControl("/proc/sys/kernel/random/boot_id", 128)).trim()
  if (boot !== scope.bootId) return
  try {
    await lstat(scope.leaf.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  await removeClosedLinuxBotCgroup(scope)
}

/** A capability precondition, not a native-run or closure proof. Reject a
 * plain directory, missing delegation and missing memory/pids controllers
 * before consuming any persistent operation slot. Actual leaf controls are
 * still created, written and read back immediately before the owner starts. */
export async function assertLinuxBotDelegation(root: string): Promise<void> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    (await realpath(root)) !== root
  )
    throw new Error("Linux Bot requires a canonical delegated cgroup-v2 root")
  const pin = await lstat(root, { bigint: true })
  if (
    !pin.isDirectory() ||
    pin.isSymbolicLink() ||
    (await statfs(root, { bigint: true })).type !== CGROUP2_MAGIC
  )
    throw new Error("Linux Bot delegated root is not a real cgroup-v2 filesystem")
  const enabled = (await boundedControl(join(root, "cgroup.subtree_control"))).trim().split(/\s+/)
  if (!enabled.includes("memory") || !enabled.includes("pids"))
    throw new Error("Linux Bot requires pre-delegated memory and pids controllers")
  await import("node:fs/promises").then((fs) => fs.access(root, constants.W_OK | constants.X_OK))
}
