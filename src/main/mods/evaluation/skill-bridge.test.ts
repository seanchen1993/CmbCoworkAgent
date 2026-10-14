import { existsSync, unlinkSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import type { SkillOptimizationCandidate } from "../../agent/optimizer/skill-optimizer"
import type { EvaluationView } from "../../../shared/mods/evaluation-api"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { ModControlStore } from "../control-store"
import { flowDigest } from "../flows/store"
import { SkillEvaluationBridge } from "./skill-bridge"
import { SkillSnapshotFiles } from "./skill-files"
import { readPlainSkill, validateSkillText } from "./skill-snapshots"
import { EvaluationRunner } from "./runner"
import { EvaluationStore } from "./store"

const content = (body: string) =>
  `---\nname: sample\ndescription: Plain test instruction\n---\n${body}\n`
function setup() {
  const home = mkdtempSync(join(tmpdir(), "cmb-skill-evaluation-")),
    root = join(home, "custom")
  mkdirSync(root)
  mkdirSync(join(root, "sample"))
  writeFileSync(join(root, "sample/SKILL.md"), content("old"))
  const db = new ModControlStore(join(home, "control.db"))
  const definition = parseFlowDefinition({
    schemaVersion: 2,
    id: "fixture",
    name: "Fixture",
    goal: "check",
    execution: { kind: "host", profile: "workspace-files-v1" },
    timeoutMs: 10000,
    maxExecutions: 3,
    steps: [
      { id: "agent", name: "Agent", enabled: true, kind: "agent", prompt: "Follow the task" },
      { id: "test", name: "Test", enabled: true, kind: "check", check: "unit-test" }
    ]
  })
  const fixture: SavedFlow = {
    definition,
    revision: 1,
    digest: flowDigest(definition),
    updatedAt: 1
  }
  const candidate: SkillOptimizationCandidate = {
    candidateId: "candidate",
    action: "patch",
    skillId: "sample",
    name: "Sample",
    description: "sample",
    proposedContent: content("new"),
    rationale: "trace",
    sourceTraceIds: ["trace-source"],
    generatedAt: "now",
    status: "pending"
  }
  let evaluation: EvaluationView | undefined
  let pair: { baseline: SavedFlow; candidate: SavedFlow } | undefined
  const runner = {
    list: vi.fn(() => (evaluation ? [structuredClone(evaluation)] : [])),
    startSnapshots: vi.fn(async (_input: unknown, _scope: unknown, snapshots: typeof pair) => {
      pair = structuredClone(snapshots)
      const side = (variant: "baseline" | "candidate") => ({
        name: variant,
        digest: pair![variant].digest,
        cases: [
          {
            caseId: "task",
            runId: randomUUID(),
            result: "passed" as const,
            evidenceIds: ["real-check-fixture"],
            durationMs: 1,
            modelCalls: 1,
            humanTakeovers: 0,
            inputTokens: null,
            outputTokens: null
          }
        ]
      })
      evaluation = {
        id: randomUUID(),
        workspace: "workspace",
        threadId: "thread",
        createdAt: 1,
        state: "complete",
        provider: "controlled",
        tasks: [{ id: "task", goal: "fixed" }],
        budget: { timeoutMs: 10000, maxExecutions: 6 },
        baseline: side("baseline"),
        candidate: side("candidate"),
        comparison: { comparable: true, canAutoApply: false } as EvaluationView["comparison"],
        reasons: []
      }
      return evaluation
    }),
    isSettled: vi.fn(() => true),
    wait: vi.fn(async () => {}),
    cancel: vi.fn(async () => {})
  }
  const files = new SkillSnapshotFiles(root, join(home, "backups"))
  const changed = vi.fn()
  const deps = {
    settings: db,
    candidates: () => [candidate],
    files,
    flows: { get: () => fixture },
    runner: runner as unknown as EvaluationRunner,
    changed
  }
  const bridge = new SkillEvaluationBridge(deps)
  const controller = new AbortController()
  const scope = {
    workspace: "workspace",
    threadId: "thread",
    signal: controller.signal,
    assertCurrent: vi.fn()
  }
  const prepare = () =>
    bridge.prepare(
      {
        threadId: "thread",
        expectedWorkspace: "workspace",
        candidateId: "candidate",
        fixture: { id: "fixture", revision: 1, digest: fixture.digest },
        agentStepId: "agent"
      },
      scope
    )
  const start = async () => {
    const row = prepare()
    return bridge.start(
      {
        threadId: "thread",
        expectedWorkspace: "workspace",
        id: row.id,
        expectedDigest: row.digest,
        tasks: [{ id: "task", goal: "fixed" }],
        budget: { timeoutMs: 10000, maxExecutions: 6 }
      },
      scope
    )
  }
  return {
    home,
    root,
    db,
    deps,
    bridge,
    scope,
    controller,
    candidate,
    fixture,
    files,
    runner,
    changed,
    prepare,
    start,
    evaluation: () => evaluation!,
    pair: () => pair!,
    close: () => {
      db.close()
      expect(dirname(resolve(home))).toBe(resolve(tmpdir()))
      rmSync(home, { recursive: true, force: true })
    }
  }
}
describe("Skill experiment snapshots and adoption", () => {
  it("freezes exact source, candidate and provenance; never edits original optimizer candidate", async () => {
    const f = setup()
    try {
      const row = await f.start()
      f.candidate.proposedContent = content("later mutation")
      f.candidate.sourceTraceIds.push("later")
      const reopened = new SkillEvaluationBridge(f.deps).list(f.scope).records[0]
      expect(reopened.candidateText).toBe(content("new"))
      expect(reopened.sourceTraceIds).toEqual(["trace-source"])
      expect(f.pair().candidate.definition.steps[0]).toMatchObject({
        prompt: expect.stringContaining(content("new"))
      })
      expect(f.pair().baseline.definition.steps[0]).toMatchObject({
        prompt: expect.stringContaining(content("old"))
      })
      expect(f.files.read("sample")).toBe(content("old"))
      expect(row.evaluation?.provider).toBe("controlled")
      expect(f.candidate.status).toBe("pending")
    } finally {
      f.close()
    }
  })
  it("rejects resources, missing metadata, local links and overflow without execution", () => {
    const f = setup()
    try {
      writeFileSync(join(f.root, "sample/script.js"), "never execute")
      expect(f.prepare).toThrow(/UNSUPPORTED/)
      expect(() => validateSkillText("raw instructions")).toThrow(/UNSUPPORTED/)
      expect(() => validateSkillText(content("[file](scripts/run.py)"))).toThrow(/UNSUPPORTED/)
      expect(() => validateSkillText(content("x".repeat(7000)))).toThrow(/INVALID/)
      expect(f.runner.startSnapshots).not.toHaveBeenCalled()
    } finally {
      f.close()
    }
  })
  it("scope and revision CAS reject stale/duplicate experiment requests", async () => {
    const f = setup()
    try {
      const row = f.prepare(),
        input = {
          threadId: "thread",
          expectedWorkspace: "workspace",
          id: row.id,
          expectedDigest: row.digest,
          tasks: [{ id: "task", goal: "fixed" }],
          budget: { timeoutMs: 10000, maxExecutions: 6 }
        }
      await f.bridge.start(input, f.scope)
      await expect(f.bridge.start(input, f.scope)).rejects.toThrow(/STALE/)
      expect(f.bridge.list({ ...f.scope, threadId: "other" }).records).toEqual([])
      expect(f.runner.startSnapshots).toHaveBeenCalledTimes(1)
    } finally {
      f.close()
    }
  })
  it("cannot adopt unknown or incomparable evidence; immutable digest changes are rejected", async () => {
    const f = setup()
    try {
      const row = await f.start()
      f.evaluation().comparison.comparable = false
      await expect(
        f.bridge.change(
          {
            threadId: "thread",
            expectedWorkspace: "workspace",
            id: row.id,
            expectedDigest: row.digest,
            action: "adopt"
          },
          f.scope
        )
      ).rejects.toThrow(/INVALID/)
      const key = "mods-skill-evaluation-bridge-v1",
        raw = f.db.getSetting(key),
        rows = JSON.parse(raw)
      rows[0].candidate = content("tampered")
      expect(f.db.compareAndSetSetting(key, raw, JSON.stringify(rows))).toBe(true)
      expect(() => f.bridge.list(f.scope)).toThrow(/INVALID/)
    } finally {
      f.close()
    }
  })
  it.runIf(process.platform === "win32")(
    "real locked file CAS adopts, reopens SQLite and rolls back exact bytes",
    async () => {
      const f = setup()
      try {
        const row = await f.start()
        const adopted = await f.bridge.change(
          {
            threadId: "thread",
            expectedWorkspace: "workspace",
            id: row.id,
            expectedDigest: row.digest,
            action: "adopt"
          },
          f.scope
        )
        expect(f.files.read("sample")).toBe(content("new"))
        expect(adopted.state).toBe("adopted")
        expect(readFileSync(join(adopted.recoveryDirectory!, "before.txt"), "utf8")).toBe(
          content("old")
        )
        const second = new ModControlStore(join(f.home, "control.db"))
        try {
          const reopened = new SkillEvaluationBridge({ ...f.deps, settings: second })
          const restored = await reopened.change(
            {
              threadId: "thread",
              expectedWorkspace: "workspace",
              id: adopted.id,
              expectedDigest: adopted.digest,
              action: "rollback"
            },
            f.scope
          )
          expect(restored.state).toBe("rolled-back")
          expect(f.files.read("sample")).toBe(content("old"))
        } finally {
          second.close()
        }
        expect(f.candidate.status).toBe("pending")
      } finally {
        f.close()
      }
    },
    20000
  )
  it.runIf(process.platform === "win32")(
    "never overwrites changed baseline and preserves original on interrupted publication",
    async () => {
      const f = setup()
      try {
        const row = await f.start()
        writeFileSync(join(f.root, "sample/SKILL.md"), content("external"))
        await expect(
          f.bridge.change(
            {
              threadId: "thread",
              expectedWorkspace: "workspace",
              id: row.id,
              expectedDigest: row.digest,
              action: "adopt"
            },
            f.scope
          )
        ).rejects.toThrow(/STALE/)
        expect(f.files.read("sample")).toBe(content("external"))
        writeFileSync(join(f.root, "sample/SKILL.md"), content("old"))
        let journaled = false
        f.scope.assertCurrent.mockImplementation(() => {
          if (journaled && !existsSync(join(f.root, "sample/SKILL.md"))) f.controller.abort()
        })
        const bridge = new SkillEvaluationBridge({
          ...f.deps,
          files: {
            read: f.files.read.bind(f.files),
            replace: (input) =>
              f.files.replace({
                ...input,
                beforeEffect: (directory) => {
                  input.beforeEffect(directory)
                  journaled = true
                }
              })
          }
        })
        await expect(
          bridge.change(
            {
              threadId: "thread",
              expectedWorkspace: "workspace",
              id: row.id,
              expectedDigest: row.digest,
              action: "adopt"
            },
            f.scope
          )
        ).rejects.toThrow()
        expect(journaled).toBe(true)
        expect(readPlainSkill(f.root, "sample")).toBe(null)
        const backupName = readdirSync(join(f.home, "backups"))[0]
        expect(readFileSync(join(f.home, "backups", backupName, "before.txt"), "utf8")).toBe(
          content("old")
        )
        const safeScope = { ...f.scope, signal: new AbortController().signal }
        expect(new SkillEvaluationBridge(f.deps).list(safeScope).records[0].state).toBe("unknown")
        expect(readdirSync(join(f.home, "backups")).length).toBe(1)
      } finally {
        f.close()
      }
    },
    20000
  )
})

it.runIf(process.platform === "win32")(
  "new pure-text Skill creation has an absent baseline and rollback removes only its exact file",
  async () => {
    const f = setup()
    try {
      unlinkSync(join(f.root, "sample/SKILL.md"))
      f.candidate.action = "create"
      const row = await f.start()
      expect(row.baselineText).toBe(null)
      const adopted = await f.bridge.change(
        {
          threadId: "thread",
          expectedWorkspace: "workspace",
          id: row.id,
          expectedDigest: row.digest,
          action: "adopt"
        },
        f.scope
      )
      expect(readPlainSkill(f.root, "sample")).toBe(content("new"))
      await f.bridge.change(
        {
          threadId: "thread",
          expectedWorkspace: "workspace",
          id: adopted.id,
          expectedDigest: adopted.digest,
          action: "rollback"
        },
        f.scope
      )
      expect(readPlainSkill(f.root, "sample")).toBe(null)
    } finally {
      f.close()
    }
  },
  20000
)

it("an unlinked start marker survives restart as unknown and cannot be replayed", async () => {
  const f = setup()
  try {
    f.runner.startSnapshots.mockRejectedValueOnce(Error("transport may have started"))
    const prepared = f.prepare()
    await expect(
      f.bridge.start(
        {
          threadId: "thread",
          expectedWorkspace: "workspace",
          id: prepared.id,
          expectedDigest: prepared.digest,
          tasks: [{ id: "task", goal: "fixed" }],
          budget: { timeoutMs: 10000, maxExecutions: 6 }
        },
        f.scope
      )
    ).rejects.toThrow()
    expect(new SkillEvaluationBridge(f.deps).list(f.scope).records[0].state).toBe("unknown")
  } finally {
    f.close()
  }
})

it("real runner pre-creation rejection remains retryable; creation uncertainty stays unknown", async () => {
  const f = setup()
  try {
    let stale = true
    const create = vi.fn(() => {
      throw Error("creation uncertain")
    })
    const runner = new EvaluationRunner({
      flows: {} as never,
      history: { get: () => (stale ? { ...f.fixture, revision: 2 } : f.fixture) } as never,
      evidence: {} as never,
      store: { create, list: () => [] } as never,
      provider: "controlled"
    })
    const bridge = new SkillEvaluationBridge({ ...f.deps, runner })
    const row = f.prepare()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: row.id,
      expectedDigest: row.digest,
      tasks: [{ id: "task", goal: "fixed" }],
      budget: { timeoutMs: 10000, maxExecutions: 6 }
    }
    await expect(bridge.start(input, f.scope)).rejects.toThrow("EVALUATION_STALE")
    expect(create).not.toHaveBeenCalled()
    const reopened = new SkillEvaluationBridge({ ...f.deps, runner })
    const retry = reopened.list(f.scope).records[0]
    expect(retry.state).toBe("prepared")
    stale = false
    await expect(
      reopened.start({ ...input, expectedDigest: retry.digest }, f.scope)
    ).rejects.toThrow("creation uncertain")
    expect(create).toHaveBeenCalledOnce()
    expect(reopened.list(f.scope).records[0].state).toBe("unknown")
    await expect(reopened.start(input, f.scope)).rejects.toThrow("STALE")
  } finally {
    f.close()
  }
})

