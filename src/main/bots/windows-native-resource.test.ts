import { test } from "vitest"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, mkdir, rm, writeFile, lstat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { nativeShellLifetimeRecord, nativeShellClosure } from "./native-shell-lifetime"
import {
  windowsBotOwnerCapabilities,
  windowsBotOwnerFrame,
  windowsBotJobScope,
  WindowsBotOwnerDecoder
} from "./windows-native-contract"
import { OwnedShellReceiptSlot, inspectOwnedShellReceiptEntries } from "./owned-shell-receipts"
import { readOwnedShellClosure } from "./owned-shell-closure"
import { inspectBotOwnedShellMaintenance } from "./owned-shell-maintenance-fence"
import { writePrivateJson } from "./backup-io"
import { encodeWindowsBotResourceControl } from "./windows-bot-resource-wire"
import { startWindowsNativeShellController } from "./windows-native-resource"
const protocol = "cmb-atomic-windows-job-v2",
  sha = "d".repeat(64)
function capabilities(nonce = randomUUID()) {
  return windowsBotOwnerCapabilities.parse({
    protocol,
    type: "capabilities",
    nonce,
    bootId: randomUUID(),
    sessionId: 1,
    pointerSize: 8,
    startupBytes: 104,
    processInformationBytes: 24,
    extendedLimitBytes: 144,
    accountingBytes: 48,
    limitsVerified: true,
    noBreakaway: true,
    killOnClose: true
  })
}
async function fixture(
  action: (f: { root: string; resources: string; slot: OwnedShellReceiptSlot }) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-windows-private-wire-")))
  try {
    const resources = join(root, "shell-resources")
    await mkdir(resources, { mode: 0o700 })
    const slot = await OwnedShellReceiptSlot.allocate(resources, {
      nonce: randomUUID(),
      hostId: "protocol-only",
      dataEpoch: "epoch",
      runId: "run",
      policySha256: "a".repeat(64),
      helperSha256: "b".repeat(64),
      workerSha256: "c".repeat(64),
      nativeProviderSha256: sha,
      containment: "verified-windows-atomic-job-v2"
    })
    await action({ root, resources, slot })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function record(slot: OwnedShellReceiptSlot) {
  const origin = slot.snapshot(),
    caps = capabilities()
  return nativeShellLifetimeRecord.parse({
    format: 1,
    origin,
    resource: windowsBotJobScope.parse({
      format: 2,
      kind: "verified-windows-atomic-job-v2",
      nonce: origin.nonce,
      jobName: `Local\\CMBDevClaw-Bot-${origin.nonce}`,
      providerSha256: sha,
      protocol,
      bootId: caps.bootId,
      sessionId: caps.sessionId,
      limits: { pids: 512, memoryBytes: 2147483648 }
    })
  })
}
test("new Windows metadata alone cannot close an authorized physical scope", () =>
  fixture(async ({ root, resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(slot.directory, "owner.json"), {
      ...slot.snapshot(),
      phase: "resource-closed"
    })
    assert.equal(
      (await inspectOwnedShellReceiptEntries(resources))[0].value.phase,
      "closure-unproven"
    )
    const pin = await lstat(root, { bigint: true })
    assert.equal(
      (
        await inspectBotOwnedShellMaintenance(root, {
          root: { dev: String(pin.dev), ino: String(pin.ino) },
          assertCurrent: async () => {}
        })
      ).state,
      "requires_review"
    )
    await assert.rejects(OwnedShellReceiptSlot.reopenClosed(resources, 0), /physical closure/)
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }))
test("v2 proof reader binds native producer, actual scope and original receipt; no kernel claim", () =>
  fixture(async ({ slot }) => {
    const value = record(slot),
      proof = nativeShellClosure.parse({
        format: 2,
        scope: value.resource.kind,
        record: value,
        kernelEmpty: true
      })
    await writePrivateJson(join(slot.directory, "native-resource.json"), value)
    await writePrivateJson(join(slot.directory, "closure.json"), proof)
    assert.equal(
      (await readOwnedShellClosure(slot.directory, slot.snapshot()))?.scope,
      "verified-windows-atomic-job-v2"
    )
    await writePrivateJson(join(slot.directory, "closure.json"), {
      ...proof,
      record: { ...value, resource: { ...value.resource, providerSha256: "e".repeat(64) } }
    })
    await assert.rejects(readOwnedShellClosure(slot.directory, slot.snapshot()), /differs/)
  }))
test("native source/hash mismatch cannot be authorized by a structurally valid new proof", () =>
  fixture(async ({ slot }) => {
    const value = record(slot)
    const altered = { ...value, resource: { ...value.resource, providerSha256: "e".repeat(64) } }
    await writePrivateJson(join(slot.directory, "native-resource.json"), altered)
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format: 2,
      scope: value.resource.kind,
      record: altered,
      kernelEmpty: true
    })
    await assert.rejects(readOwnedShellClosure(slot.directory, slot.snapshot()), /provider differs/)
  }))
