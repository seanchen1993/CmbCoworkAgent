import { test } from "vitest"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, lstat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { OwnedShellReceiptSlot, inspectOwnedShellReceiptEntries } from "./owned-shell-receipts"
import { readOwnedShellClosure, ownedShellClosureSchema } from "./owned-shell-closure"
import { nativeShellLifetimeRecord, nativeShellClosure } from "./native-shell-lifetime"
import { writePrivateJson } from "./backup-io"
import { linuxBotResourceLimits, DEFAULT_LINUX_BOT_RESOURCE_LIMITS } from "./linux-bot-cgroup"
import { compileBotPlatformPreparation, PINNED_CODEX_REVISION } from "./bot-strict-platform"
import type { OwnedShellReceipt } from "./owned-shell-receipt-contract"
import {
  inspectBotOwnedShellMaintenance,
  assertBotOwnedShellMaintenance
} from "./owned-shell-maintenance-fence"

async function fixture(
  action: (f: { root: string; resources: string; slot: OwnedShellReceiptSlot }) => Promise<void>,
  containment: OwnedShellReceipt["containment"] = "verified-linux-cgroup-v2"
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-contract-")))
  try {
    const resources = join(root, "shell-resources")
    await mkdir(resources, { mode: 0o700 })
    const slot = await OwnedShellReceiptSlot.allocate(resources, {
      nonce: randomUUID(),
      hostId: "native-contract",
      dataEpoch: "epoch",
      runId: "run",
      policySha256: "a".repeat(64),
      helperSha256: "b".repeat(64),
      workerSha256: "c".repeat(64),
      containment
    })
    await action({ root, resources, slot })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function record(slot: OwnedShellReceiptSlot) {
  const origin = slot.snapshot(),
    root = "/sys/fs/cgroup/delegated"
  return nativeShellLifetimeRecord.parse({
    format: 1,
    origin,
    resource: {
      format: 1,
      kind: "verified-linux-cgroup-v2",
      nonce: origin.nonce,
      providerSha256: origin.helperSha256,
      bootId: randomUUID(),
      root: { path: root, dev: "1", ino: "2" },
      leaf: { path: join(root, `cmb-bot-${origin.nonce}`), dev: "1", ino: "3" },
      limits: DEFAULT_LINUX_BOT_RESOURCE_LIMITS,
      controllers: { pids: { dev: "1", ino: "4" }, memory: { dev: "1", ino: "5" } }
    }
  })
}
test("metadata-only Linux resource-closed never authorizes restore or slot deletion", async () =>
  fixture(async ({ resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(slot.directory, "owner.json"), {
      ...slot.snapshot(),
      phase: "resource-closed"
    })
    const entries = await inspectOwnedShellReceiptEntries(resources)
    assert.equal(entries[0].value.phase, "closure-unproven")
    await assert.rejects(OwnedShellReceiptSlot.reopenClosed(resources, 0), /physical closure/)
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }))
test("requesting known cleanup without kernel proof retains the authorized original receipt", async () =>
  fixture(async ({ resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await slot.settle(true)
    const [entry] = await inspectOwnedShellReceiptEntries(resources)
    assert.equal(entry.value.runAuthorized, true)
    assert.equal(entry.value.phase, "closure-unproven")
    assert.match(await readFile(join(slot.directory, "owner.json"), "utf8"), /closure-unproven/)
  }))
test("format2 reader binds exact native record, provider, operation and directory; protocol-only fixture", async () =>
  fixture(async ({ slot }) => {
    const value = record(slot)
    await writePrivateJson(join(slot.directory, "native-resource.json"), value)
    const proof = nativeShellClosure.parse({
      format: 2,
      scope: value.resource.kind,
      record: value,
      kernelEmpty: true
    })
    await writePrivateJson(join(slot.directory, "closure.json"), proof)
    assert.equal(
      (await readOwnedShellClosure(slot.directory, slot.snapshot()))?.scope,
      "verified-linux-cgroup-v2"
    )
    await writePrivateJson(join(slot.directory, "closure.json"), {
      ...proof,
      record: { ...value, origin: { ...value.origin, policySha256: "d".repeat(64) } }
    })
    await assert.rejects(readOwnedShellClosure(slot.directory, slot.snapshot()), /differs/)
  }))
test("Linux native reader rejects group proof and mismatched scope provenance", async () =>
  fixture(async ({ slot }) => {
    const value = record(slot)
    await writePrivateJson(join(slot.directory, "native-resource.json"), value)
    await writePrivateJson(join(slot.directory, "closure.json"), {
      format: 1,
      scope: "controlled-inherited-group"
    })
    await assert.rejects(readOwnedShellClosure(slot.directory, slot.snapshot()), /strong kernel/)
    assert.throws(() =>
      nativeShellLifetimeRecord.parse({
        ...value,
        origin: { ...value.origin, containment: "controlled-inherited-group" }
      })
    )
    if (value.resource.kind === "verified-linux-cgroup-v2") {
      const resource = value.resource
      assert.throws(() =>
        nativeShellLifetimeRecord.parse({
          ...value,
          resource: { ...resource, leaf: { ...resource.leaf, path: "/foreign/leaf" } }
        })
      )
    }
  }))
test("resource defaults are upper bounds, not preallocated memory; configurations are bounded", () => {
  assert.deepEqual(linuxBotResourceLimits.parse(DEFAULT_LINUX_BOT_RESOURCE_LIMITS), {
    pids: 512,
    memoryBytes: 2147483648
  })
  for (const pids of [0, 15, 4097, NaN, Infinity])
    assert.throws(() =>
      linuxBotResourceLimits.parse({ ...DEFAULT_LINUX_BOT_RESOURCE_LIMITS, pids })
    )
  for (const memoryBytes of [0, 256 * 1024 * 1024 - 1, 16 * 1024 * 1024 * 1024 + 1, NaN, Infinity])
    assert.throws(() =>
      linuxBotResourceLimits.parse({ ...DEFAULT_LINUX_BOT_RESOURCE_LIMITS, memoryBytes })
    )
})
test("private preparation does not promote source-only metadata into runtime admission", async () => {
  const pin = { path: "/repo", dev: "1", ino: "2" },
    sha = "a".repeat(64)
  const plan = await compileBotPlatformPreparation(
    {
      platform: "linux",
      arch: "x64",
      cwd: pin,
      readRoots: [pin],
      writeRoots: [pin],
      deniedRoots: [],
      network: false,
      capability: {
        filesystem: "codex-linux-bwrap-split-v1",
        lifetime: "verified-linux-cgroup-v2",
        readDeny: false,
        controlChannelDeny: false,
        kernelProbe: "source-only",
        helperSha256: sha,
        sourceRevision: PINNED_CODEX_REVISION,
        helperProtocol: "codex-cmb-owned-sandbox-v1",
        linuxHelperPath: "/fixed/helper",
        linuxHelperSha256: sha,
        bwrapSha256: sha
      }
    },
    {
      platform: "linux",
      arch: "x64",
      assertPinned: async () => {},
      inside: (root, path) => root === path,
      toFileURL: (path) => `file://${path}`
    }
  )
  assert.equal(JSON.parse(plan.policy).permissionProfile.network, "restricted")
  assert.equal("admitted" in plan, false)
})

function groupProof(slot: OwnedShellReceiptSlot) {
  const value = slot.snapshot()
  return ownedShellClosureSchema.parse({
    format: 1,
    scope: "controlled-inherited-group",
    nonce: value.nonce,
    hostId: value.hostId,
    dataEpoch: value.dataEpoch,
    policySha256: value.policySha256,
    runId: value.runId,
    helperSha256: value.helperSha256,
    workerSha256: value.workerSha256,
    directory: value.directory,
    helperPid: value.helperPid,
    workerPid: value.workerPid
  })
}
test("legacy authorized Windows Job flag cannot prove closure or authorize deletion", async () =>
  fixture(async ({ root, resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await writePrivateJson(join(slot.directory, "owner.json"), {
      ...slot.snapshot(),
      phase: "resource-closed"
    })
    const [entry] = await inspectOwnedShellReceiptEntries(resources)
    assert.equal(entry.value.phase, "closure-unproven")
    const hostRoot = await lstat(root, { bigint: true }),
      owner = {
        root: { dev: String(hostRoot.dev), ino: String(hostRoot.ino) },
        assertCurrent: async () => {}
      }
    const review = await inspectBotOwnedShellMaintenance(root, owner)
    assert.equal(review.state, "requires_review")
    assert.equal(review.reason, "physical-closure-unproven")
    await assert.rejects(assertBotOwnedShellMaintenance(root, owner), /尚未确认停止/)
    await assert.rejects(OwnedShellReceiptSlot.reopenClosed(resources, 0), /physical closure/)
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }, "verified-windows-job"))
test("authorized legacy Windows cannot accept caller's knownClosed flag", async () =>
  fixture(async ({ resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    await assert.rejects(slot.closed(), /physical cleanup authority/)
    await slot.settle(true)
    assert.equal(
      (await inspectOwnedShellReceiptEntries(resources))[0].value.phase,
      "closure-unproven"
    )
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }, "verified-windows-job"))
test("structural format2 Windows Job metadata is not an actual atomic Job proof", async () =>
  fixture(async ({ resources, slot }) => {
    await slot.ready(100, 101)
    await slot.authorizeRun()
    const origin = slot.snapshot(),
      value = nativeShellLifetimeRecord.parse({
        format: 1,
        origin,
        resource: {
          format: 1,
          kind: "verified-windows-job",
          nonce: origin.nonce,
          jobName: `Local\\CMBDevClaw-Bot-${origin.nonce}`,
          providerSha256: origin.helperSha256
        }
      })
    await writePrivateJson(join(slot.directory, "native-resource.json"), value)
    await writePrivateJson(
      join(slot.directory, "closure.json"),
      nativeShellClosure.parse({
        format: 2,
        scope: "verified-windows-job",
        record: value,
        kernelEmpty: true
      })
    )
    await writePrivateJson(join(slot.directory, "owner.json"), {
      ...origin,
      phase: "resource-closed"
    })
    assert.equal(await readOwnedShellClosure(slot.directory, origin), undefined)
    assert.equal(
      (await inspectOwnedShellReceiptEntries(resources))[0].value.phase,
      "closure-unproven"
    )
    await assert.rejects(OwnedShellReceiptSlot.reopenClosed(resources, 0), /physical closure/)
    assert.equal((await lstat(slot.directory)).isDirectory(), true)
  }, "verified-windows-job"))
test("never-authorized legacy Windows preparation with exact witness remains safely removable", async () =>
  fixture(async ({ resources, slot }) => {
    await slot.ready(100, 101)
    await writePrivateJson(join(slot.directory, "closure.json"), groupProof(slot))
    assert.equal(
      (await inspectOwnedShellReceiptEntries(resources))[0].value.phase,
      "resource-closed"
    )
    const reopened = await OwnedShellReceiptSlot.reopenClosed(resources, 0)
    await reopened.settle(true)
    assert.deepEqual(await inspectOwnedShellReceiptEntries(resources), [])
  }, "verified-windows-job"))
