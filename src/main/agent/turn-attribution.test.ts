import { beforeEach, describe, expect, it, vi } from "vitest"

const setAdoptionContext = vi.fn()
vi.mock("../services/adoption-tracker", () => ({
  setAdoptionContext: (...args: unknown[]) => setAdoptionContext(...args)
}))

const { SkillUsageDetector } = await import("./skill-evolution/usage-detector")
const { getThreadActiveSkills, setThreadActiveSkills } =
  await import("./skill-evolution/proposal-window")
const {
  TurnAttributionRecorder,
  observeExplicitSkillActivation,
  observeToolCallForAttribution,
  resolveSubagentAttributionSkills,
  syncSubagentSkillAttribution,
  syncTaskSubagentSkillAttribution,
  syncTurnSkillAttribution
} = await import("./turn-attribution")

const SKILL_DOC = "/ws/skills/demo/SKILL.md"
const SKILL_METADATA = [{ name: "demo-skill", path: SKILL_DOC }]

function createTracer(): {
  usedSkills: string[]
  skillSource: string[]
  evolvedSkills: string[]
  setUsedSkills(skills: string[]): void
  setSkillSource(skillSource: string[]): void
  setEvolvedSkills(skills: string[]): void
} {
  return {
    usedSkills: [],
    skillSource: [],
    evolvedSkills: [],
    setUsedSkills(skills) {
      this.usedSkills = skills
    },
    setSkillSource(skillSource) {
      this.skillSource = skillSource
    },
    setEvolvedSkills(skills) {
      this.evolvedSkills = skills
    }
  }
}

function aiMessage(id: string, toolCalls: unknown[]): Record<string, unknown> {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id, type: "ai", tool_calls: toolCalls }
  }
}

function humanMessage(id: string): Record<string, unknown> {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: { id, type: "human", content: "hi" }
  }
}

/** A detector that already knows the fixture skill. */
function loadedDetector(): InstanceType<typeof SkillUsageDetector> {
  const detector = new SkillUsageDetector()
  detector.onSkillsMetadata(SKILL_METADATA)
  return detector
}

let threadSeq = 0
function freshThreadId(): string {
  threadSeq += 1
  return `thread-${threadSeq}-${Math.random().toString(16).slice(2)}`
}

beforeEach(() => {
  setAdoptionContext.mockClear()
})

describe("attribution rules", () => {
  it("marks a skill used when its SKILL.md is read", () => {
    const detector = loadedDetector()
    const observed = observeToolCallForAttribution(detector, {
      name: "read_file",
      args: { path: SKILL_DOC }
    })
    expect(observed.skillHit).toBe(true)
    expect(detector.getUsedSkillNames().length).toBe(1)
  })

  it("reports no hit for a read that touches no skill", () => {
    const detector = loadedDetector()
    const observed = observeToolCallForAttribution(detector, {
      name: "read_file",
      args: { path: "/ws/src/index.ts" }
    })
    expect(observed.skillHit).toBe(false)
    expect(detector.getUsedSkillNames()).toEqual([])
  })

  it("collects and normalizes write paths for write_file and edit_file", () => {
    const detector = loadedDetector()
    expect(
      observeToolCallForAttribution(detector, {
        name: "write_file",
        args: { path: "src\\a\\b.ts" }
      }).writePath
    ).toBe("src/a/b.ts")
    expect(
      observeToolCallForAttribution(detector, {
        name: "edit_file",
        args: { file_path: "src/c.ts" }
      }).writePath
    ).toBe("src/c.ts")
  })

  it("ignores calls with no name, an unrelated name, or streaming-incomplete args", () => {
    const detector = loadedDetector()
    expect(observeToolCallForAttribution(detector, undefined).skillHit).toBe(false)
    expect(observeToolCallForAttribution(detector, { name: "execute" }).writePath).toBeUndefined()
    // A tool-call chunk whose args have not finished streaming yet.
    expect(
      observeToolCallForAttribution(detector, { name: "write_file", args: {} }).writePath
    ).toBeUndefined()
  })

  it("marks an explicitly invoked skill used without a read_file", () => {
    const detector = new SkillUsageDetector()
    observeExplicitSkillActivation(detector, { name: "demo-skill", path: SKILL_DOC })
    expect(detector.getUsedSkillNames().length).toBe(1)
  })
})

