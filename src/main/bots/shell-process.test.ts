import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import childProcess, { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { botHookEnvironment, botShellEnvironment, type BotShellRequest } from "./shell-contract"
import { botShellRequestSchema } from "./shell-contract"
import { BotOwnedShellProcess } from "./owned-shell-process"
import {
  BotShellProcess,
  BotShellPreparationError,
  type BotShellOwnedFactory
} from "./shell-process"

it("streams actual background command output before completion through the original Cmb executor", async () => {
  const f = await fixture(
    "console.log('进行中');setTimeout(()=>{console.log('已完成');process.exitCode=7},1200)"
  )
  f.request.background = true
  const updates: string[] = []
  const result = await f.runner.execute(f.request, new AbortController().signal, (value) =>
    updates.push(value.output)
  )
  expect(updates.some((value) => value.includes("进行中") && !value.includes("已完成"))).toBe(true)
  expect(result.output).toContain("已完成")
  expect(result.exitCode).toBe(7)
}, 20_000)

it("stops a background process tree on its own deadline and retains bounded output", async () => {
  const f = await fixture(
    "console.log('started');setInterval(()=>require('fs').appendFileSync('ticks','x'),30)",
    1000
  )
  f.request.background = true
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(124)
  expect(result.output).toContain("started")
  const stopped = await readFile(join(f.directory, "ticks"), "utf8")
  await delay(300)
  expect(await readFile(join(f.directory, "ticks"), "utf8")).toBe(stopped)
}, 20_000)

it("keeps foreground and Hook time limits while validating the extended background contract", () => {
  const input = {
    command: "node task.cjs",
    cwd: "/project",
    runId: "job",
    timeoutMs: 7_200_000,
    execution: { windowsSandbox: "none", resourceDirectory: "/resources" }
  }
  expect(botShellRequestSchema.safeParse(input).success).toBe(false)
  expect(botShellRequestSchema.safeParse({ ...input, background: true }).success).toBe(true)
  expect(
    botShellRequestSchema.safeParse({
      ...input,
      background: true,
      hook: { stdin: "{}", env: {} }
    }).success
  ).toBe(false)
})

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const compiled = process.env.CMB_BOT_SHELL_TEST_COMPILED === "1"
const launcher = {
  entry: resolve(compiled ? "out/main/bot-shell.js" : "src/main/bots/shell-worker-entry.ts"),
  execArgv: compiled ? [] : ["--import", "tsx"],
  executable: process.env.CMB_BOT_NODE ?? process.execPath
}
async function fixture(script: string, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-bot-shell-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "task.cjs"), script)
  const request: BotShellRequest = {
    command: "node task.cjs",
    cwd: directory,
    runId: "shell-test",
    timeoutMs,
    execution: {
      windowsSandbox: "none",
      resourceDirectory: resolve("resources")
    }
  }
  return {
    directory,
    request,
    runner: await createTrustedBotShellTestRunner(cleanup)
  }
}
async function written(file: string) {
  for (let count = 0; count < 100; count++) {
    if ((await readFile(file).catch(() => Buffer.alloc(0))).length) return
    await delay(50)
  }
  throw new Error("Command did not start")
}

it("uses the real shared Cmb executor and returns Unicode output and the actual failure code", async () => {
  const f = await fixture(
    "require('fs').writeFileSync('result.txt', '执行过'); console.log('验证完成'); process.exitCode=7"
  )
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(7)
  expect(result.output).toContain("验证完成")
  expect(await readFile(join(f.directory, "result.txt"), "utf8")).toBe("执行过")
}, 20_000)

it("delivers Hook JSON on stdin without shell interpolation and separates both output streams", async () => {
  const f = await fixture(`
    let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', value=>input+=value);
    process.stdin.on('end', ()=>{
      const payload=JSON.parse(input);
      console.log(JSON.stringify({ decision:'block', reason:payload.prompt, hook:process.env.HOOK_EVENT }));
      console.error('独立诊断');
      require('fs').writeFileSync('received.json',input);
      process.exitCode=2;
    });
  `)
  const stdin = JSON.stringify({
    prompt: "中文 $HOME $(touch injected) `touch injected`\n".repeat(3000)
  })
  f.request.hook = {
    stdin,
    env: { HOOK_EVENT: "PreToolUse", NODE_OPTIONS: "--require=not-permitted" }
  }
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(2)
  expect(JSON.parse(result.hook!.stdout)).toEqual({
    decision: "block",
    reason: JSON.parse(stdin).prompt,
    hook: "PreToolUse"
  })
  expect(result.hook!.stderr.trim()).toBe("独立诊断")
  expect(await readFile(join(f.directory, "received.json"), "utf8")).toBe(stdin)
  await expect(readFile(join(f.directory, "injected"))).rejects.toThrow()
}, 20_000)

