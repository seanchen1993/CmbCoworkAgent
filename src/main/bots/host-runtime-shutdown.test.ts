import { expect, it } from "vitest"
import { build } from "esbuild"
import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// Windows Node does not deliver kill(SIGTERM/SIGINT) as POSIX signals.
// These lifecycle probes cover macOS/Linux; no Windows kernel verdict is inferred.
const posix = it.skipIf(process.platform === "win32")

// Exercise the production runtime orchestration, not a copy of cleanup().
// Model/native dependencies are controlled ports; the Host process, OS signals,
// held TCP resource, RPC socket, and eventual process exit are real.
const ports = String.raw`
import { createServer, createConnection } from 'node:net';
let resource, client, accepted, rpc, releaseReady;
export const resourceReady = new Promise(resolve => { releaseReady = resolve; });
export const events = [];
const note = value => { events.push(value); process.send?.({ kind: value }); };
process.on('message', message => {
  if (message.kind === 'release') client.end();
  if (message.kind === 'probe') process.send?.({ kind: 'alive' });
  if (message.kind === 'restart') void restart();
});
export const BOT_PROTOCOL_VERSION = 1;
export const BOT_BUILD_ID = 'fixture';
export const ownedShellMaintenanceOwner = () => ({});
export const assertBotOwnedShellMaintenance = async () => {};
// Signal/direct-RPC shutdown does not enter idle-restart preflight. Fail closed
// if that boundary is invoked; this fixture cannot certify receipt maintenance.
export const inspectBotOwnedShellMaintenance = async () => {
  throw new Error('Idle restart maintenance inspection invoked in shutdown fixture');
};
export const recoverClosedBotShellResources = async () => {};
export const recoverClosedNativeDesktopResources = async () => {};
export const recoverBotComputerCheckpoint = async () => {};
export const recoverBotRestore = async () => {};
export const repairLegacyComputerGeneration = () => {};
export const createBotHostShellFactory = async () => ({});
export const createBotLocalToolAuthority = () => ({});
export const createBotPeerDispatchAdmission = () => ({ check: async () => null });
export const withInstalledBotNativeConfiguration = value => value;
export const botBrowserFileReceiver = () => ({});
export const botMemoryModels = () => ({});
export const installBotNetwork = async () => ({ close: async () => note('network-closed') });
// This POSIX fixture never provisions Windows resources. Fail explicitly if
// orchestration accidentally enters that platform branch; do not fake closure.
const unavailableNativePort = () => { throw new Error('Windows native port invoked in POSIX fixture'); };
export const createWindowsNativeDesktopFactory = unavailableNativePort;
export const readBotOwnedShellArtifact = unavailableNativePort;
export class BotDomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class NativeDesktopNoAllocationError extends Error {}
export class NativeDesktopBroker { constructor() { unavailableNativePort(); } }
export class NativeDesktopControlStore { constructor() { unavailableNativePort(); } }
export class NativeBotTeachSource { constructor() { unavailableNativePort(); } }
export class BotShellProcess {}
export class CmbBotRuntime {}
export class BotSharedWorkspace { static async open(root) { return { path: root }; } }
export class BotStore {
  localTools = { bind() {} };
  browserDownloads = { recoverAtStartup() {} };
  backupSchedule = {};
  recoverAbandonedAtStartup() {}
  listBots() { return []; }
  dataEpoch() { return 'initial'; }
  close() { note('store-closed'); }
}
export class LocalBotComputerProvider { shutdown() { return this.close(); } async close() { note('computer-closed'); } }
export class BotArtifacts { async recover() {} async close() { note('files-closed'); } }
export class BotTeachService { recover() {} bindFailureReporter() {} async close() {} }
export class BotSecretRequests {}
export class BotSecretVault {}
export class MacBotSecretProtection {}
export class BotSkillCatalogSync { start() {} async close() {} }
export class BotBackupScheduler { bindFailureReporter() {} start() {} async close() {} }
export class BotStorageMonitor { start() {} close() {} }
export class BotWebhookServer { async start() {} async close() {} }
export class BotMemorySynthesis { bindFailureReporter() {} start() {} async close() {} }
export class BotHost {
  id = 'fixture';
  bindOwnership() {} assertOwnership() {} bindPeerDispatchAdmission() {}
  bindIdleRestartPreflight(inspect) {
    if (this.idleRestartPreflight) throw new Error('Idle restart preflight is already bound');
    this.idleRestartPreflight = inspect;
  }
  start() {
    resource = createServer(socket => { accepted = socket; releaseReady(); });
    resource.listen(0, '127.0.0.1', () => {
      client = createConnection(resource.address().port, '127.0.0.1');
      client.on('error', () => {});
    });
  }
  async stop() {
    note('shutdown-started');
    await resourceReady;
    await new Promise(resolve => resource.close(resolve));
    note('resource-closed');
    if (process.argv.includes('--fail-background')) throw new Error('controlled close failure');
  }
}
export const closeBotHostBackgroundActivity = (host, memory) =>
  Promise.allSettled([host?.backups?.close(), memory?.close(), host?.stop()]);
let restart;
export class BotRpcServer {
  constructor(_host, _token, callback) { restart = callback; }
  async listen(path) {
    rpc = createServer();
    await new Promise(resolve => rpc.listen(path, resolve));
  }
  async close() { await new Promise(resolve => rpc.close(resolve)); }
}
export const noteLockReleased = () => note('lock-released');
`