describe("syncTurnSkillAttribution", () => {
  it("publishes the current run's skills to the tracer and the adoption context", () => {
    const threadId = freshThreadId()
    const tracer = createTracer()
    const detector = loadedDetector()
    detector.onReadFilePath(SKILL_DOC)

    syncTurnSkillAttribution({ threadId, tracer, detector })

    const used = detector.getUsedSkillNames()
    expect(used.length).toBe(1)
    expect(tracer.usedSkills).toEqual(used)
    expect(setAdoptionContext).toHaveBeenCalledWith(threadId, {
      usedSkills: used,
      skillSource: detector.getUsedSkillSourceRefs()
    })
  })

  it("falls back to the thread's sticky skills when this turn used none", () => {
    const threadId = freshThreadId()
    setThreadActiveSkills(threadId, ["sticky-skill@1"], ["plugin:p/sticky-skill@1"])

    syncTurnSkillAttribution({
      threadId,
      tracer: createTracer(),
      detector: new SkillUsageDetector()
    })

    expect(setAdoptionContext).toHaveBeenCalledWith(threadId, {
      usedSkills: ["sticky-skill@1"],
      skillSource: ["plugin:p/sticky-skill@1"]
    })
  })

  it("supersedes the sticky set once a turn uses a skill of its own", () => {
    const threadId = freshThreadId()
    setThreadActiveSkills(threadId, ["sticky-skill@1"], [])
    const detector = loadedDetector()
    detector.onReadFilePath(SKILL_DOC)

    syncTurnSkillAttribution({ threadId, tracer: createTracer(), detector })

    const [, context] = setAdoptionContext.mock.calls.at(-1) as [string, { usedSkills: string[] }]
    expect(context.usedSkills).toEqual(detector.getUsedSkillNames())
    expect(context.usedSkills).not.toContain("sticky-skill@1")
  })
})