it("accepts Hook commands which close stdin without reading it", async () => {
  const f = await fixture("console.log(JSON.stringify({decision:'allow'}))")
  f.request.hook = { stdin: "x".repeat(900_000), env: {} }
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.hook!.stdout)).toEqual({ decision: "allow" })
}, 20_000)

it("rejects truncated Hook protocol output and stops the producing process before returning", async () => {
  const f = await fixture(`
    const fs=require('fs');
    console.log(JSON.stringify({decision:'allow'}));
    setInterval(()=>{fs.appendFileSync('ticks','x'); process.stdout.write('x'.repeat(131072))},10);
  `)
  f.request.hook = { stdin: "{}", env: {} }
  await expect(f.runner.execute(f.request, new AbortController().signal)).rejects.toThrow(
    "exceeds 1 MB"
  )
  const before = await readFile(join(f.directory, "ticks"), "utf8")
  await delay(250)
  expect(await readFile(join(f.directory, "ticks"), "utf8")).toBe(before)
}, 20_000)

it("only forwards documented event metadata from the Hook environment", () => {
  expect(
    botHookEnvironment({
      HOOK_EVENT: "Stop",
      TOOL_ARGS: "{}",
      PATH: "evil",
      NODE_OPTIONS: "evil",
      BASH_ENV: "evil",
      OPENAI_API_KEY: "secret"
    })
  ).toEqual({ HOOK_EVENT: "Stop", TOOL_ARGS: "{}" })
})

it("stops a timed out command and preserves its partial output", async () => {
  const f = await fixture(
    "const fs=require('fs'); console.log('started'); setInterval(()=>fs.appendFileSync('ticks','x'), 40)",
    1000
  )
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(124)
  expect(result.output).toContain("started")
  const before = await readFile(join(f.directory, "ticks"), "utf8")
  await delay(250)
  expect(await readFile(join(f.directory, "ticks"), "utf8")).toBe(before)
}, 20_000)

it.each([false, true])(
  "waits for cancellation cleanup before rejecting (background=%s)",
  async (background) => {
    const f = await fixture("setInterval(()=>require('fs').appendFileSync('ticks','x'), 40)")
    if (background) f.request.background = true
    const controller = new AbortController()
    const promise = f.runner.execute(f.request, controller.signal)
    const rejected = expect(promise).rejects.toThrow()
    await written(join(f.directory, "ticks"))
    controller.abort(new Error("cancelled"))
    await rejected
    const before = await readFile(join(f.directory, "ticks"), "utf8")
    await delay(250)
    expect(await readFile(join(f.directory, "ticks"), "utf8")).toBe(before)
  },
  20_000
)

it.each([false, true])(
  "cleans up the command when its owning Host IPC connection disappears (background=%s)",
  async (background) => {
    const f = await fixture("setInterval(()=>require('fs').appendFileSync('ticks','x'), 40)")
    if (background) f.request.background = true
    const worker = spawn(launcher.executable, [...launcher.execArgv, launcher.entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...botShellEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" }
    })
    cleanup.push(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        const done = once(worker, "exit")
        worker.kill()
        await done
      }
    })
    await once(worker, "spawn")
    worker.send(f.request)
    await written(join(f.directory, "ticks"))
    const done = once(worker, "exit")
    worker.disconnect()
    await done
    const before = await readFile(join(f.directory, "ticks"), "utf8")
    await delay(250)
    expect(await readFile(join(f.directory, "ticks"), "utf8")).toBe(before)
  },
  20_000
)

it.skipIf(process.platform === "win32")(
  "stops redirected descendants even after the command leader exits",
  async () => {
    const f = await fixture(
      "const {spawn}=require('child_process'); spawn(process.execPath,['-e',`setInterval(()=>require('fs').appendFileSync('ticks','x'),20)`],{stdio:'ignore'}).unref(); console.log('launched')"
    )
    const result = await f.runner.execute(f.request, new AbortController().signal)
    expect(result.exitCode).toBe(0)
    const before = await readFile(join(f.directory, "ticks"), "utf8").catch(() => "")
    await delay(300)
    expect(await readFile(join(f.directory, "ticks"), "utf8").catch(() => "")).toBe(before)
  },
  20_000
)

it("does not inherit model credentials, startup hooks or Git redirection", () => {
  expect(
    botShellEnvironment({
      PATH: "/bin",
      JAVA_HOME: "/jdk",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require=evil",
      BASH_ENV: "evil",
      CMB_BOT_COMMAND_SCRATCH: "/not-owned",
      GIT_DIR: "/wrong"
    })
  ).toEqual({ PATH: "/bin", JAVA_HOME: "/jdk" })
})

