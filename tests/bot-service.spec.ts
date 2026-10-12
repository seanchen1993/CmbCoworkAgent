/** Independent Node Host, with freshly installed locked runtime dependencies. */
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotTransportClient, type BotHostDescriptor } from "../src/main/bots/transport-client"

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const node = process.env.CMB_BOT_SERVICE_NODE ?? process.execPath
  const version = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 })
  assert.equal(version.status, 0)
  assert.match(
    version.stdout.trim(),
    /^v22\.(?:1[6-9]|[2-9]\d|\d{3,})\./,
    "Use Node.js >=22.16 <23"
  )
  const temporary = await mkdtemp(join(tmpdir(), "cmb-bot-service-test-"))
  const service = join(temporary, "service"),
    directory = join(temporary, "data")
  const checks: string[] = []
  let child: ChildProcess | undefined, client: BotTransportClient | undefined
  const command = (executable: string, args: string[], cwd: string, shell = false): string => {
    const result = spawnSync(executable, args, {
      cwd,
      shell,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-8000))
    return result.stdout
  }
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    await client?.closeAndWait()
    client = undefined
    const current = child
    child = undefined
    if (!current || current.exitCode !== null || current.signalCode !== null) return
    const closed = new Promise<void>((done) => current.once("close", () => done()))
    current.kill(signal)
    const watchdog = setTimeout(() => current.kill("SIGKILL"), 10_000)
    try {
      await closed
    } finally {
      clearTimeout(watchdog)
    }
  }
  const start = async () => {
    child = spawn(node, [join(service, "run-host.cjs"), "--data-dir", directory], {
      cwd: service,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    })
    let errors = ""
    child.stderr!.on("data", (chunk) => {
      errors = (errors + chunk).slice(-8000)
    })
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Independent Host exited: ${errors}`)
      try {
        const descriptor: BotHostDescriptor = JSON.parse(
          await readFile(join(directory, "host.json"), "utf8")
        )
        if (descriptor.hostId !== "starting" && descriptor.pid === child.pid) {
          const next = new BotTransportClient(descriptor)
          try {
            const status = await next.call("status")
            client = next
            return status
          } catch {
            await next.closeAndWait()
          }
        }
      } catch {
        /* Wait for this new isolated Host's descriptor and authenticated socket. */
      }
      await delay(100)
    }
    throw new Error(`Independent Host did not become ready: ${errors}`)
  }
  try {
    command(node, ["--import", "tsx", "scripts/build-bot-host.ts", "--out-dir", service], root)
    const npmCli = process.env.npm_execpath
    if (npmCli)
      command(
        node,
        [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        service
      )
    else
      command(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        service,
        process.platform === "win32"
      )
    command(
      node,
      [
        "--eval",
        `
      const esbuild = require('esbuild');
      (async () => {
        const transformed = esbuild.transformSync('export const answer: number = 42', { loader: 'ts' });
        if (!transformed.code.includes('42')) throw new Error('Mods compiler unavailable');
        const runtime = await require('quickjs-emscripten').getQuickJS();
        const context = runtime.newContext();
        try {
          const result = context.evalCode('21 * 2');
          if (result.error) { result.error.dispose(); throw new Error('Mods guest failed'); }
          try { if (context.dump(result.value) !== 42) throw new Error('Invalid guest result'); }
          finally { result.value.dispose(); }
        } finally { context.dispose(); }
      })().catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => esbuild.stop());
    `
      ],
      service
    )
    checks.push("installed-Mods-native-compiler-and-QuickJS-runtime")
    const manifest = JSON.parse(await readFile(join(service, "build-manifest.json"), "utf8"))
    const status = await start()
    assert.equal(status.protocol, 1)
    assert.equal(status.runtimeReady, false, "No user model is configured")
    assert.equal(status.buildId, manifest.buildId)
    checks.push("independent-build-and-locked-fresh-install-without-Electron")
    const input = {
      nonce: "service-create",
      name: "独立 Host 验收",
      instructions: "",
      expectedDataEpoch: status.dataEpoch
    }
    const created = await client!.call("create", input)
    assert.deepEqual(await client!.call("create", input), created)
    await client!.closeAndWait()
    client = undefined
    await delay(100)
    assert.equal(child!.exitCode, null)
    await stop("SIGKILL")
    await start()
    const snapshot = await client!.call("snapshot")
    assert.equal(snapshot.bots.length, 1)
    assert.equal(snapshot.bots[0].id, created.bot.id)
    assert.deepEqual(await client!.call("create", input), created)
    checks.push("disconnect-retains-Host-and-SIGKILL-restart-retains-exact-receipt")
    await stop("SIGTERM")
    const artifact = join(service, "out/main/bot-shell.js")
    const original = await readFile(artifact)
    const deniedDirectory = join(temporary, "must-not-be-created")
    await writeFile(artifact, Buffer.concat([original, Buffer.from("\n// modified\n")]))
    try {
      const result = spawnSync(
        node,
        [join(service, "run-host.cjs"), "--data-dir", deniedDirectory],
        {
          cwd: service,
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true
        }
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /artifact identity changed|digest changed/)
      await assert.rejects(access(deniedDirectory), { code: "ENOENT" })
      checks.push("modified-worker-rejects-before-data-effects")
    } finally {
      await writeFile(artifact, original)
    }
    const manifestPath = join(service, "build-manifest.json")
    const originalManifest = await readFile(manifestPath)
    await writeFile(manifestPath, Buffer.alloc(2 * 1024 * 1024 + 1))
    try {
      const result = spawnSync(
        node,
        [join(service, "run-host.cjs"), "--data-dir", deniedDirectory],
        {
          cwd: service,
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true
        }
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /manifest exceeds its limit/)
      await assert.rejects(access(deniedDirectory), { code: "ENOENT" })
      checks.push("oversized-manifest-rejects-before-read-and-data-effects")
    } finally {
      await writeFile(manifestPath, originalManifest)
    }
    const deniedBuild = spawnSync(
      node,
      ["--import", "tsx", "scripts/build-bot-host.ts", "--out-dir", service],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true
      }
    )
    assert.equal(deniedBuild.status, 1)
    assert.match(deniedBuild.stderr, /new directory/)
    assert.deepEqual(await readFile(artifact), original)
    checks.push("existing-service-directory-never-replaced")
    console.log(
      JSON.stringify({
        pass: true,
        runtime: version.stdout.trim(),
        platform: process.platform,
        architecture: process.arch,
        entries: Object.keys(manifest.entries).length,
        checks,
        externalModelAcceptance: false,
        nativeSandboxAcceptance: false,
        k8sAcceptance: false
      })
    )
  } finally {
    await stop("SIGKILL")
    await rm(temporary, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