describe("TurnAttributionRecorder", () => {
  it("attributes a skill read off the messages stream", () => {
    const threadId = freshThreadId()
    const tracer = createTracer()
    const recorder = new TurnAttributionRecorder({
      threadId,
      tracer,
      userMessageId: "u1",
      detector: loadedDetector()
    })

    recorder.onStreamChunk("messages", [
      aiMessage("a1", [{ id: "c1", name: "read_file", args: { path: SKILL_DOC } }])
    ])

    expect(tracer.usedSkills.length).toBe(1)
    expect(setAdoptionContext).toHaveBeenCalled()
  })

  it("picks up skillsMetadata and tool calls from a values snapshot", () => {
    const threadId = freshThreadId()
    const tracer = createTracer()
    const recorder = new TurnAttributionRecorder({ threadId, tracer, userMessageId: "u1" })

    recorder.onStreamChunk("values", {
      skillsMetadata: SKILL_METADATA,
      messages: [
        humanMessage("u1"),
        aiMessage("a1", [{ id: "c1", name: "read_file", args: { path: SKILL_DOC } }])
      ]
    })

    expect(tracer.usedSkills.length).toBe(1)
  })

  it("does not attribute a skill read during an earlier turn", () => {
    const threadId = freshThreadId()
    const tracer = createTracer()
    const recorder = new TurnAttributionRecorder({
      threadId,
      tracer,
      userMessageId: "u2",
      detector: loadedDetector()
    })

    recorder.onStreamChunk("values", {
      messages: [
        humanMessage("u1"),
        aiMessage("a1", [{ id: "c1", name: "read_file", args: { path: SKILL_DOC } }]),
        humanMessage("u2"),
        aiMessage("a2", [{ id: "c2", name: "write_file", args: { path: "src/new.ts" } }])
      ]
    })

    expect(tracer.usedSkills).toEqual([])
    expect(recorder.getFileWritePaths()).toEqual(["src/new.ts"])
  })

  it("recovers the complete args from values when the streamed chunk had none", () => {
    const threadId = freshThreadId()
    const recorder = new TurnAttributionRecorder({
      threadId,
      tracer: createTracer(),
      userMessageId: "u1"
    })

    // The first delta carries the id but the args are still streaming.
    recorder.onStreamChunk("messages", [
      aiMessage("a1", [{ id: "c1", name: "write_file", args: {} }])
    ])
    expect(recorder.getFileWritePaths()).toEqual([])

    recorder.onStreamChunk("values", {
      messages: [
        humanMessage("u1"),
        aiMessage("a1", [{ id: "c1", name: "write_file", args: { path: "src/late.ts" } }])
      ]
    })
    expect(recorder.getFileWritePaths()).toEqual(["src/late.ts"])
  })

  it("keeps one entry per file when a call is seen on both streams", () => {
    const threadId = freshThreadId()
    const recorder = new TurnAttributionRecorder({
      threadId,
      tracer: createTracer(),
      userMessageId: "u1"
    })
    const call = { id: "c1", name: "edit_file", args: { path: "src/dup.ts" } }

    recorder.onStreamChunk("messages", [aiMessage("a1", [call])])
    recorder.onStreamChunk("values", { messages: [humanMessage("u1"), aiMessage("a1", [call])] })
    recorder.onStreamChunk("values", { messages: [humanMessage("u1"), aiMessage("a1", [call])] })

    expect(recorder.getFileWritePaths()).toEqual(["src/dup.ts"])
  })

  it("never lets a malformed payload escape into the run", () => {
    const recorder = new TurnAttributionRecorder({
      threadId: freshThreadId(),
      tracer: createTracer(),
      userMessageId: "u1"
    })
    expect(() => recorder.onStreamChunk("values", null)).not.toThrow()
    expect(() => recorder.onStreamChunk("messages", "nonsense")).not.toThrow()
    expect(() => recorder.onStreamChunk("custom", { anything: true })).not.toThrow()
  })

  it("reaches the same attribution as the desktop path's per-call rule", () => {
    // The desktop loop calls observeToolCallForAttribution per tool call and
    // syncs itself; the IM recorder drives the same rule off the raw stream.
    // Identical input must produce identical attribution on both.
    const toolCalls = [
      { id: "c1", name: "read_file", args: { path: SKILL_DOC } },
      { id: "c2", name: "write_file", args: { path: "src\\a.ts" } },
      { id: "c3", name: "execute", args: { command: "ls" } }
    ]

    const desktopTracer = createTracer()
    const desktopThreadId = freshThreadId()
    const desktopDetector = loadedDetector()
    const desktopWritePaths: string[] = []
    for (const call of toolCalls) {
      const observed = observeToolCallForAttribution(desktopDetector, call)
      if (observed.skillHit) {
        syncTurnSkillAttribution({
          threadId: desktopThreadId,
          tracer: desktopTracer,
          detector: desktopDetector
        })
      }
      if (observed.writePath) desktopWritePaths.push(observed.writePath)
    }

    const imTracer = createTracer()
    const imRecorder = new TurnAttributionRecorder({
      threadId: freshThreadId(),
      tracer: imTracer,
      userMessageId: "u1",
      detector: loadedDetector()
    })
    imRecorder.onStreamChunk("messages", [aiMessage("a1", toolCalls)])

    expect(imTracer.usedSkills).toEqual(desktopTracer.usedSkills)
    expect(imTracer.skillSource).toEqual(desktopTracer.skillSource)
    expect(imTracer.evolvedSkills).toEqual(desktopTracer.evolvedSkills)
    expect(imRecorder.getFileWritePaths()).toEqual(desktopWritePaths)
  })
})