it("preserves the original executor's explicit Windows shell and install discovery across both process boundaries", () => {
  const configured = {
    PATH: "D:\\Tools;C:\\Windows\\System32",
    GIT_BASH_PATH: "D:\\PortableGit\\bin\\bash.exe",
    ProgramFiles: "D:\\Programs",
    "ProgramFiles(x86)": "D:\\Programs (x86)",
    ComSpec: "C:\\Windows\\System32\\cmd.exe"
  }
  const host = botShellEnvironment({
    ...configured,
    OPENAI_API_KEY: "private",
    NODE_OPTIONS: "--require=unapproved",
    BASH_ENV: "unapproved",
    GIT_CONFIG_GLOBAL: "unapproved"
  })
  expect(host).toEqual(configured)
  expect(botShellEnvironment(host)).toEqual(configured)
})

it("preserves explicitly empty proxy overrides when starting a Host", () => {
  expect(
    botShellEnvironment({
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://secure-proxy.example:8080",
      NO_PROXY: "*",
      http_proxy: "",
      https_proxy: "",
      no_proxy: "",
      NODE_OPTIONS: "--require=evil"
    })
  ).toEqual({
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://secure-proxy.example:8080",
    NO_PROXY: "*",
    http_proxy: "",
    https_proxy: "",
    no_proxy: ""
  })
})

it("executes Host-owned Harness argv exactly without shell interpolation or displaying credentials", async () => {
  const f = await fixture("console.log(JSON.stringify({args:process.argv.slice(2)}))")
  const values = ['secret"\\credential', "$(touch interpolated) `touch interpolated`", "中文 参数"]
  f.request.command = 'node task.cjs "[已隐藏凭据]"'
  f.request.hook = {
    stdin: "",
    env: {},
    invocation: {
      executable: process.execPath,
      args: [join(f.directory, "task.cjs"), ...values]
    }
  }
  const result = await f.runner.execute(f.request, new AbortController().signal)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.hook!.stdout)).toEqual({ args: values })
  await expect(readFile(join(f.directory, "interpolated"))).rejects.toThrow()
}, 20_000)

it.each(["absent", "disabled"] as const)(
  "rejects an %s shell factory before owned process start or spawn",
  async (kind) => {
    const owned = vi.fn(async () => {
      throw new Error("Unavailable factories must not be prepared")
    })
    const factory: BotShellOwnedFactory | undefined =
      kind === "disabled"
        ? Object.assign(owned, { unavailableReason: "此 Host 不提供命令执行" })
        : undefined
    const runner = new BotShellProcess(factory)
    const start = vi.spyOn(BotOwnedShellProcess.prototype, "start").mockImplementation(() => {
      throw new Error("Unavailable commands must not start an owned process")
    })
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Unavailable commands must not spawn")
    })
    try {
      const request: BotShellRequest = {
        command: "node should-not-run.cjs",
        cwd: resolve("."),
        runId: "unavailable-shell",
        timeoutMs: 1000,
        execution: {
          windowsSandbox: "none",
          resourceDirectory: resolve("resources")
        }
      }
      expect(runner.available).toBe(false)
      expect(() => runner.assertAvailable()).toThrowError(
        expect.objectContaining({ code: "shell_unavailable" })
      )
      const operation = runner.start(request, new AbortController().signal)
      const [admitted, completed] = await Promise.allSettled([
        operation.admitted,
        operation.completion
      ])
      expect(admitted.status).toBe("rejected")
      expect(completed.status).toBe("rejected")
      if (admitted.status !== "rejected" || completed.status !== "rejected")
        throw new Error("Unavailable commands must reject admission and completion")
      expect(admitted.reason).toBeInstanceOf(BotShellPreparationError)
      expect(completed.reason).toBe(admitted.reason)
      expect(completed.reason).toMatchObject({
        code: "shell_unavailable",
        cancelled: false
      })
      await expect(runner.execute(request, new AbortController().signal)).rejects.toBeInstanceOf(
        BotShellPreparationError
      )
      expect(owned).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      start.mockRestore()
      spawn.mockRestore()
    }
  }
)

it("keeps an explicitly injected trusted factory available without preparing a command", () => {
  const owned: BotShellOwnedFactory = vi.fn(async () => {
    throw new Error("Availability checks must not prepare the trusted test factory")
  })
  const runner = new BotShellProcess(owned)
  expect(runner.available).toBe(true)
  expect(() => runner.assertAvailable()).not.toThrow()
  expect(owned).not.toHaveBeenCalled()
})
