import { test } from "vitest"
import assert from "node:assert/strict"
import { nativeShellPackage } from "./native-shell-contract"
import { encodeWindowsBotResourceRequest } from "./windows-bot-resource-wire"
import { nativeCommandArgumentsForTest } from "./native-shell-command"
import { parseCgroupPopulated, allocateLinuxBotCgroup } from "./linux-bot-cgroup"
import { compileBotPlatformPlan } from "./bot-strict-platform"
import { readNativeIsolationProbe } from "./native-shell-probe-command"
import { nativeShellClosure } from "./native-shell-lifetime"
import { botShellResultSchema, botShellResultSandboxName } from "./shell-contract"
import { ownedShellFrameSchema } from "./owned-shell-wire"
const nonce = "9e6d13d0-0b7b-4cf3-bc3e-adfd8bbf6a51",
  sha = "a".repeat(64),
  revision = "954fa9057bf3a4521ea34dbd010ff291d5b39763"
function windowsPackage() {
  return {
    format: 1,
    platform: "win32",
    arch: "x64",
    revision,
    protocol: "codex-cmb-owned-sandbox-v1",
    patchSha256: sha,
    cli: { name: "codex.exe", sha256: sha },
    helper: { name: "codex-command-runner.exe", sha256: sha },
    setup: { name: "codex-windows-sandbox-setup.exe", sha256: sha },
    sourceArchive: { name: "native-sources.tgz", sha256: sha },
    jobOwner: { name: "bot-resource-owner.exe", sha256: sha },
    ownerProtocol: "cmb-atomic-windows-job-v2",
    licenses: [
      { name: "CODEX-LICENSE", sha256: sha },
      { name: "CODEX-NOTICE", sha256: sha },
      { name: "CMB-LICENSE", sha256: sha }
    ]
  }
}
test("Windows distribution requires actual owned fork, controller and full provenance", () => {
  assert.equal(nativeShellPackage.parse(windowsPackage()).protocol, "codex-cmb-owned-sandbox-v1")
  for (const key of ["patchSha256", "jobOwner", "setup", "ownerProtocol"]) {
    const value = windowsPackage() as Record<string, unknown>
    delete value[key]
    assert.throws(() => nativeShellPackage.parse(value))
  }
  assert.throws(() =>
    nativeShellPackage.parse({ ...windowsPackage(), protocol: "codex-sandbox-state-v1" })
  )
  assert.throws(() =>
    nativeShellPackage.parse({
      ...windowsPackage(),
      licenses: [
        { name: "CODEX-LICENSE", sha256: sha },
        { name: "CODEX-LICENSE", sha256: sha }
      ]
    })
  )
})
test("Kernel scope cannot be promoted by a weak group's diagnostic proof", () => {
  assert.throws(() =>
    nativeShellClosure.parse({
      format: 2,
      scope: "controlled-inherited-group",
      kernelEmpty: true,
      record: {}
    })
  )
  assert.throws(() =>
    nativeShellClosure.parse({
      format: 2,
      scope: "verified-windows-job",
      kernelEmpty: false,
      record: {}
    })
  )
})
test("desktop distribution seals runtime members and rejects mutable extraction or missing provenance", () => {
  const value = {
    ...windowsPackage(),
    desktopOwnerProtocol: "cmb-native-desktop-owner-v1",
    desktopWorker: {
      name: "CMBDevClaw.NativeDesktop.exe",
      sha256: sha,
      runtimeMode: "readonly-installed",
      assets: [
        "DOTNET-RUNTIME-LICENSE.TXT",
        "DOTNET-RUNTIME-THIRD-PARTY-NOTICES.TXT",
        "DOTNET-WINDOWSDESKTOP-LICENSE.TXT"
      ].map((name) => ({ name, sha256: sha }))
    },
    licenses: [...windowsPackage().licenses, { name: "WINAPP-LICENSE", sha256: sha }]
  }
  assert.equal(nativeShellPackage.parse(value).desktopWorker?.assets.length, 3)
  for (const name of ["../outside.dll", "codex.exe", value.desktopWorker.assets[0].name])
    assert.throws(() =>
      nativeShellPackage.parse({
        ...value,
        desktopWorker: {
          ...value.desktopWorker,
          assets: [...value.desktopWorker.assets, { name, sha256: sha }]
        }
      })
    )
  assert.throws(() =>
    nativeShellPackage.parse({
      ...value,
      desktopWorker: { ...value.desktopWorker, runtimeMode: "self-extract" }
    })
  )
  assert.throws(() =>
    nativeShellPackage.parse({
      ...value,
      desktopWorker: { ...value.desktopWorker, assets: value.desktopWorker.assets.slice(1) }
    })
  )
  assert.throws(() => nativeShellPackage.parse({ ...value, licenses: windowsPackage().licenses }))
})
test("bounded Job wire preserves Unicode/argv and rejects injection and overflow before spawn", () => {
  const input = {
    executable: "/absolute/node.exe",
    cwd: "/absolute/研发",
    receiptDirectory: "/private/operation-1",
    jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
    args: ["--max-old-space-size=128", "C:\\应用\\owner.js"],
    limits: { pids: 512, memoryBytes: 2 * 1024 * 1024 * 1024 },
    bootId: nonce,
    sessionId: 1,
    timeoutMs: 45_000,
    proof: { format: 2, scope: "verified-windows-job" }
  }
  const value = encodeWindowsBotResourceRequest(input)
  let offset = 0
  const number = () => {
    const n = value.readUInt32BE(offset)
    offset += 4
    return n
  }
  const string = () => {
    const n = number(),
      s = value.subarray(offset, offset + n).toString("utf8")
    offset += n
    return s
  }
  assert.equal(number(), value.length - 4)
  assert.equal(string(), "CMBBOTJOB2")
  assert.equal(string(), input.executable)
  assert.equal(string(), input.cwd)
  assert.equal(string(), input.receiptDirectory)
  assert.equal(string(), input.jobName)
  assert.equal(number(), 2)
  assert.equal(string(), input.args[0])
  assert.equal(string(), input.args[1])
  assert.equal(number(), 512)
  assert.equal(number(), 0)
  assert.equal(number(), 2 * 1024 * 1024 * 1024)
  assert.equal(string(), nonce)
  assert.equal(number(), 1)
  assert.equal(number(), 45_000)
  assert.deepEqual(JSON.parse(string()), input.proof)
  assert.equal(offset, value.length)
  assert.throws(() =>
    encodeWindowsBotResourceRequest({ ...input, jobName: "Global\\arbitrary-job" })
  )
  assert.throws(() => encodeWindowsBotResourceRequest({ ...input, args: ["x\0cmd"] }))
  assert.throws(() => encodeWindowsBotResourceRequest({ ...input, proof: "x".repeat(32769) }))
  assert.throws(() => encodeWindowsBotResourceRequest({ ...input, timeoutMs: 0 }))
})
test("native command adapter preserves exact Hook argv/stdin and interpreter boundaries", () => {
  const protocol = {
    executable: "C:\\hook.exe",
    args: ["quoted value", "$()", "中文"],
    stdin: "private credential\n",
    onOutput: () => {}
  }
  assert.deepEqual(
    nativeCommandArgumentsForTest({
      command: "irrelevant",
      shell: "cmd.exe",
      isWindows: true,
      cwd: "cwd",
      protocol
    }),
    { args: [protocol.executable, ...protocol.args], stdin: protocol.stdin }
  )
  assert.deepEqual(
    nativeCommandArgumentsForTest({
      command: "中文",
      shell: "C:\\Git\\bin\\bash.exe",
      isWindows: true,
      cwd: "cwd"
    }),
    { args: ["C:\\Git\\bin\\bash.exe"], stdin: "中文\n" }
  )
  assert.deepEqual(
    nativeCommandArgumentsForTest({
      command: "echo done",
      shell: "/bin/bash",
      isWindows: false,
      cwd: "cwd"
    }),
    { args: ["/bin/bash", "-c", "echo done"], stdin: "" }
  )
})
test("cgroup parser requires one exact populated field; no empty/malformed proof", () => {
  assert.equal(parseCgroupPopulated("populated 0\nfrozen 0\n"), false)
  assert.equal(parseCgroupPopulated("populated 1\nfrozen 0\n"), true)
  for (const value of ["", "populated 2", "populated 0\npopulated 1", "populated 00"])
    assert.throws(() => parseCgroupPopulated(value))
})
test("missing Linux kernel never falls back to a fake cgroup directory", async () => {
  if (process.platform !== "linux")
    await assert.rejects(allocateLinuxBotCgroup("/tmp"), /actual delegated Linux cgroup/)
})
test("split profile rejects static source capability before consulting filesystem", async () => {
  const root = { path: "/repo", dev: "1", ino: "2" }
  let checked = 0
  await assert.rejects(
    compileBotPlatformPlan(
      {
        platform: "linux",
        arch: "x64",
        cwd: root,
        readRoots: [],
        writeRoots: [root],
        deniedRoots: [],
        network: true,
        capability: {
          filesystem: "codex-linux-bwrap-split-v1",
          lifetime: "verified-linux-cgroup-v2",
          readDeny: true,
          controlChannelDeny: true,
          kernelProbe: "source-only"
        }
      },
      {
        platform: "linux",
        arch: "x64",
        assertPinned: async () => {
          checked++
        },
        inside: () => false,
        toFileURL: (value) => `file://${value}`
      }
    ),
    /尚未通过/
  )
  assert.equal(checked, 0)
})
test("probe output is nonce bound and must observe actual denied operations", () => {
  const result = {
    kind: "cmb-native-isolation-probe-v1",
    nonce,
    readDenied: true,
    writeDenied: true,
    controlDenied: true
  }
  assert.equal(readNativeIsolationProbe(JSON.stringify(result), nonce).nonce, nonce)
  assert.throws(() =>
    readNativeIsolationProbe(JSON.stringify({ ...result, controlDenied: false }), nonce)
  )
  assert.throws(() =>
    readNativeIsolationProbe(JSON.stringify(result), "d74be46a-9a90-4b51-b725-b3d9856e96a1")
  )
})