type Message = { kind: string }
async function runtimeFixture(failBackground = false): Promise<{
  child: ChildProcess
  messages: string[]
  wait: (kind: string) => Promise<void>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  close: () => Promise<void>
}> {
  const root = await realpath(await mkdtemp(join("/tmp", "bot-host-shutdown-")))
  // The fixed source location lets the same test prove baseline/candidate behavior.
  const entry = join(import.meta.dirname, "host-runtime-entry.ts")
  const fixture = join(root, "runtime.cjs")
  const lockEntry = join(import.meta.dirname, "host-lock.ts")
  await build({
    stdin: {
      contents: `import { startBotHost } from ${JSON.stringify(entry)};
import { resourceReady, noteLockReleased } from 'fixture-ports';
import { BotHostLock } from ${JSON.stringify(lockEntry)};
(async () => {
  const lock = BotHostLock.acquire(${JSON.stringify(root)});
  if (!lock) throw new Error('Fixture lifetime lock unavailable');
  const release = lock.release.bind(lock);
  lock.release = () => { release(); noteLockReleased(); };
  await startBotHost(${JSON.stringify(root)}, lock);
  await resourceReady;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => process.send?.({ kind: 'signal-observed' }));
  process.send?.({ kind: 'ready' });
})().catch(error => { console.error(error); process.exit(2); });`,
      resolveDir: root,
      sourcefile: "shutdown-fixture.ts",
      loader: "ts"
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: fixture,
    plugins: [
      {
        name: "controlled-host-ports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.path === "fixture-ports" ||
              (args.importer === entry &&
                args.path.startsWith(".") &&
                args.path !== "./host-socket")
            )
              return { path: "ports", namespace: "fixture" }
            return undefined
          })
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: ports,
            loader: "js"
          }))
        }
      }
    ]
  })
  const child = fork(fixture, failBackground ? ["--fail-background"] : [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Real socket orchestration uses a deliberately short owned TMPDIR; only
    // unavailable model/native services are mapped to controlled fixture ports.
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }
  })
  const physicallyClosed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let stderr = ""
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
  const messages: string[] = []
  const listeners = new Set<() => void>()
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      result = { code, signal }
      for (const listener of listeners) listener()
      resolve(result)
    })
  })
  child.on("message", (message: Message) => {
    messages.push(message.kind)
    for (const listener of listeners) listener()
  })
  const wait = (kind: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const finish = () => {
        if (messages.includes(kind)) {
          clearTimeout(timer)
          listeners.delete(finish)
          resolve()
        } else if (result) {
          clearTimeout(timer)
          listeners.delete(finish)
          reject(new Error(`Host exited before ${kind}: ${JSON.stringify(result)}; ${stderr}`))
        }
      }
      const timer = setTimeout(() => {
        listeners.delete(finish)
        reject(new Error(`Host did not reach ${kind}: ${stderr}`))
      }, 2000)
      listeners.add(finish)
      finish()
    })
  return {
    child,
    messages,
    wait,
    exited,
    async close() {
      if (!result) child.kill("SIGKILL")
      await exited
      await physicallyClosed
      await rm(root, { recursive: true, force: true })
    }
  }
}