test("physical closure cleanup requires the exact v2 proof and retains bad evidence", () =>
  fixture(async ({ resources, slot }) => {
    const value = record(slot)
    await writePrivateJson(join(slot.directory, "native-resource.json"), value)
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await slot.settle(true)
    assert.equal(
      (await inspectOwnedShellReceiptEntries(resources))[0].value.phase,
      "closure-unproven"
    )
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }))
test("actual framed Node I/O is bounded and strict before any native admission", () => {
  const nonce = randomUUID(),
    frames: unknown[] = []
  const decoder = new WindowsBotOwnerDecoder((value) =>
    frames.push(windowsBotOwnerFrame.parse(value))
  )
  const ready = {
    protocol,
    type: "ready",
    nonce,
    helperPid: 101,
    bootId: randomUUID(),
    sessionId: 1,
    pids: 512,
    memoryBytes: 2147483648
  }
  const bytes = Buffer.from(JSON.stringify(ready) + "\r\n")
  for (const byte of bytes) decoder.feed(Buffer.from([byte]))
  decoder.end()
  assert.equal(frames.length, 1)
  assert.throws(() => new WindowsBotOwnerDecoder(() => {}).feed(Buffer.alloc(4097, 65)), /bound/)
  assert.throws(() => windowsBotOwnerFrame.parse({ ...ready, verified: true }))
  assert.throws(() =>
    windowsBotOwnerCapabilities.parse({ ...capabilities(nonce), limitsVerified: false })
  )
  const control = encodeWindowsBotResourceControl({ operation: "member", sequence: 1, pid: 101 })
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => control.readUInt32BE(offset)),
    [12, 1, 1, 101]
  )
  assert.throws(() =>
    encodeWindowsBotResourceControl({ operation: "member", sequence: 0, pid: 101 })
  )
  assert.throws(() =>
    encodeWindowsBotResourceControl({ operation: "member", sequence: 65, pid: 101 })
  )
})
test.skipIf(process.platform === "win32")(
  "actual native-controller transport fixture tests ordering/EOF, never Windows kernel facts",
  () =>
    fixture(async ({ root, slot }) => {
      const value = record(slot),
        resource = value.resource
      assert.equal(resource.kind, "verified-windows-atomic-job-v2")
      if (resource.kind !== "verified-windows-atomic-job-v2") throw new Error("Wrong fixture kind")
      const executable = join(root, "protocol-only-native-owner")
      // This actual Node child intentionally substitutes only the byte transport.
      // No OS support/result is promoted, and it never writes physical proof.
      const source = `#!${process.execPath}\nconst fs=require('node:fs');let data=Buffer.alloc(0),started=false;process.stdin.on('data',part=>{data=Buffer.concat([data,part]);if(!started){if(data.length<4||data.length<data.readUInt32BE(0)+4)return;data=data.subarray(4+data.readUInt32BE(0));started=true;process.stdout.write(JSON.stringify(${JSON.stringify({ protocol, type: "ready", nonce: resource.nonce, helperPid: 101, bootId: resource.bootId, sessionId: resource.sessionId, pids: resource.limits.pids, memoryBytes: resource.limits.memoryBytes })})+'\\n')}while(data.length>=16){const operation=data.readUInt32BE(4),sequence=data.readUInt32BE(8),pid=data.readUInt32BE(12);data=data.subarray(16);if(operation===2){process.stdin.pause();process.exit(0)}process.stdout.write(JSON.stringify({protocol:${JSON.stringify(protocol)},type:'member',nonce:${JSON.stringify(resource.nonce)},sequence,pid,member:pid===101})+'\\n')}});process.stdin.on('end',()=>process.exit(0));`
      await writeFile(executable, source, { mode: 0o700, flag: "wx" })
      const failures: unknown[] = []
      const controller = startWindowsNativeShellController({
        provider: {
          artifact: { entry: executable, sha256: sha },
          capabilities: capabilities(),
          limits: resource.limits
        },
        record: value,
        directory: slot.directory,
        executable: process.execPath,
        helperEntry: join(root, "unused-helper.js"),
        cwd: root,
        environment: process.env,
        timeoutMs: 45000,
        failure: (error) => failures.push(error)
      })
      assert.equal(await controller.ready, 101)
      await controller.verifyMember(101)
      const closed = once(controller.child, "close")
      controller.stop()
      await closed
      assert.equal(failures.length, 0)
      await assert.rejects(controller.verifyMember(101), /unavailable/)
      assert.equal((await readFile(executable, "utf8")).includes("closure.json"), false)
    })
)
