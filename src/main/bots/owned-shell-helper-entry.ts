import { runWindowsBotSandboxSetupOwner } from "./windows-provisioning-owner"
import { runLinuxBotCgroupWitness } from "./linux-bot-cgroup-witness"
import { readNativeShellResourceRecord } from "./linux-native-resource"
import { enterLinuxBotCgroup } from "./linux-bot-cgroup"
import { readPrivateJson } from "./backup-io"
import { ownedShellReceiptSchema, OWNED_SHELL_RECEIPT_BYTES } from "./owned-shell-receipt-contract"
import { runOwnedShellClosureWitness } from "./owned-shell-closure"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import { spawn, type ChildProcess } from "node:child_process"
import { isAbsolute } from "node:path"
import { connect } from "node:net"
import {
  botShellEnvironment,
  botShellProgressSchema,
  botShellResultSchema,
  type BotShellProgress,
  type BotShellResult
} from "./shell-contract"
import { safeSensitiveErrorText } from "../error-text"
import {
  OWNED_SHELL_FRAME_BYTES,
  OWNED_SHELL_REQUEST_BYTES,
  OwnedShellDecoder,
  OwnedShellWriter,
  ownedShellControlSchema
} from "./owned-shell-wire"

if (process.env.CMB_BOT_WINDOWS_PROVISIONING === "1") {
  void runWindowsBotSandboxSetupOwner().then(
    () => {
      process.exitCode = 0
    },
    () => {
      process.exitCode = 125
    }
  )
} else if (process.env.CMB_BOT_SHELL_NATIVE_WITNESS === "1") {
  void runLinuxBotCgroupWitness().catch(() => {
    process.exitCode = 1
    process.disconnect?.()
  })
} else if (process.env.CMB_BOT_SHELL_CLOSURE_WITNESS === "1") {
  void runOwnedShellClosureWitness().catch(() => {
    process.exitCode = 1
    process.disconnect?.()
  })
} else startResourceOwner()
function startResourceOwner(): void {
  // This fixed Host-launched entry contains no eval/shell/model-provided launch
  // logic. POSIX: Root creates its own detached process group. Windows: the
  // shipped native Job controller owns this process before it starts the worker.
  const channel = process.env.CMB_BOT_SHELL_CONTROL_CHANNEL
  const nonce = process.env.CMB_BOT_SHELL_CONTROL_NONCE
  const token = process.env.CMB_BOT_SHELL_CONTROL_TOKEN
  const ownerMode = process.env.CMB_BOT_SHELL_OWNER_MODE
  if (
    !channel ||
    !nonce ||
    !token ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    !(process.platform === "win32"
      ? ownerMode === "windows-atomic-job-v2"
      : process.platform === "linux"
        ? ["posix-group", "linux-cgroup"].includes(ownerMode ?? "")
        : ownerMode === "posix-group")
  )
    throw new Error("Invalid shell resource launch")
  let witness: ChildProcess | undefined
  let worker: ChildProcess | undefined,
    sequence = 0,
    receivedSequence = 0
  let started = false,
    ready = false,
    requestSent = false,
    prepared = false,
    committed = false,
    accepted = false,
    candidate = false,
    closing = false
  let pendingProgress: BotShellProgress | undefined
  let pendingCandidate:
    | { type: "result"; value: BotShellResult }
    | { type: "error"; message: string }
    | undefined
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  const socket = connect(channel)
  const closeResource = (): void => {
    if (closing) return
    closing = true
    clearTimeout(startupTimer)
    if (shutdownTimer) clearTimeout(shutdownTimer)
    output.close()
    // The stable trusted owner is alive at this exact operation. No recorded PID
    // is signalled after this owner closes, and the Host's group is never used.
    if (process.platform === "win32") process.exit(125)
    try {
      process.kill(-process.pid, "SIGKILL")
    } catch {
      process.exit(125)
    }
  }
  const output = new OwnedShellWriter(socket, OWNED_SHELL_FRAME_BYTES, closeResource)
  const frame = (type: string, rest: object = {}, options = {}) => {
    output.send(() => ({ type, nonce, sequence: ++sequence, ...rest }), options)
  }
  const startupTimer = setTimeout(closeResource, 30_000)
  const cancel = (): void => {
    if (closing) return
    if (!committed) return closeResource()
    if (worker?.connected) worker.send({ cancel: true }, () => {})
    // Do not release the resource merely because a leader/worker exited. Keep
    // the owner until Root has received its candidate and requests the fence.
    shutdownTimer ??= setTimeout(closeResource, 8000)
    if (!worker) closeResource()
  }
  process.once("SIGTERM", cancel)
  process.once("SIGINT", closeResource)
  process.once("uncaughtException", closeResource)
  process.once("unhandledRejection", closeResource)
  socket.once("connect", () => frame("hello", { helperPid: process.pid, token }))
  socket.once("error", closeResource)
  socket.once("close", closeResource)
  const decoder = new OwnedShellDecoder(OWNED_SHELL_REQUEST_BYTES, (value) => {
    const message = ownedShellControlSchema.parse(value)
    if (message.nonce !== nonce || message.sequence !== ++receivedSequence) return closeResource()
    if (message.type === "cancel") {
      cancel()
      return
    }
    if (message.type === "fence") {
      if (!candidate) return closeResource()
      closeResource()
      return
    }
    if (message.type === "run") {
      if (!ready || requestSent || candidate || !worker?.connected) return closeResource()
      requestSent = true
      worker.send(message.request, (error) => {
        if (error) closeResource()
      })
      return
    }
    if (message.type === "commit") {
      if (!prepared || committed || candidate || !worker?.connected) return closeResource()
      committed = true
      worker.send({ commit: nonce }, (error) => {
        if (error) return closeResource()
        // Node IPC callbacks and child output may interleave. Keep one latest
        // progress and one terminal until the accepted frame is actually written.
        frame(
          "accepted",
          {},
          {
            written: () => {
              accepted = true
              if (pendingCandidate) {
                frame("candidate", { outcome: pendingCandidate }, { discardProgress: true })
                pendingCandidate = undefined
                pendingProgress = undefined
              } else if (pendingProgress) {
                frame("progress", { value: pendingProgress }, { replaceable: true })
                pendingProgress = undefined
              }
            }
          }
        )
      })
      return
    }
    if (started || !isAbsolute(message.launch.entry) || !isAbsolute(message.launch.executable))
      return closeResource()
    started = true
    void (async () => {
      await verifyOwnedShellArtifact({
        entry: message.launch.entry,
        sha256: message.launch.entrySha256
      })
      if (closing) return
      if (process.platform !== "win32") {
        witness = spawn(process.execPath, ["--max-old-space-size=64", __filename], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: true,
          windowsHide: true,
          env: {
            ...botShellEnvironment(process.env),
            ELECTRON_RUN_AS_NODE: "1",
            ...(ownerMode === "linux-cgroup"
              ? { CMB_BOT_SHELL_NATIVE_WITNESS: "1" }
              : { CMB_BOT_SHELL_CLOSURE_WITNESS: "1" }),
            CMB_BOT_SHELL_CONTROL_NONCE: nonce,
            CMB_BOT_SHELL_RECEIPT_DIRECTORY: process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY
          }
        })
        await new Promise<void>((resolve, reject) => {
          witness!.once("error", reject)
          witness!.once("close", () => reject(new Error("Closure witness closed before readiness")))
          witness!.once("message", (raw) => {
            if (
              !raw ||
              typeof raw !== "object" ||
              Object.keys(raw).length !== 1 ||
              !(ownerMode === "linux-cgroup"
                ? "nativeWitnessReady" in raw && raw.nativeWitnessReady === true
                : "witnessReady" in raw && raw.witnessReady === true)
            )
              reject(new Error("Invalid closure witness readiness"))
            else resolve()
          })
        })
        witness.once("close", () => {
          if (!closing) closeResource()
        })
        if (closing) return
        if (ownerMode === "linux-cgroup") {
          const path = process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY!
          const receipt = ownedShellReceiptSchema.parse(
            (await readPrivateJson(path, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
          )
          const native = await readNativeShellResourceRecord(path, receipt)
          if (
            !native ||
            native.resource.kind !== "verified-linux-cgroup-v2" ||
            !message.launch.nativePlan
          )
            throw new Error("Native owner resource is unavailable")
          await enterLinuxBotCgroup(native.resource)
        } else if (message.launch.nativePlan)
          throw new Error("Native policy has no actual owner resource")
      }
      if (process.platform === "win32") {
        const path = process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY!
        const receipt = ownedShellReceiptSchema.parse(
          (await readPrivateJson(path, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
        )
        const native = await readNativeShellResourceRecord(path, receipt)
        if (
          !native ||
          native.resource.kind !== "verified-windows-atomic-job-v2" ||
          native.resource.jobName !== process.env.CMB_BOT_RESOURCE_JOB ||
          message.launch.nativePlan?.platform !== "win32"
        )
          throw new Error("Windows atomic resource is unavailable")
      }
      worker = spawn(
        message.launch.executable,
        [...message.launch.execArgv, message.launch.entry],
        {
          cwd: message.launch.startupCwd ?? message.launch.cwd,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: false,
          windowsHide: true,
          env: {
            ...botShellEnvironment(process.env),
            ...message.launch.environment,
            ELECTRON_RUN_AS_NODE: "1",
            ...(process.platform === "win32"
              ? { CMB_BOT_RESOURCE_JOB: process.env.CMB_BOT_RESOURCE_JOB }
              : {}),
            CMB_BOT_SHELL_RESOURCE_NONCE: nonce,
            CMB_BOT_SHELL_RESOURCE_PID: String(process.pid)
          }
        }
      )
      worker.once("error", closeResource)
      worker.once("spawn", () => {
        if (message.launch.nativePlan)
          worker!.send(
            {
              nativePlan: message.launch.nativePlan,
              probe: {
                nonce,
                readSentinel: process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY + "/owner.json",
                deniedWrite: process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY + "/probe-denied-write",
                controlChannel: channel,
                ...(process.platform === "win32"
                  ? {
                      releaseFile:
                        message.launch.environment.CMB_BOT_COMMAND_SCRATCH +
                        "/native-probe-release.json"
                    }
                  : {})
              }
            },
            (error) => {
              if (error) closeResource()
            }
          )
        const publishReady = () => {
          if (closing) return
          ready = true
          clearTimeout(startupTimer)
          frame("ready", { helperPid: process.pid, workerPid: worker?.pid })
        }
        if (witness?.connected && ownerMode !== "linux-cgroup") {
          witness.once("message", (raw) => {
            if (
              !raw ||
              typeof raw !== "object" ||
              Object.keys(raw).length !== 1 ||
              !("witnessWorkerReady" in raw) ||
              raw.witnessWorkerReady !== true
            )
              return closeResource()
            publishReady()
          })
          witness.send({ workerPid: worker?.pid }, (error) => {
            if (error) closeResource()
          })
        } else if (
          process.platform === "win32" ||
          (ownerMode === "linux-cgroup" && witness?.connected)
        )
          publishReady()
        else closeResource()
      })
      worker.on("message", (value: unknown) => {
        try {
          if (
            !requestSent ||
            candidate ||
            !value ||
            typeof value !== "object" ||
            Object.keys(value).length !== 1
          )
            return closeResource()
          if ("nativeProbePid" in value) {
            if (
              process.platform !== "win32" ||
              prepared ||
              committed ||
              !Number.isInteger(value.nativeProbePid) ||
              Number(value.nativeProbePid) <= 0 ||
              Number(value.nativeProbePid) > 0x7fffffff
            )
              return closeResource()
            frame("native-probe", { pid: value.nativeProbePid })
          } else if ("prepared" in value) {
            if (value.prepared !== true || prepared || committed) return closeResource()
            prepared = true
            frame("prepared")
          } else if ("progress" in value) {
            if (!committed) return closeResource()
            const progress = botShellProgressSchema.parse(value.progress)
            if (accepted) frame("progress", { value: progress }, { replaceable: true })
            else pendingProgress = progress
          } else if ("result" in value || "error" in value) {
            if ("result" in value && !committed) return closeResource()
            const outcome =
              "result" in value
                ? { type: "result" as const, value: botShellResultSchema.parse(value.result) }
                : {
                    type: "error" as const,
                    message: safeSensitiveErrorText(
                      typeof value.error === "string" ? value.error : "命令执行失败",
                      2000
                    )
                  }
            candidate = true
            if (accepted || !committed) frame("candidate", { outcome }, { discardProgress: true })
            else pendingCandidate = outcome
            shutdownTimer ??= setTimeout(closeResource, 8000)
          } else closeResource()
        } catch {
          closeResource()
        }
      })
      worker.once("close", () => {
        if (!candidate) closeResource()
      })
    })().catch(closeResource)
  })
  socket.on("data", (bytes) => {
    try {
      decoder.feed(bytes)
    } catch {
      closeResource()
    }
  })
  socket.once("end", () => {
    try {
      decoder.end()
    } finally {
      closeResource()
    }
  })
}
