/**
 * Sticky active-skill persistence.
 *
 * The in-memory map is only a cache: threads routinely span an app restart, and
 * an attribution that lives only in memory silently downgrades every generation
 * made before the next SKILL.md read into the vibecoding bucket. These tests
 * drive the recovery path by forcing an LRU eviction — the same code path a
 * restart takes, minus the process boundary.
 *
 * storage.getOpenworkDir is mocked to a throwaway temp dir so the test never
 * touches the real ~/.cmbcoworkagent/adoption-index.sqlite.
 */

import { rmSync } from "fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path")
  return { tempDir: mkdtempSync(join(tmpdir(), "thread-active-skills-test-")) as string }
})

vi.mock("../../storage", () => ({ getOpenworkDir: () => h.tempDir }))

import { closeAdoptionIndex, initializeAdoptionIndex } from "../../services/adoption-index"
import {
  getThreadActiveSkills,
  getThreadActiveSkillSource,
  mergeThreadActiveSkills,
  setThreadActiveSkills
} from "./proposal-window"

/** Larger than MAX_ACTIVE_SKILL_THREADS, so the thread under test is evicted. */
const EVICTION_PRESSURE_THREADS = 250

function evictInMemoryCache(): void {
  for (let i = 0; i < EVICTION_PRESSURE_THREADS; i += 1) {
    setThreadActiveSkills(`filler-thread-${i}`, [`filler-skill-${i}`], [])
  }
}

describe("sticky active skills survive losing the in-memory cache", () => {
  beforeAll(async () => {
    await initializeAdoptionIndex()
  })

  afterAll(() => {
    closeAdoptionIndex()
    try {
      rmSync(h.tempDir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  })

  it("recovers a superseding set after the thread is evicted", () => {
    setThreadActiveSkills("thread-restart", ["cmbdev-v1.0.0"], ["plugin:cmbdev/cmbdev-v1.0.0"])
    evictInMemoryCache()

    expect(getThreadActiveSkills("thread-restart")).toEqual(["cmbdev-v1.0.0"])
    expect(getThreadActiveSkillSource("thread-restart")).toEqual(["plugin:cmbdev/cmbdev-v1.0.0"])
  })

  it("recovers a merged set contributed by a task sub-agent", () => {
    setThreadActiveSkills("thread-merge", ["parent-skill"], ["plugin:p/parent-skill"])
    mergeThreadActiveSkills("thread-merge", ["child-skill"], ["plugin:p/child-skill"])
    evictInMemoryCache()

    expect(getThreadActiveSkills("thread-merge")).toEqual(["parent-skill", "child-skill"])
    expect(getThreadActiveSkillSource("thread-merge")).toEqual([
      "plugin:p/parent-skill",
      "plugin:p/child-skill"
    ])
  })

  it("keeps the latest set when a later turn supersedes an earlier one", () => {
    setThreadActiveSkills("thread-supersede", ["first-skill"], [])
    setThreadActiveSkills("thread-supersede", ["second-skill"], [])
    evictInMemoryCache()

    expect(getThreadActiveSkills("thread-supersede")).toEqual(["second-skill"])
  })

  it("reports no skills for a thread that never used one", () => {
    expect(getThreadActiveSkills("thread-never-used")).toEqual([])
    expect(getThreadActiveSkillSource("thread-never-used")).toEqual([])
  })
})

describe("negative lookups do not go stale", () => {
  beforeAll(async () => {
    await initializeAdoptionIndex()
  })

  afterAll(() => {
    closeAdoptionIndex()
  })

  it("picks up a set written after the thread was already looked up empty", () => {
    // The empty answer is cached to keep sqlite off the streaming hot path, so
    // the write has to invalidate it or the thread stays permanently skill-less.
    expect(getThreadActiveSkills("thread-late-skill")).toEqual([])

    setThreadActiveSkills("thread-late-skill", ["late-skill"], ["plugin:p/late-skill"])

    expect(getThreadActiveSkills("thread-late-skill")).toEqual(["late-skill"])
    evictInMemoryCache()
    expect(getThreadActiveSkills("thread-late-skill")).toEqual(["late-skill"])
  })

  it("picks up a merged set written after an empty lookup", () => {
    expect(getThreadActiveSkills("thread-late-merge")).toEqual([])

    mergeThreadActiveSkills("thread-late-merge", ["merged-skill"], [])

    expect(getThreadActiveSkills("thread-late-merge")).toEqual(["merged-skill"])
  })
})

describe("sub-agent sets stay out of the index", () => {
  beforeAll(async () => {
    await initializeAdoptionIndex()
  })

  afterAll(() => {
    closeAdoptionIndex()
  })

  it("serves an unpersisted set from memory but does not store it", () => {
    setThreadActiveSkills("thread-ephemeral", ["ephemeral-skill"], [], { persist: false })

    // Readable while the process lives...
    expect(getThreadActiveSkills("thread-ephemeral")).toEqual(["ephemeral-skill"])
    // ...and gone once the cache is, because nothing was written to the index.
    evictInMemoryCache()
    expect(getThreadActiveSkills("thread-ephemeral")).toEqual([])
  })

  it("does not let a stale negative lookup hide an unpersisted write", () => {
    expect(getThreadActiveSkills("thread-ephemeral-late")).toEqual([])

    setThreadActiveSkills("thread-ephemeral-late", ["late-ephemeral"], [], { persist: false })

    expect(getThreadActiveSkills("thread-ephemeral-late")).toEqual(["late-ephemeral"])
  })
})