it("global capacity can be reclaimed from another chat after restart with exact digest", async () => {
  const f = setup()
  try {
    for (let index = 0; index < 16; index++) f.prepare()
    expect(f.prepare).toThrow("LIMIT")
    const other = { ...f.scope, threadId: "other", workspace: "other-project" }
    const bridge = new SkillEvaluationBridge(f.deps)
    const listed = bridge.list(other)
    expect(listed.records).toEqual([])
    expect(listed.capacity.entries).toHaveLength(16)
    const target = listed.capacity.entries[0]
    const request = {
      threadId: other.threadId,
      expectedWorkspace: other.workspace,
      id: target.id,
      expectedDigest: target.digest,
      action: "discard" as const
    }
    await expect(
      bridge.change({ ...request, expectedDigest: "a".repeat(64) }, other)
    ).rejects.toThrow("STALE")
    expect((await bridge.change(request, other)).state).toBe("discarded")
    await expect(bridge.change(request, other)).rejects.toThrow("STALE")
    expect(f.prepare().state).toBe("prepared")
    expect(new SkillEvaluationBridge(f.deps).list(other).capacity.entries).toHaveLength(16)
  } finally {
    f.close()
  }
})

it("discard protects unknown starts, active runs and every adoption or rollback reference", async () => {
  const f = setup()
  try {
    const started = await f.start()
    const request = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: started.id,
      expectedDigest: started.digest,
      action: "discard" as const
    }
    f.runner.isSettled.mockReturnValue(false)
    await expect(f.bridge.change(request, f.scope)).rejects.toThrow("BUSY")
    const key = "mods-skill-evaluation-bridge-v1"
    for (const state of ["unknown", "adopting", "adopted", "rolling-back", "rolled-back"]) {
      const raw = f.db.getSetting(key),
        rows = JSON.parse(raw)
      rows[0].state = state
      expect(f.db.compareAndSetSetting(key, raw, JSON.stringify(rows))).toBe(true)
      const target = f.bridge.list(f.scope).capacity.entries[0]
      expect(target.canDiscard).toBe(false)
      await expect(
        f.bridge.change({ ...request, expectedDigest: target.digest }, f.scope)
      ).rejects.toThrow("BUSY")
    }
    const raw = f.db.getSetting(key),
      rows = JSON.parse(raw)
    rows[0].state = "evaluating"
    rows[0].recoveryDirectory = "recovery-material"
    expect(f.db.compareAndSetSetting(key, raw, JSON.stringify(rows))).toBe(true)
    f.runner.isSettled.mockReturnValue(true)
    expect(f.bridge.list(f.scope).capacity.entries[0].canDiscard).toBe(false)
  } finally {
    f.close()
  }
})

