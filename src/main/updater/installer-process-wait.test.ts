import { randomBytes } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ executable: "" }))
vi.mock("electron", () => ({
  app: { getPath: () => fixture.executable, getVersion: () => "1.0.0" }
}))
vi.mock("./downloader", () => ({
  getUpdatesDir: () => {
    throw Error("Unexpected desktop storage access")
  }
}))
vi.mock("./logger", () => ({
  appendUpdateLog: vi.fn(),
  updaterLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
import { generateUpdateSh, generateRollbackSh } from "./installer"

let directory: string
let previousResources: PropertyDescriptor | undefined
const children: ChildProcess[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cmb update wait-"))
  fixture.executable = join(directory, `Cb${randomBytes(4).toString("hex")}`)
  previousResources = Object.getOwnPropertyDescriptor(process, "resourcesPath")
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: directory })
})
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "close")
      child.kill("SIGKILL")
      await exited
    }
  }
  if (previousResources) Object.defineProperty(process, "resourcesPath", previousResources)
  else Reflect.deleteProperty(process, "resourcesPath")
  await rm(directory, { recursive: true, force: true })
})

it.skipIf(process.platform === "win32").each(["update", "rollback"])(
  "%s waits for the actual application executable before replacing any ASAR bytes",
  async (kind) => {
    // A uniquely named harmless real process. Never target or terminate an installed app.
    // macOS may terminate a relocated Apple-signed system binary. Build this
    // tiny fixture with the host compiler instead of copying /bin/sleep.
    const source = join(directory, "fixture.c")
    await writeFile(
      source,
      "#include <unistd.h>\nint main(int argc, char **argv) { if(argc > 1 && argv[1][0] == '-') return 0; sleep(20); return 0; }\n"
    )
    const compiled = spawnSync("cc", [source, "-o", fixture.executable], { encoding: "utf8" })
    expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0)
    const app = spawn(fixture.executable, ["20"], { stdio: "ignore" })
    children.push(app)
    await once(app, "spawn")
    await vi.waitFor(() => {
      const found = spawnSync("pgrep", ["-x", basename(fixture.executable)], { encoding: "utf8" })
      expect(found.stdout.trim().split("\n")).toContain(String(app.pid))
    })
    const current = join(directory, "app.asar"),
      payload = join(directory, "payload.asar")
    await writeFile(current, "original application")
    await writeFile(payload, "replacement application")
    await chmod(current, 0o644)
    await chmod(payload, 0o600)
    const script = join(directory, "replace.sh")
    await writeFile(
      script,
      kind === "update" ? generateUpdateSh(payload, "1.0.0", "1.0.1") : generateRollbackSh(payload)
    )
    const installer = spawn("bash", [script], {
      env: { ...process.env, UPDATE_LOG: join(directory, "installer.log") },
      stdio: "ignore"
    })
    children.push(installer)
    const finished = once(installer, "close")
    // The real pgrep must observe the running process and wait, not immediately copy.
    const phase = await Promise.race([finished.then(() => "exited"), delay(1200, "waiting")])
    expect(
      phase,
      JSON.stringify({
        exitCode: installer.exitCode,
        appExitCode: app.exitCode,
        appSignal: app.signalCode,
        current: await readFile(current, "utf8"),
        log: await readFile(join(directory, "installer.log"), "utf8").catch(() => "missing log")
      })
    ).toBe("waiting")
    expect(await readFile(current, "utf8")).toBe("original application")
    const stopped = once(app, "close")
    app.kill("SIGTERM")
    await stopped
    expect(await finished).toEqual([0, null])
    expect(await readFile(current, "utf8")).toBe("replacement application")
    expect((await stat(current)).mode & 0o777).toBe(0o644)
    if (kind === "update")
      expect(await readFile(join(directory, "app.asar.bak"), "utf8")).toBe("original application")
  },
  12_000
)

it.skipIf(process.platform === "win32").each(["update", "rollback", "backup"])(
  "%s keeps the installed ASAR intact when killed midway through copying the payload",
  async (kind) => {
    const current = join(directory, "app.asar"),
      payload = join(directory, "payload.asar"),
      script = join(directory, "interrupt.sh")
    await writeFile(current, "original complete application")
    await writeFile(payload, "replacement complete application")
    if (kind === "backup")
      await writeFile(join(directory, "app.asar.bak"), "previous complete recovery copy")
    // Interrupt only this generated script at an actual partial write. A shell
    // function observes the final copy destination, without editing the installer.
    const fault = `cp() {
  local src="\${@: -2:1}" dst="\${@: -1}"
  if [ "$src" = "$INTERRUPT_PAYLOAD" ]; then
    printf 'partial payload' > "$dst"
    kill -KILL $$
    return 1
  fi
  command cp "$@"
}
`
    await writeFile(
      script,
      fault +
        (kind === "rollback"
          ? generateRollbackSh(payload)
          : generateUpdateSh(payload, "1.0.0", "1.0.1"))
    )
    const child = spawn("bash", [script], {
      env: {
        ...process.env,
        UPDATE_LOG: join(directory, "interrupted.log"),
        INTERRUPT_PAYLOAD: kind === "backup" ? current : payload
      },
      stdio: "ignore"
    })
    children.push(child)
    expect(await once(child, "close")).toEqual([null, "SIGKILL"])
    expect(await readFile(current, "utf8")).toBe("original complete application")
    expect(await readFile(payload, "utf8")).toBe("replacement complete application")
    if (kind === "update")
      expect(await readFile(join(directory, "app.asar.bak"), "utf8")).toBe(
        "original complete application"
      )
    if (kind === "backup")
      expect(await readFile(join(directory, "app.asar.bak"), "utf8")).toBe(
        "previous complete recovery copy"
      )
  }
)
