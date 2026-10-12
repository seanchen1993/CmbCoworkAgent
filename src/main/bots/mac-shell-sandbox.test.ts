import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { macBotShellPolicy, prepareMacBotShell } from "./mac-shell-sandbox"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { botShellEnvironment, type BotShellRequest } from "./shell-contract"

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const native = it.skipIf(process.platform !== "darwin")
const launcher = {
  entry: resolve(
    process.env.CMB_BOT_SHELL_TEST_COMPILED === "1"
      ? "out/main/bot-shell.js"
      : "src/main/bots/shell-worker-entry.ts"
  ),
  executable: process.env.CMB_BOT_NODE ?? process.execPath,
  execArgv: process.env.CMB_BOT_SHELL_TEST_COMPILED === "1" ? [] : ["--import", "tsx"]
}
async function prepareFixtureShell(request: BotShellRequest) {
  // Match the production factory's explicit, read-only runtime module grant.
  // Development dependencies may live behind the repository's node_modules link.
  return prepareMacBotShell(request, launcher, [await realpath(resolve("node_modules"))])
}
async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "cmb-shell-os-scope-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '项目 "目录'),
    control = join(root, "control")
  await mkdir(workspace)
  await mkdir(control)
  await writeFile(join(control, "descriptor.json"), "FAKE_CONTROL_ONLY")
  await writeFile(join(root, "ungranted.txt"), "FAKE_OTHER_DATA")
  await writeFile(join(workspace, "task.cjs"), script)
  const request: BotShellRequest = {
    cwd: workspace,
    protectedRoots: [control],
    command: "node task.cjs",
    timeoutMs: 5000,
    runId: "sandbox-test",
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  }
  return { root, workspace, control, request }
}

native(
  "blocks indirect private reads, links, out-of-project writes and control sockets while preserving project execution",
  async () => {
    const f = await fixture(`
    const fs=require('node:fs'),net=require('node:net');
    const result={};
    for(const [name,action] of Object.entries({
      privateRead:()=>fs.readFileSync('../control/descriptor.json'),
      otherRead:()=>fs.readFileSync('../ungranted.txt'),
      linkedRead:()=>fs.readFileSync('control-link/descriptor.json'),
      outsideWrite:()=>fs.writeFileSync('../outside.txt','unapproved'),
      hardLink:()=>{fs.linkSync('../control/descriptor.json','copied-control');fs.readFileSync('copied-control');},
      projectWrite:()=>fs.writeFileSync('result.txt','allowed'),
      toolHomeWrite:()=>fs.writeFileSync(require('node:path').join(require('node:os').homedir(),'tool-cache'),'allowed'),
      temporaryWrite:()=>fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(),'scratch'),'allowed')
    })) {try{action();result[name]='allowed'}catch(e){result[name]=e.code}}
    const socket=net.connect('control.sock');
    socket.on('connect',()=>{result.socket='allowed';socket.destroy();console.log(JSON.stringify(result))});
    socket.on('error',e=>{result.socket=e.code;console.log(JSON.stringify(result))});
  `)
    await symlink(f.control, join(f.workspace, "control-link"))
    let connected = false
    const server = createServer((socket) => {
      connected = true
      socket.destroy()
    })
    // The socket's path is readable: only the OS network policy can block it.
    server.listen(join(f.workspace, "control.sock"))
    await once(server, "listening")
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
    const result = await (
      await createTrustedBotShellTestRunner(cleanup)
    ).execute(f.request, new AbortController().signal)
    expect(result.exitCode).toBe(0)
    const data = JSON.parse(result.output)
    for (const key of [
      "privateRead",
      "otherRead",
      "linkedRead",
      "outsideWrite",
      "hardLink",
      "socket"
    ])
      expect(["EPERM", "EACCES"]).toContain(data[key])
    expect(data.projectWrite).toBe("allowed")
    expect(data.toolHomeWrite).toBe("allowed")
    expect(data.temporaryWrite).toBe("allowed")
    expect(connected).toBe(false)
    expect(await readFile(join(f.workspace, "result.txt"), "utf8")).toBe("allowed")
    expect(await readFile(join(f.control, "descriptor.json"), "utf8")).toBe("FAKE_CONTROL_ONLY")
  },
  20_000
)