describe("sub-agent attribution", () => {
  it("prefers the sub-agent's own run over any sticky set", () => {
    const parentThreadId = freshThreadId()
    const threadId = freshThreadId()
    setThreadActiveSkills(parentThreadId, ["parent-skill"], ["plugin:p/parent-skill"])
    setThreadActiveSkills(threadId, ["own-sticky"], ["plugin:p/own-sticky"])

    expect(
      resolveSubagentAttributionSkills({
        threadId,
        parentThreadId,
        currentRunSkills: ["this-run"],
        currentRunSkillSource: ["plugin:p/this-run"]
      })
    ).toEqual({ usedSkills: ["this-run"], skillSource: ["plugin:p/this-run"] })
  })

  it("falls back to the sub-agent's own sticky set before the parent's", () => {
    const parentThreadId = freshThreadId()
    const threadId = freshThreadId()
    setThreadActiveSkills(parentThreadId, ["parent-skill"], ["plugin:p/parent-skill"])
    setThreadActiveSkills(threadId, ["own-sticky"], ["plugin:p/own-sticky"])

    expect(
      resolveSubagentAttributionSkills({
        threadId,
        parentThreadId,
        currentRunSkills: [],
        currentRunSkillSource: []
      })
    ).toEqual({ usedSkills: ["own-sticky"], skillSource: ["plugin:p/own-sticky"] })
  })

  it("inherits the parent's skills when the sub-agent has none of its own", () => {
    const parentThreadId = freshThreadId()
    const threadId = freshThreadId()
    setThreadActiveSkills(parentThreadId, ["parent-skill"], ["plugin:p/parent-skill"])

    syncSubagentSkillAttribution({
      threadId,
      parentThreadId,
      currentRunSkills: [],
      currentRunSkillSource: []
    })

    expect(setAdoptionContext).toHaveBeenCalledWith(threadId, {
      usedSkills: ["parent-skill"],
      skillSource: ["plugin:p/parent-skill"]
    })
  })

  it("reports nothing when neither the sub-agent nor its parent used a skill", () => {
    const threadId = freshThreadId()
    expect(
      resolveSubagentAttributionSkills({
        threadId,
        parentThreadId: freshThreadId(),
        currentRunSkills: [],
        currentRunSkillSource: []
      })
    ).toEqual({ usedSkills: [], skillSource: [] })
  })
})

describe("task sub-agent attribution", () => {
  it("merges the child's skills into the parent instead of superseding them", () => {
    const parentThreadId = freshThreadId()
    setThreadActiveSkills(parentThreadId, ["parent-skill"], ["plugin:p/parent-skill"])

    syncTaskSubagentSkillAttribution({
      parentThreadId,
      currentRunSkills: ["child-skill"],
      currentRunSkillSource: ["plugin:p/child-skill"]
    })

    // The parent's own skill must survive: its writes are recorded on the same
    // thread as the child's, so dropping it would mis-bucket the parent's code.
    expect(getThreadActiveSkills(parentThreadId)).toEqual(["parent-skill", "child-skill"])
    expect(setAdoptionContext).toHaveBeenCalledWith(parentThreadId, {
      usedSkills: ["parent-skill", "child-skill"],
      skillSource: ["plugin:p/parent-skill", "plugin:p/child-skill"]
    })
  })

  it("attributes the parent thread when only the child read a SKILL.md", () => {
    const parentThreadId = freshThreadId()

    syncTaskSubagentSkillAttribution({
      parentThreadId,
      currentRunSkills: ["child-skill"],
      currentRunSkillSource: ["plugin:p/child-skill"]
    })

    expect(getThreadActiveSkills(parentThreadId)).toEqual(["child-skill"])
  })

  it("leaves the parent untouched when the child used no skill", () => {
    const parentThreadId = freshThreadId()
    setThreadActiveSkills(parentThreadId, ["parent-skill"], ["plugin:p/parent-skill"])
    setAdoptionContext.mockClear()

    syncTaskSubagentSkillAttribution({
      parentThreadId,
      currentRunSkills: [],
      currentRunSkillSource: []
    })

    expect(setAdoptionContext).not.toHaveBeenCalled()
    expect(getThreadActiveSkills(parentThreadId)).toEqual(["parent-skill"])
  })
})

describe("turn-start publishing", () => {
  it("republishes the sticky set as soon as the recorder is built", () => {
    const threadId = freshThreadId()
    setThreadActiveSkills(threadId, ["sticky-skill"], ["plugin:p/sticky-skill"])
    setAdoptionContext.mockClear()

    // Starting a trace resets the adoption context, and a turn that never reads
    // a SKILL.md produces no skill hit to trigger a sync — so without this the
    // turn's generated code would be recorded with no attribution at all.
    new TurnAttributionRecorder({ threadId, tracer: createTracer() })

    expect(setAdoptionContext).toHaveBeenCalledWith(threadId, {
      usedSkills: ["sticky-skill"],
      skillSource: ["plugin:p/sticky-skill"]
    })
  })

  it("invents no attribution for a thread that never used a skill", () => {
    const threadId = freshThreadId()
    setAdoptionContext.mockClear()

    new TurnAttributionRecorder({ threadId, tracer: createTracer() })

    expect(setAdoptionContext).toHaveBeenCalledWith(threadId, {
      usedSkills: [],
      skillSource: []
    })
  })
})
