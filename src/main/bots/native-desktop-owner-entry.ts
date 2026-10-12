import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { connect } from "node:net"
import { join, win32 } from "node:path"
import { verifyNativeShellPackage } from "./native-shell-package"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import {
  assertNativeShellArtifacts,
  assertNativeShellRoots,
  createBotNativeCommandAdapter
} from "./native-shell-command"
import { botShellEnvironment } from "./shell-contract"
import { NativeDesktopFrameDecoder } from "./native-desktop-transport"
import {
  nativeIsolationProbeInvocation,
  readNativeIsolationProbe
} from "./native-shell-probe-command"
import {
  nativeDesktopBootstrapConfiguration,
  nativeDesktopPolicyRoots
} from "./native-desktop-resource"

/** Fixed compiled entry: the actual native owner enrolls this process in its
 * unique Job BEFORE execution. The parent CLI retains its private HDESK. */
async function start(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Native desktop owner requires Windows")
  const channel = process.env.CMB_NATIVE_DESKTOP_CHANNEL,
    token = process.env.CMB_NATIVE_DESKTOP_TOKEN,
    nonce = process.env.CMB_NATIVE_DESKTOP_NONCE
  if (
    !channel?.startsWith("\\\\.\\pipe\\CMBDevClaw-Desktop-") ||
    !token ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !nonce ||
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    process.env.CMB_BOT_RESOURCE_JOB !== `Local\\CMBDevClaw-Bot-${nonce}`
  )
    throw new Error("Invalid trusted native desktop launch")
  const socket = connect(channel)
  let worker: ChildProcessWithoutNullStreams | undefined
  let configured = false,
    closed = false
  const stop = () => {
    if (closed) return
    closed = true
    socket.destroy()
    // No descendant/Job closure claim is made here. EOF/exit tells the external
    // native owner to fence the resource and publish its kernel-empty proof.
    process.exitCode = 125
    worker?.stdin.destroy()
    setTimeout(() => process.exit(125), 100).unref()
  }
  const timer = setTimeout(stop, 35_000)
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  process.once("uncaughtException", stop)
  process.once("unhandledRejection", stop)
  socket.on("error", stop)
  socket.once("close", stop)
  socket.once("connect", () => {
    const data = Buffer.from(
      JSON.stringify({
        type: "hello",
        protocol: "cmb-native-desktop-bootstrap-v1",
        version: 1,
        nonce,
        bootstrapPid: process.pid,
        token
      })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length)
    socket.write(Buffer.concat([header, data]), (error) => {
      if (error) stop()
    })
  })
  const decoder = new NativeDesktopFrameDecoder((raw) => {
    if (configured) throw new Error("Duplicate desktop bootstrap configuration")
    configured = true
    socket.pause()
    socket.removeListener("data", data)
    void (async () => {
      const config = nativeDesktopBootstrapConfiguration.parse(raw)
      if (
        config.nonce !== nonce ||
        config.nativePlan.platform !== "win32" ||
        config.nativePlan.arch !== process.arch ||
        config.runtimeMode !== "readonly-installed"
      )
        throw new Error("Native desktop startup identity differs")
      await verifyOwnedShellArtifact(config.bootstrap)
      if (config.bootstrap.entry !== process.argv[1])
        throw new Error("Native desktop bootstrap entry differs")
      const pkg = await verifyNativeShellPackage(config.packageDirectory, config.manifestSha256)
      if (
        !pkg.desktopWorker ||
        pkg.desktopWorker.runtimeMode !== "readonly-installed" ||
        pkg.desktopWorker.assets.length === 0 ||
        pkg.manifest.desktopOwnerProtocol !== "cmb-native-desktop-owner-v1" ||
        pkg.cli.entry !== config.nativePlan.cli.entry ||
        pkg.cli.sha256 !== config.nativePlan.cli.sha256 ||
        pkg.nativeHelper.sha256 !== config.nativePlan.nativeHelper.sha256
      )
        throw new Error("Native desktop distribution is incomplete")
      const roots = nativeDesktopPolicyRoots(config.nativePlan)
      const under = (root: string, path: string) => {
        const part = win32.relative(root, path)
        return part === "" || (part !== ".." && !part.startsWith("..\\") && !win32.isAbsolute(part))
      }
      if (
        roots.writeRoots.some((root) => under(root, pkg.directory)) ||
        !roots.writeRoots.some((root) => under(root, config.scratchDirectory))
      )
        throw new Error("Native desktop runtime/scratch policy differs")
      await assertNativeShellRoots(config.nativePlan)
      await assertNativeShellArtifacts(config.nativePlan)
      await pkg.assertCurrent()
      const probe = await nativeIsolationProbeInvocation({
        plan: config.nativePlan,
        executable: process.execPath,
        nonce,
        ...config.probe,
        assertArtifacts: async (signal) => {
          await assertNativeShellArtifacts(config.nativePlan, signal)
          await pkg.assertCurrent(signal)
        },
        signal: new AbortController().signal
      })
      await new Promise<void>((resolve, reject) => {
        const child = spawn(probe.protocol.executable, probe.protocol.args, {
          cwd: config.nativePlan.startupCwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: {
            ...botShellEnvironment(process.env),
            ...probe.environment,
            ELECTRON_RUN_AS_NODE: "1"
          }
        })
        let count = 0,
          reported = false
        const buffers: Buffer[] = []
        const deadline = setTimeout(() => {
          child.kill()
          reject(new Error("Desktop native preparation timed out"))
        }, 15_000)
        child.stdout.on("data", (chunk: Buffer) => {
          count += chunk.length
          if (count > 4096) {
            child.kill()
            reject(new Error("Desktop probe exceeds bound"))
            return
          }
          buffers.push(chunk)
          if (!reported && chunk.includes(10)) {
            try {
              const observed = readNativeIsolationProbe(
                Buffer.concat(buffers, count).toString("utf8"),
                nonce
              )
              if (!observed.pid) throw new Error("Desktop live probe PID missing")
              reported = true
              const payload = Buffer.from(
                JSON.stringify({
                  type: "native-probe",
                  protocol: "cmb-native-desktop-bootstrap-v1",
                  version: 1,
                  nonce,
                  observation: observed
                })
              )
              const header = Buffer.alloc(4)
              header.writeUInt32BE(payload.length)
              socket.write(Buffer.concat([header, payload]), (error) => {
                if (error) {
                  child.kill()
                  reject(error)
                }
              })
            } catch (error) {
              child.kill()
              reject(error)
            }
          }
        })
        child.once("error", (error) => {
          clearTimeout(deadline)
          reject(error)
        })
        child.once("close", (code, signal) => {
          clearTimeout(deadline)
          if (!reported || code !== 0 || signal !== null)
            reject(new Error("Desktop native preparation failed"))
          else resolve()
        })
      })
      const adapter = createBotNativeCommandAdapter(config.nativePlan, async (signal) => {
        await assertNativeShellArtifacts(config.nativePlan, signal)
        await pkg.assertCurrent(signal)
      })
      const launch = await adapter({
        command: "[fixed native desktop worker]",
        shell: pkg.desktopWorker.entry,
        isWindows: true,
        cwd: config.nativePlan.cwd,
        protocol: {
          executable: pkg.desktopWorker.entry,
          args: ["--native-desktop-worker", nonce],
          shell: false,
          stdin: "",
          onOutput: () => {}
        }
      })
      if (closed) throw new Error("Native desktop parent disconnected")
      worker = spawn(launch.protocol.executable, launch.protocol.args, {
        cwd: config.nativePlan.startupCwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...botShellEnvironment(process.env),
          ...launch.environment,
          TEMP: config.scratchDirectory,
          TMP: config.scratchDirectory,
          TMPDIR: config.scratchDirectory,
          HOME: join(config.scratchDirectory, "home"),
          ELECTRON_RUN_AS_NODE: "1",
          CMB_BOT_NATIVE_DESKTOP: "1"
          // Channel/token/nonce are deliberately absent from the restricted child.
        }
      })
      worker.stderr.resume()
      worker.once("error", stop)
      worker.once("close", () => {
        socket.end()
        stop()
      })
      worker.stdin.on("error", stop)
      worker.stdout.on("error", stop)
      // Native framing remains unchanged. Node stream pipes bound backpressure;
      // no screenshot re-serialization or unbounded message queue is introduced.
      worker.stdout.pipe(socket, { end: false })
      socket.pipe(worker.stdin)
      socket.resume()
      clearTimeout(timer)
    })().catch(stop)
  }, 256 * 1024)
  const data = (bytes: Buffer) => {
    try {
      decoder.feed(bytes)
    } catch {
      stop()
    }
  }
  socket.on("data", data)
}
void start().catch(() => {
  process.exitCode = 125
})