test("worker or configuration metadata cannot inject a verified completion diagnostic", () => {
  const result = botShellResultSchema.parse({ output: "done", exitCode: 0, truncated: false })
  assert.equal(botShellResultSandboxName(result), undefined)
  const frame = {
    type: "candidate",
    nonce,
    sequence: 1,
    outcome: { type: "result", value: result }
  }
  assert.equal(ownedShellFrameSchema.parse(frame).type, "candidate")
  assert.throws(() =>
    ownedShellFrameSchema.parse({
      ...frame,
      outcome: { ...frame.outcome, value: { ...result, sandbox: "linux-codex-cgroup-v2" } }
    })
  )
})

test("Bot preflight labels cannot advertise legacy Windows mode as native capability", async () => {
  const { botShellSandboxName } = await import("./shell-contract")
  assert.equal(
    botShellSandboxName({ windowsSandbox: "none", resourceDirectory: "resources" }),
    process.platform === "darwin" ? "macos-seatbelt" : "pending-verification"
  )
  assert.equal(botShellSandboxName(undefined), "unconfigured")
})

test.each(["executable", "cwd", "receiptDirectory", "args"] as const)(
  "native %s UTF-8 bound rejects oversize Unicode before the native owner can start",
  (field) => {
    const input = {
      executable: "/absolute/node.exe",
      cwd: "/absolute/project",
      receiptDirectory: "/private/operation-1",
      jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
      args: ["--max-old-space-size=128", "/absolute/owner.js"],
      limits: { pids: 512, memoryBytes: 2 * 1024 * 1024 * 1024 },
      bootId: nonce,
      sessionId: 1,
      timeoutMs: 45_000,
      proof: { format: 2, scope: "verified-windows-atomic-job-v2" }
    }
    // The existing C# parser bounds each UTF-8 string to 4096 bytes. This tests
    // the real Node encoder's admission contract, not Windows kernel execution.
    const boundary = "/" + "研".repeat(1365)
    const oversized = "/" + "研".repeat(1366)
    assert.equal(Buffer.byteLength(boundary), 4096)
    assert.ok(oversized.length < 4096)
    assert.ok(Buffer.byteLength(oversized) > 4096)
    const request = (value: string) =>
      field === "args" ? { ...input, args: [value] } : { ...input, [field]: value }
    assert.doesNotThrow(() => encodeWindowsBotResourceRequest(request(boundary)))
    assert.throws(
      () => encodeWindowsBotResourceRequest(request(oversized)),
      field === "args" ? /arguments/ : /paths/
    )
  }
)
