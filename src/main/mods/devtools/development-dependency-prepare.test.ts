import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { AuthoringDocument } from "../../../shared/mods/authoring"
import type { DevelopmentReuseStatus } from "../../../shared/mods/development"
import type { ModDevelopmentService } from "./development-service"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import * as catalog from "./development-dependency-catalog"
import {
  DependencyPreparationError,
  prepareDevelopmentDependency
} from "./development-dependency-prepare"

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const source = catalog.readDevelopmentDependencySource({
    mainDirectory: resolve("main"),
    sourceId: "test-verification"
  })
  let document: AuthoringDocument | undefined
  let reuse: DevelopmentReuseStatus | undefined
  const status = () => ({ reuse })
  const read = vi.fn(() => {
    if (!document) throw Error("AUTHORING_VERSION_MISSING")
    return document
  })
  const save = vi.fn(
    (
      _thread: string,
      input: { id: string; name: string; expectedRevision: number; files: typeof source.files }
    ) => {
      if ((document?.revision ?? 0) !== input.expectedRevision)
        throw Error("AUTHORING_VERSION_CHANGED")
      const revision = input.expectedRevision + 1
      document = {
        id: input.id,
        name: input.name,
        workspace: "workspace",
        revision,
        currentRevision: revision,
        updatedAt: 1,
        versions: [],
        source: createAuthoringSourceBundle(input.files)
      }
      return document
    }
  )
  const check = vi.fn(async () => ({
    digest: source.digest,
    valid: true,
    runtimeVerified: false,
    diagnostics: [] as Array<{ code: string; message: string }>,
    capabilities: []
  }))
  const requestReuse = vi.fn(async () => {
    reuse = {
      phase: "needs-approval",
      planId: "a native plan",
      name: document!.name,
      draftId: document!.id,
      revision: document!.revision,
      sourceDigest: source.digest,
      compiledDigest: "b".repeat(64),
      targetProfileDigest: "c".repeat(64),
      capabilities: []
    }
    return status()
  })
  const input = {
    service: { read, save, check, status, requestReuse } as unknown as ModDevelopmentService,
    mainDirectory: resolve("main"),
    sourceId: "test-verification",
    threadId: "creator",
    turnId: "turn",
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    claimCandidate: vi.fn()
  }
  const saveExisting = () =>
    save("creator", {
      id: "test-verification",
      name: "Preserved display",
      expectedRevision: 0,
      files: source.files
    })
  return {
    input,
    source,
    read,
    save,
    check,
    requestReuse,
    saveExisting,
    get document() {
      return document!
    },
    setReuse(plan: DevelopmentReuseStatus | undefined) {
      reuse = plan
    }
  }
}

it("pins exact source once, defaults identity and returns the same pending plan without replay", async () => {
  const f = fixture()
  const result = await prepareDevelopmentDependency(f.input)
  expect(result).toMatchObject({
    draft: {
      id: "test-verification",
      name: "test-verification",
      revision: 1,
      sourceDigest: f.source.digest
    },
    check: { digest: f.source.digest, valid: true, runtimeVerified: false },
    phase: "needs-approval",
    installed: false,
    grantsAuthority: false,
    executed: false,
    trialRequested: false
  })
  expect(f.document.source).toEqual(f.source)
  const again = await prepareDevelopmentDependency(f.input)
  expect(again.reuse).toEqual(result.reuse)
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.check).toHaveBeenCalledTimes(2)
  expect(f.requestReuse).toHaveBeenCalledOnce()
  expect(result.nextStep).toContain("End this turn now")
})

it("allows explicit draft identity/display without rewriting plugin identity or source bytes", async () => {
  const f = fixture()
  const result = await prepareDevelopmentDependency({
    ...f.input,
    id: "custom-draft",
    name: "Custom display",
    expectedDigest: f.source.digest,
    revision: 0
  })
  expect(result.draft).toMatchObject({ id: "custom-draft", name: "Custom display", revision: 1 })
  expect(f.document.source).toEqual(f.source)
  expect(
    JSON.parse(f.document.source.files.find((file) => file.path === "plugin.json")!.text).name
  ).toBe("test-verification")
})

