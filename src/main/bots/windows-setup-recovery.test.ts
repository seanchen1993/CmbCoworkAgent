import { test } from "vitest"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, mkdir, rm, lstat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OwnedShellReceiptSlot } from "./owned-shell-receipts"
import { nativeShellLifetimeRecord } from "./native-shell-lifetime"
import { readNativeShellResourceClosure } from "./linux-native-resource"
import { writePrivateJson } from "./backup-io"
import { windowsProvisioningBinding } from "./windows-provisioning-contract"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { recoverCompletedWindowsSetup } from "./windows-setup-recovery"
async function fixture(
  action: (f: {
    root: string
    resources: string
    slot: OwnedShellReceiptSlot
    ledger: BotMaintenanceReceipts
    request: { nonce: string; scope: string }
    record: ReturnType<typeof nativeShellLifetimeRecord.parse>
  }) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-windows-provisioning-reader-"))),
    resources = join(root, "shell-resources"),
    nonce = randomUUID()
  await mkdir(resources, { mode: 0o700 })
  const slot = await OwnedShellReceiptSlot.allocate(resources, {
    nonce,
    hostId: "reader-only",
    dataEpoch: "epoch",
    runId: "setup",
    helperSha256: "a".repeat(64),
    workerSha256: "a".repeat(64),
    nativeProviderSha256: "b".repeat(64),
    policySha256: "c".repeat(64),
    containment: "verified-windows-atomic-job-v2"
  })
  const pin = await lstat(root, { bigint: true }),
    request = { nonce, scope: "e".repeat(64) },
    record = nativeShellLifetimeRecord.parse({
      format: 1,
      origin: slot.snapshot(),
      resource: {
        format: 2,
        kind: "verified-windows-atomic-job-v2",
        protocol: "cmb-atomic-windows-job-v2",
        nonce,
        bootId: randomUUID(),
        sessionId: 1,
        jobName: `Local\\CMBDevClaw-Bot-${nonce}`,
        providerSha256: "b".repeat(64),
        limits: { pids: 512, memoryBytes: 2147483648 },
        provisioning: {
          cliSha256: "d".repeat(64),
          codexHome: { path: root, dev: String(pin.dev), ino: String(pin.ino) }
        }
      }
    })
  const ledger = new BotMaintenanceReceipts(root)
  try {
    ledger.reserveOperation(
      "windows-setup",
      nonce,
      "setup",
      BotMaintenanceReceipts.requestHash(request),
      { reserved: true, padding: " ".repeat(7168) }
    )
    await writePrivateJson(join(slot.directory, "native-resource.json"), record)
    ledger.sealOperation("windows-setup", nonce, windowsProvisioningBinding(record))
    await action({ root, resources, slot, ledger, request, record })
  } finally {
    ledger.close()
    await rm(root, { recursive: true, force: true })
  }
}
test("Windows provisioning requires exact fixed CLI terminal in addition to Job-empty proof (reader fixture, no kernel admission)", () =>
  fixture(async ({ slot, record }) => {
    await slot.ready(101, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format: 2,
      scope: record.resource.kind,
      record,
      kernelEmpty: true
    })
    assert.equal(await readNativeShellResourceClosure(slot.directory, slot.snapshot()), undefined)
    const terminal = {
      format: 1,
      nonce: record.origin.nonce,
      recordSha256: windowsProvisioningBinding(record),
      cliSha256: "d".repeat(64),
      completed: true
    }
    await writePrivateJson(join(slot.directory, "native-setup-terminal.json"), {
      ...terminal,
      cliSha256: "f".repeat(64)
    })
    await assert.rejects(
      readNativeShellResourceClosure(slot.directory, slot.snapshot()),
      /terminal differs/
    )
    await writePrivateJson(join(slot.directory, "native-setup-terminal.json"), terminal)
    assert.equal(
      (await readNativeShellResourceClosure(slot.directory, slot.snapshot()))?.scope,
      "verified-windows-atomic-job-v2"
    )
  }))
test("sealed setup without proof is retained and cannot be replayed or completed by marker existence", () =>
  fixture(async ({ root, resources, slot, request, ledger }) => {
    await slot.ready(101, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(root, "windows-native-setup.json"), {
      format: 1,
      scope: request.scope,
      completedAt: Date.now()
    })
    assert.equal(
      await recoverCompletedWindowsSetup({
        directory: root,
        resourceRoot: resources,
        request,
        ledger,
        assertCurrent: async () => {}
      }),
      undefined
    )
    assert.equal(ledger.getOperation("windows-setup", request.nonce)?.state, "sealed")
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }))
test("lost setup ACK resumes durable exact result before cleanup and repeats after process reopen", () =>
  fixture(async ({ root, resources, slot, request, record, ledger }) => {
    await slot.ready(101, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(slot.directory, "native-setup-terminal.json"), {
      format: 1,
      nonce: request.nonce,
      recordSha256: windowsProvisioningBinding(record),
      cliSha256: "d".repeat(64),
      completed: true
    })
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format: 2,
      scope: record.resource.kind,
      record,
      kernelEmpty: true
    })
    const input = {
      directory: root,
      resourceRoot: resources,
      request,
      ledger,
      assertCurrent: async () => {}
    }
    const result = await recoverCompletedWindowsSetup(input)
    assert.equal(result?.success, true)
    assert.equal(ledger.getOperation("windows-setup", request.nonce)?.state, "completed")
    await assert.rejects(lstat(slot.directory), { code: "ENOENT" })
    assert.equal(
      JSON.parse(await readFile(join(root, "windows-native-setup.json"), "utf8")).scope,
      request.scope
    )
    ledger.close()
    const reopened = new BotMaintenanceReceipts(root)
    try {
      assert.deepEqual(await recoverCompletedWindowsSetup({ ...input, ledger: reopened }), result)
    } finally {
      reopened.close()
    }
  }))