posix.each(["signal", "restart"] as const)(
  "joins %s shutdown when SIGINT arrives before physical closure",
  async (first) => {
    const fixture = await runtimeFixture()
    try {
      await fixture.wait("ready")
      if (first === "signal") fixture.child.kill("SIGTERM")
      else fixture.child.send({ kind: "restart" })
      await fixture.wait("shutdown-started")
      expect(fixture.messages).not.toContain("resource-closed")
      fixture.child.kill("SIGINT")
      await fixture.wait("signal-observed")
      fixture.child.send({ kind: "probe" })
      await fixture.wait("alive")
      expect(fixture.messages.filter((item) => item === "shutdown-started")).toHaveLength(1)
      fixture.child.send({ kind: "release" })
      expect(await fixture.exited).toEqual({ code: 0, signal: null })
      expect(fixture.messages).toEqual(
        expect.arrayContaining([
          "resource-closed",
          "computer-closed",
          "files-closed",
          "network-closed",
          "store-closed",
          "lock-released"
        ])
      )
      expect(fixture.messages.filter((item) => item === "lock-released")).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  }
)

posix("finishes one normal signal shutdown before releasing the lifetime lock", async () => {
  const fixture = await runtimeFixture()
  try {
    await fixture.wait("ready")
    fixture.child.kill("SIGTERM")
    await fixture.wait("shutdown-started")
    fixture.child.send({ kind: "release" })
    expect(await fixture.exited).toEqual({ code: 0, signal: null })
    const closed = fixture.messages.indexOf("resource-closed")
    expect(closed).toBeGreaterThan(-1)
    expect(fixture.messages.indexOf("store-closed")).toBeGreaterThan(closed)
    expect(fixture.messages.indexOf("lock-released")).toBeGreaterThan(
      fixture.messages.indexOf("store-closed")
    )
  } finally {
    await fixture.close()
  }
})

posix("keeps cleanup failure fatal and does not release the lifetime lock", async () => {
  const fixture = await runtimeFixture(true)
  try {
    await fixture.wait("ready")
    fixture.child.send({ kind: "restart" })
    await fixture.wait("shutdown-started")
    fixture.child.kill("SIGINT")
    await fixture.wait("signal-observed")
    fixture.child.send({ kind: "probe" })
    await fixture.wait("alive")
    fixture.child.send({ kind: "release" })
    expect(await fixture.exited).toEqual({ code: 1, signal: null })
    expect(fixture.messages).toContain("resource-closed")
    expect(fixture.messages).not.toContain("store-closed")
    expect(fixture.messages).not.toContain("lock-released")
  } finally {
    await fixture.close()
  }
})

posix("keeps repeated SIGTERM joined until the physical resource closes", async () => {
  const fixture = await runtimeFixture()
  try {
    await fixture.wait("ready")
    fixture.child.kill("SIGTERM")
    await fixture.wait("shutdown-started")
    // The fixture's one-time signal witness has now been removed as well.
    // Only the production lifecycle handler may protect the second delivery.
    await fixture.wait("signal-observed")
    fixture.child.kill("SIGTERM")
    const premature = await Promise.race([
      fixture.exited.then((value) => value),
      delay(80).then(() => undefined)
    ])
    expect(premature, "second SIGTERM must not bypass cleanup's existing deadline").toBeUndefined()
    fixture.child.send({ kind: "probe" })
    await fixture.wait("alive")
    expect(fixture.messages).not.toContain("resource-closed")
    expect(fixture.messages.filter((item) => item === "shutdown-started")).toHaveLength(1)
    fixture.child.send({ kind: "release" })
    expect(await fixture.exited).toEqual({ code: 0, signal: null })
    expect(fixture.messages).toContain("resource-closed")
    expect(fixture.messages).toContain("lock-released")
  } finally {
    await fixture.close()
  }
})