native(
  "does not grant full disk reads through a PATH symlink to the filesystem root",
  async () => {
    const f = await fixture("")
    const link = join(f.workspace, "root-path")
    await symlink("/", link)
    vi.stubEnv("PATH", `${process.env.PATH ?? ""}:${link}`)
    const prepared = await prepareFixtureShell(f.request)
    cleanup.push(prepared.close)
    vi.unstubAllEnvs()
    const child = spawn(
      prepared.launcher.executable!,
      [
        ...prepared.launcher.execArgv!,
        "--eval",
        `
          const fs=require('node:fs');
          fs.writeFileSync(${JSON.stringify(join(f.workspace, "allowed"))},'project');
          try { fs.readFileSync(${JSON.stringify(join(f.root, "ungranted.txt"))}); console.log('allowed'); }
          catch (error) { console.log(error.code); }
        `
      ],
      {
        env: {
          ...botShellEnvironment(process.env),
          ...prepared.launcher.environment,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let output = "",
      error = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      error += chunk
    })
    expect((await once(child, "close"))[0], error).toBe(0)
    expect(["EPERM", "EACCES"]).toContain(output.trim())
    expect(await readFile(join(f.workspace, "allowed"), "utf8")).toBe("project")
  },
  15_000
)

native(
  "enforces OS read-only access even for indirect code and removes its disposable scratch directory",
  async () => {
    const f = await fixture("")
    f.request.readOnly = true
    const prepared = await prepareFixtureShell(f.request)
    cleanup.push(prepared.close)
    const scratch = prepared.launcher.environment!.TMPDIR!
    expect(prepared.launcher.environment!.HOME).toBe(join(scratch, "home"))
    const process = spawn(
      prepared.launcher.executable!,
      [
        ...prepared.launcher.execArgv!,
        "--eval",
        `
      try{require('fs').writeFileSync(${JSON.stringify(join(f.workspace, "out"))},'bad');console.log('allowed')}
      catch(e){console.log(e.code)}
    `
      ],
      {
        env: {
          ...botShellEnvironment(globalThis.process.env),
          ...prepared.launcher.environment,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    let output = "",
      error = ""
    process.stdout.on("data", (chunk) => {
      output += chunk
    })
    process.stderr.on("data", (chunk) => {
      error += chunk
    })
    expect((await once(process, "close"))[0], error).toBe(0)
    expect(output.trim()).toBe("EPERM")
    await prepared.close()
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" })
  },
  15_000
)

native(
  "refuses a workspace in the private control directory and does not dispatch a fallback",
  async () => {
    const f = await fixture("throw new Error('must not execute')")
    f.request.protectedRoots = [f.root]
    await expect(
      (await createTrustedBotShellTestRunner(cleanup)).execute(
        f.request,
        new AbortController().signal
      )
    ).rejects.toThrow("后台数据目录")
    f.request.protectedRoots = [join(f.root, "missing")]
    await expect(
      (await createTrustedBotShellTestRunner(cleanup)).execute(
        f.request,
        new AbortController().signal
      )
    ).rejects.toThrow()
  }
)

native(
  "keeps local preview servers and approved HTTP requests usable inside the project sandbox",
  async () => {
    const f = await fixture(`
    const http=require('node:http');
    const server=http.createServer((request,response)=>response.end('preview'));
    server.listen(0,'127.0.0.1',async()=>{
      try{const response=await fetch('http://127.0.0.1:'+server.address().port);console.log(await response.text());}
      catch(e){console.error(e.message);process.exitCode=1}
      finally{server.closeAllConnections();server.close()}
    });
  `)
    const result = await (
      await createTrustedBotShellTestRunner(cleanup)
    ).execute(f.request, new AbortController().signal)
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output.trim()).toBe("preview")
  },
  15_000
)

native.each([false, true])(
  "removes command caches when the owning Host disconnects (background=%s)",
  async (background) => {
    const f = await fixture(`
      const fs=require('fs'),path=require('path');
      fs.writeFileSync(path.join(require('os').homedir(),'cache'),'temporary');
      setInterval(()=>fs.appendFileSync('ticks','x'),30);
    `)
    if (background) f.request.background = true
    const prepared = await prepareFixtureShell(f.request)
    cleanup.push(prepared.close)
    const scratch = prepared.launcher.environment!.TMPDIR!
    const worker = spawn(
      prepared.launcher.executable!,
      [...prepared.launcher.execArgv!, prepared.launcher.entry],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...botShellEnvironment(process.env),
          ...prepared.launcher.environment,
          ELECTRON_RUN_AS_NODE: "1"
        }
      }
    )
    cleanup.push(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        const done = once(worker, "exit")
        worker.kill()
        await done
      }
    })
    await once(worker, "spawn")
    worker.send(f.request)
    const tickFile = join(f.workspace, "ticks")
    for (let attempt = 0; ; attempt++) {
      if (await stat(tickFile).catch(() => undefined)) break
      if (attempt === 100) throw new Error("Sandboxed command did not start")
      await delay(50)
    }
    expect(await readFile(join(scratch, "home", "cache"), "utf8")).toBe("temporary")
    const done = once(worker, "exit")
    worker.disconnect()
    await done
    const ticks = await readFile(tickFile, "utf8")
    await delay(100)
    expect(await readFile(tickFile, "utf8")).toBe(ticks)
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" })
  },
  20_000
)

it("rejects malformed profile paths instead of allowing policy interpolation", () => {
  for (const path of ["relative", "/tmp/\n(allow default)", "/tmp/\0"])
    expect(() =>
      macBotShellPolicy({ readRoots: [path], writeRoots: [], protectedRoots: [] })
    ).toThrow()
})