test("setup nonce cannot be reused for a different environment and ownership failure preserves uncommitted proof", () =>
  fixture(async ({ root, resources, slot, request, record, ledger }) => {
    await assert.rejects(
      recoverCompletedWindowsSetup({
        directory: root,
        resourceRoot: resources,
        request: { ...request, scope: "f".repeat(64) },
        ledger,
        assertCurrent: async () => {}
      }),
      /其他环境/
    )
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format: 2,
      scope: record.resource.kind,
      record,
      kernelEmpty: true,
      neverLaunched: true
    })
    await assert.rejects(
      recoverCompletedWindowsSetup({
        directory: root,
        resourceRoot: resources,
        request,
        ledger,
        assertCurrent: async () => {
          throw new Error("lost owner")
        }
      }),
      /lost owner/
    )
    assert.equal(ledger.getOperation("windows-setup", request.nonce)?.state, "sealed")
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }))

test("setup marker resumes only the exact crash-pending identity; foreign pending bytes are retained", () =>
  fixture(async ({ root, request, record }) => {
    const { publishWindowsSetupMarker } = await import("./windows-setup-marker")
    const identity = {
        scope: request.scope,
        nonce: request.nonce,
        recordSha256: windowsProvisioningBinding(record)
      },
      pending = join(root, "windows-native-setup.json.pending")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(pending, JSON.stringify({ format: 1, ...identity, completedAt: Date.now() }), {
      mode: 0o600,
      flag: "wx"
    })
    await publishWindowsSetupMarker(root, identity, async () => {})
    assert.equal(
      JSON.parse(await readFile(join(root, "windows-native-setup.json"), "utf8")).nonce,
      request.nonce
    )
    await assert.rejects(lstat(pending), { code: "ENOENT" })
    const foreign = { format: 1, ...identity, nonce: randomUUID(), completedAt: Date.now() }
    await writeFile(pending, JSON.stringify(foreign), { mode: 0o600, flag: "wx" })
    await assert.rejects(
      publishWindowsSetupMarker(root, { ...identity, nonce: randomUUID() }, async () => {}),
      /不一致/
    )
    assert.deepEqual(JSON.parse(await readFile(pending, "utf8")), foreign)
  }))

test("unstarted fixed-package preflight failure is definitive and durable without borrowing a sealed operation", async () => {
  const { rejectUnstartedWindowsSetup } = await import("./windows-setup-recovery")
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-windows-setup-preflight-")))
  const request = { nonce: randomUUID(), scope: "a".repeat(64) }
  const ledger = new BotMaintenanceReceipts(root)
  const result = {
    nonce: request.nonce,
    success: false,
    definitive: true,
    status: {
      state: "unavailable" as const,
      scope: request.scope,
      message: "Fixed package probe failed before setup was launched"
    }
  }
  try {
    ledger.reserveOperation(
      "windows-setup",
      request.nonce,
      "setup",
      BotMaintenanceReceipts.requestHash(request),
      { reserved: true, padding: " ".repeat(7168) }
    )
    await assert.rejects(
      rejectUnstartedWindowsSetup({
        request,
        ledger,
        result,
        assertCurrent: async () => {
          throw new Error("lost owner")
        }
      }),
      /lost owner/
    )
    assert.equal(ledger.getOperation("windows-setup", request.nonce)?.state, "reserved")
    await assert.rejects(
      rejectUnstartedWindowsSetup({
        request: { ...request, scope: "b".repeat(64) },
        ledger,
        result,
        assertCurrent: async () => {}
      }),
      /其他环境/
    )
    assert.deepEqual(
      await rejectUnstartedWindowsSetup({ request, ledger, result, assertCurrent: async () => {} }),
      result
    )
    ledger.close()
    const reopened = new BotMaintenanceReceipts(root)
    try {
      assert.deepEqual(
        await recoverCompletedWindowsSetup({
          directory: root,
          resourceRoot: join(root, "absent-resources"),
          request,
          ledger: reopened,
          assertCurrent: async () => {}
        }),
        result
      )
      const sealedRequest = { ...request, nonce: randomUUID() }
      reopened.reserveOperation(
        "windows-setup",
        sealedRequest.nonce,
        "setup",
        BotMaintenanceReceipts.requestHash(sealedRequest),
        { reserved: true, padding: " ".repeat(7168) }
      )
      reopened.sealOperation("windows-setup", sealedRequest.nonce, "c".repeat(64))
      await assert.rejects(
        rejectUnstartedWindowsSetup({
          request: sealedRequest,
          ledger: reopened,
          result: { ...result, nonce: sealedRequest.nonce },
          assertCurrent: async () => {}
        }),
        /未启动/
      )
      assert.equal(reopened.getOperation("windows-setup", sealedRequest.nonce)?.state, "sealed")
    } finally {
      reopened.close()
    }
  } finally {
    ledger.close()
    await rm(root, { recursive: true, force: true })
  }
})