it("settled unused evaluation can be discarded while unreadable history stays protected", async () => {
  const f = setup()
  try {
    const row = await f.start()
    f.runner.isSettled.mockImplementationOnce(() => {
      throw Error("history unreadable")
    })
    expect(f.bridge.list(f.scope).capacity.entries[0].canDiscard).toBe(false)
    const request = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: row.id,
      expectedDigest: row.digest,
      action: "discard" as const
    }
    expect((await f.bridge.change(request, f.scope)).state).toBe("discarded")
    expect(f.bridge.list(f.scope).records).toEqual([])
    expect(f.files.read("sample")).toBe(content("old"))
    expect(f.runner.cancel).not.toHaveBeenCalled()
    expect(f.evaluation().id).toBe(row.evaluation!.id)
  } finally {
    f.close()
  }
})

it("real Skill discard releases its settled report and protects unlinked unknown evidence", async () => {
  const f = setup()
  try {
    const startSaved = vi.fn(async () => {
      throw Error("unexpected Flow launch")
    })
    const runner = new EvaluationRunner({
      flows: { startSaved } as never,
      history: { get: () => f.fixture } as never,
      evidence: {} as never,
      store: new EvaluationStore(f.db),
      provider: "controlled"
    })
    const bridge = new SkillEvaluationBridge({ ...f.deps, runner })
    const row = f.prepare()
    const pending = bridge.start(
      {
        threadId: "thread",
        expectedWorkspace: "workspace",
        id: row.id,
        expectedDigest: row.digest,
        tasks: [{ id: "task", goal: "fixed" }],
        budget: { timeoutMs: 10000, maxExecutions: 6 }
      },
      f.scope
    )
    f.controller.abort()
    await expect(pending).rejects.toThrow()
    const scope = { ...f.scope, signal: new AbortController().signal }
    const linked = bridge.list(scope).records[0]
    expect(linked.evaluation?.state).toBe("cancelled")
    expect(runner.list(scope)[0].discardDigest).toBeUndefined()
    const key = "mods-skill-evaluation-bridge-v1"
    const raw = f.db.getSetting(key),
      rows = JSON.parse(raw)
    delete rows[0].evaluationId
    f.db.compareAndSetSetting(key, raw, JSON.stringify(rows))
    expect(bridge.list(scope).records[0].state).toBe("unknown")
    expect(runner.list(scope)[0].discardDigest).toBeUndefined()
    f.db.compareAndSetSetting(key, JSON.stringify(rows), raw)
    await bridge.change(
      {
        threadId: "thread",
        expectedWorkspace: "workspace",
        id: linked.id,
        expectedDigest: linked.digest,
        action: "discard"
      },
      scope
    )
    expect(bridge.list(scope).records).toEqual([])
    expect(runner.list(scope)).toEqual([])
    expect(startSaved).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

it("explicit recovery-loss acknowledgment reclaims completed histories without changing Skill or backups", async () => {
  const f = setup()
  try {
    let current = content("old")
    const backups: string[] = []
    vi.spyOn(SkillSnapshotFiles.prototype, "read").mockImplementation(() => current)
    vi.spyOn(SkillSnapshotFiles.prototype, "replace").mockImplementation(async (input) => {
      expect(input.expected).toBe(current)
      const directory = join(f.home, `retained-backup-${backups.length}`)
      mkdirSync(directory)
      writeFileSync(join(directory, "original.txt"), current)
      input.beforeEffect(directory)
      current = input.next!
      backups.push(directory)
      return directory
    })
    for (let index = 0; index < 16; index++) {
      f.candidate.proposedContent = content(`new-${index}`)
      const row = await f.start()
      let done = await f.bridge.change(
        {
          threadId: "thread",
          expectedWorkspace: "workspace",
          id: row.id,
          expectedDigest: row.digest,
          action: "adopt"
        },
        f.scope
      )
      if (index % 2)
        done = await f.bridge.change(
          {
            threadId: "thread",
            expectedWorkspace: "workspace",
            id: done.id,
            expectedDigest: done.digest,
            action: "rollback"
          },
          f.scope
        )
    }
    expect(f.prepare).toThrow(/LIMIT/)
    const reopened = new SkillEvaluationBridge(f.deps)
    const entries = reopened.list(f.scope).capacity.entries
    expect(entries.every((row) => row.canForgetHistory && !row.canDiscard)).toBe(true)
    const target = entries[0]
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: target.id,
      expectedDigest: target.digest,
      action: "forget-history" as const
    }
    await expect(reopened.change(input, f.scope)).rejects.toThrow(/INVALID/)
    await expect(reopened.change({ ...input, action: "discard" }, f.scope)).rejects.toThrow(/BUSY/)
    f.runner.isSettled.mockReturnValue(false)
    await expect(
      reopened.change({ ...input, acknowledgeRecoveryLoss: true }, f.scope)
    ).rejects.toThrow(/BUSY/)
    f.runner.isSettled.mockReturnValue(true)
    const key = "mods-skill-evaluation-bridge-v1"
    const saved = f.db.getSetting(key)
    const uncertain = JSON.parse(saved)
    uncertain[15].state = "unknown"
    const blocked = JSON.stringify(uncertain)
    expect(f.db.compareAndSetSetting(key, saved, blocked)).toBe(true)
    await expect(
      reopened.change({ ...input, acknowledgeRecoveryLoss: true }, f.scope)
    ).rejects.toThrow(/BUSY/)
    expect(f.db.compareAndSetSetting(key, blocked, saved)).toBe(true)
    const before = current
    const receipt = await reopened.change({ ...input, acknowledgeRecoveryLoss: true }, f.scope)
    expect(receipt.state).toBe("discarded")
    expect(receipt.recoveryDirectory).toBe(target.recoveryDirectory)
    expect(current).toBe(before)
    expect(backups.every((path) => existsSync(join(path, "original.txt")))).toBe(true)
    expect(reopened.list(f.scope).capacity.entries).toHaveLength(15)
    expect(f.prepare().state).toBe("prepared")
    await expect(
      reopened.change({ ...input, acknowledgeRecoveryLoss: true }, f.scope)
    ).rejects.toThrow(/STALE/)
  } finally {
    vi.restoreAllMocks()
    f.close()
  }
})