it("preserves different existing source and returns its true version instead of overwriting", async () => {
  const f = fixture()
  const old = f.saveExisting()
  old.source = createAuthoringSourceBundle(
    old.source.files.map((file) =>
      file.path === "README.md" ? { ...file, text: "User-authored source" } : file
    )
  )
  f.save.mockClear()
  await expect(prepareDevelopmentDependency(f.input)).rejects.toMatchObject({
    message: "DEVELOPMENT_DEPENDENCY_DRAFT_CONFLICT",
    currentDraft: { id: old.id, revision: 1, sourceDigest: old.source.digest }
  })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.input.claimCandidate).not.toHaveBeenCalled()
  expect(f.check).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it.each(["unknown", "preparing", "applying"] as const)(
  "refuses %s reuse before any save or Worker check",
  async (phase) => {
    const f = fixture()
    const old = f.saveExisting()
    f.save.mockClear()
    f.setReuse({
      phase,
      draftId: old.id,
      revision: 1,
      name: old.name,
      sourceDigest: old.source.digest,
      capabilities: []
    })
    await expect(prepareDevelopmentDependency(f.input)).rejects.toBeInstanceOf(
      DependencyPreparationError
    )
    expect(f.save).not.toHaveBeenCalled()
    expect(f.check).not.toHaveBeenCalled()
    expect(f.requestReuse).not.toHaveBeenCalled()
  }
)

it("does not replace another pending native confirmation or stale expected revision", async () => {
  const f = fixture()
  const old = f.saveExisting()
  f.save.mockClear()
  await expect(prepareDevelopmentDependency({ ...f.input, revision: 0 })).rejects.toMatchObject({
    message: "AUTHORING_VERSION_CHANGED",
    currentDraft: { revision: 1, sourceDigest: old.source.digest }
  })
  f.setReuse({
    phase: "needs-approval",
    draftId: "other",
    revision: 2,
    name: "Other",
    sourceDigest: "d".repeat(64),
    capabilities: []
  })
  await expect(prepareDevelopmentDependency(f.input)).rejects.toMatchObject({
    message: "DEVELOPMENT_DEPENDENCY_REVIEW_PENDING",
    reuse: { draftId: "other" }
  })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.check).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("keeps generic or explicitly unconfirmed failed native outcomes blocked", async () => {
  const f = fixture()
  for (const error of ["CREATOR_REUSE_FAILED", "CREATOR_REUSE_INSTALL_UNCONFIRMED"]) {
    f.setReuse({
      phase: "failed",
      error,
      name: "Previous",
      draftId: "previous",
      revision: 1,
      sourceDigest: "f".repeat(64),
      capabilities: []
    })
    await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow(
      "DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED"
    )
  }
  expect(f.save).not.toHaveBeenCalled()
  expect(f.check).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it.each(["漢字😀", '\\"\n\t\u0000'])(
  "bounds long public native errors while classifying the complete original %j text",
  async (prefix) => {
    const f = fixture()
    const error = prefix.repeat(8000) + "UNCONFIRMED"
    const plan = {
      phase: "failed" as const,
      error,
      name: "Previous",
      draftId: "previous",
      revision: 1,
      sourceDigest: "f".repeat(64),
      capabilities: []
    }
    f.setReuse(plan)
    const rejected = await prepareDevelopmentDependency(f.input).catch((failure) => failure)
    expect(rejected).toBeInstanceOf(DependencyPreparationError)
    expect(rejected.message).toBe("DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED")
    expect(rejected.reuse).toMatchObject({ phase: "failed", errorTruncated: true })
    expect(Buffer.byteLength(JSON.stringify(rejected.reuse.error))).toBeLessThanOrEqual(1024)
    expect(rejected.reuse.error.length).toBeLessThanOrEqual(512)
    expect(rejected.reuse.error).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(rejected.reuse.error).not.toContain("UNCONFIRMED")
    expect(plan.error).toBe(error)
    expect(f.save).not.toHaveBeenCalled()
    expect(f.check).not.toHaveBeenCalled()
    expect(f.requestReuse).not.toHaveBeenCalled()
  }
)

it("rejects foreign source selections and explicit digest mismatch before draft writes", async () => {
  const f = fixture()
  for (const sourceId of ["missing", "../test-verification", "test-verification/mods/main.ts"])
    await expect(prepareDevelopmentDependency({ ...f.input, sourceId })).rejects.toThrow(
      "DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE"
    )
  await expect(
    prepareDevelopmentDependency({ ...f.input, expectedDigest: "0".repeat(64) })
  ).rejects.toThrow("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
  expect(f.save).not.toHaveBeenCalled()
  expect(f.check).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("keeps an invalid exact-source check visible without preparing reuse", async () => {
  const f = fixture()
  f.check.mockResolvedValueOnce({
    digest: f.source.digest,
    valid: false,
    runtimeVerified: false,
    diagnostics: [{ code: "MODS_SDK_UNVERIFIED", message: "Unsupported source" }],
    capabilities: []
  })
  const result = await prepareDevelopmentDependency(f.input)
  expect(result).toMatchObject({
    phase: "check-failed",
    check: { valid: false, diagnosticCount: 1 },
    draft: { revision: 1 },
    executed: false
  })
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("refuses checks bound to another source and source revisions changed during checking", async () => {
  const f = fixture()
  f.saveExisting()
  f.save.mockClear()
  f.check.mockResolvedValueOnce({
    digest: "e".repeat(64),
    valid: true,
    runtimeVerified: false,
    diagnostics: [],
    capabilities: []
  })
  await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow(
    "DEVELOPMENT_DEPENDENCY_CHECK_UNCONFIRMED"
  )
  f.check.mockImplementationOnce(async () => {
    f.document.revision++
    return {
      digest: f.source.digest,
      valid: true,
      runtimeVerified: false,
      diagnostics: [],
      capabilities: []
    }
  })
  await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow("AUTHORING_VERSION_CHANGED")
  expect(f.save).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("does not replace a plan that changes while the exact source check is pending", async () => {
  const f = fixture()
  f.check.mockImplementationOnce(async () => {
    f.setReuse({
      phase: "needs-approval",
      draftId: "concurrent",
      revision: 1,
      name: "Concurrent",
      sourceDigest: "f".repeat(64),
      capabilities: []
    })
    return {
      digest: f.source.digest,
      valid: true,
      runtimeVerified: false,
      diagnostics: [],
      capabilities: []
    }
  })
  await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow(
    "DEVELOPMENT_DEPENDENCY_REUSE_CHANGED"
  )
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("checks original scope and exact saved revision after asynchronous Worker completion", async () => {
  const f = fixture()
  f.saveExisting()
  f.save.mockClear()
  f.check.mockImplementationOnce(async () => {
    f.input.assertCurrent.mockImplementation(() => {
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
    })
    return {
      digest: f.source.digest,
      valid: true,
      runtimeVerified: false,
      diagnostics: [],
      capabilities: []
    }
  })
  await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  expect(f.save).not.toHaveBeenCalled()
  expect(f.requestReuse).not.toHaveBeenCalled()
})

it("does not replay preparation when a native request returns an unknown outcome", async () => {
  const f = fixture()
  f.requestReuse.mockImplementationOnce(async () => {
    f.setReuse({
      phase: "unknown",
      draftId: f.document.id,
      revision: f.document.revision,
      name: f.document.name,
      sourceDigest: f.source.digest,
      capabilities: []
    })
    return { reuse: f.input.service.status("creator").reuse }
  })
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(prepareDevelopmentDependency(f.input)).rejects.toThrow(
      "DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED"
    )
  expect(f.requestReuse).toHaveBeenCalledOnce()
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.check).toHaveBeenCalledOnce()
})

it("returns a bounded index when exact inert companion text exceeds the native hook envelope", async () => {
  const f = fixture()
  const text = '漢字\\"😀'.repeat(5000)
  const source = createAuthoringSourceBundle(
    f.source.files.map((file) =>
      file.path === "workflows/verify.workflow.js" ? { ...file, text } : file
    )
  )
  vi.spyOn(catalog, "readDevelopmentDependencySource").mockReturnValue(source)
  f.check.mockResolvedValueOnce({
    digest: source.digest,
    valid: false,
    runtimeVerified: false,
    diagnostics: Array.from({ length: 50 }, () => ({ code: "SOURCE_INVALID", message: text })),
    capabilities: []
  })
  const result = await prepareDevelopmentDependency(f.input)
  expect(Buffer.byteLength(JSON.stringify({ ok: true, result }))).toBeLessThanOrEqual(24000)
  expect(result).not.toHaveProperty("companionSources")
  expect(result).toMatchObject({
    companionSourcesOmitted: true,
    companionCount: 2,
    companionCatalog: {
      action: "catalog",
      assetPath: "test-verification",
      sourceDigest: source.digest
    }
  })
  expect(
    f.document.source.files.find((file) => file.path === "workflows/verify.workflow.js")!.text
  ).toBe(text)
})
