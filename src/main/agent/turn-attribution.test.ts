import { beforeEach, describe, expect, it, vi } from "vitest"

const setAdoptionContext = vi.fn()
vi.mock("../services/adoption-tracker", () => ({
  setAdoptionContext: (...args: unknown[]) => setAdoptionContext(...args)
}))

const { SkillUsageDetector } = await import("./skill-evolution/usage-detector")
const { setThreadActiveSkills } = await import("./skill-evolution/proposal-window")
const {
  TurnAttributionRecorder,
  observeExplicitSkillActivation,
  observeToolCallForAttribution,
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
