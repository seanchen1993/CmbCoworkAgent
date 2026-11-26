import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { settleSkillProposal, streamSkillProposal } from "./skill-proposal-logic"

const draft = { name: "Review findings", description: "Review a patch", content: "# Review" }

async function* streamDraft(skillId: string, name = draft.name) {
  yield { content: JSON.stringify({ ...draft, name, skillId }) }
}

function awaitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

afterEach(() => vi.useRealTimers())

it("reports an unusable skill ID as a retryable failure and completes a valid retry", async () => {
  const progress = vi.fn()

  await expect(streamSkillProposal(async () => streamDraft("技能", "审查"), progress)).resolves.toBeNull()
  expect(progress.mock.calls.map(([phase]) => phase)).toEqual(["token", "error"])
  expect(progress).toHaveBeenLastCalledWith("error", "技能草稿解析失败，请重试")

  progress.mockClear()
  await expect(streamSkillProposal(async () => streamDraft("review_findings"), progress)).resolves.toEqual({
    ...draft,
    skillId: "review_findings"
  })
  expect(progress.mock.calls.map(([phase]) => phase)).toEqual(["token", "done"])
})

it.each(["", "技能"])("uses a valid name when the proposal ID is %j", async (id) => {
  const progress = vi.fn()

  await expect(streamSkillProposal(async () => streamDraft(id), progress)).resolves.toEqual({
    ...draft,
    skillId: "review-findings"
  })
  expect(progress.mock.calls.map(([phase]) => phase)).toEqual(["token", "done"])
})

it.each(["opening", "streaming"])("reports an idle timeout while %s", async (stage) => {
  vi.useFakeTimers()
  const progress = vi.fn()
  const proposal = streamSkillProposal(async (signal) => {
    if (stage === "opening") await awaitAbort(signal)
    return (async function* () {
      yield { content: "partial draft" }
      await awaitAbort(signal)
    })()
  }, progress)
  const outcome = expect(proposal).rejects.toThrow("技能草稿生成超时")

  await vi.advanceTimersByTimeAsync(60_000)
  await outcome
  expect(progress.mock.calls).toEqual(stage === "opening" ? [] : [["token", "partial draft"]])
  expect(vi.getTimerCount()).toBe(0)
})

it("allows an active stream to continue for more than one idle window", async () => {
  vi.useFakeTimers()
  const progress = vi.fn()
  const skillId = "review_findings"
  const text = JSON.stringify({ ...draft, skillId })
  const proposal = streamSkillProposal(async () => (async function* () {
    yield { content: text.slice(0, 10) }
    await new Promise(resolve => setTimeout(resolve, 45_000))
    yield { content: text.slice(10, 20) }
    await new Promise(resolve => setTimeout(resolve, 45_000))
    yield { content: text.slice(20) }
  })(), progress)

  await vi.advanceTimersByTimeAsync(90_000)
  await expect(proposal).resolves.toEqual({ ...draft, skillId })
  expect(progress).toHaveBeenLastCalledWith("done", text)
  expect(vi.getTimerCount()).toBe(0)
})

it("stops a closing tab's generation without reporting a failure", async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const progress = vi.fn()
  const proposal = streamSkillProposal(async (signal) => {
    await awaitAbort(signal)
    return streamDraft("review-findings")
  }, progress, controller.signal)

  controller.abort()
  await expect(proposal).resolves.toBeNull()
  expect(progress).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("reports a directory conflict as a save failure and only settles after a successful save", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-proposal-save-"))
  const skillDir = join(directory, "review-findings")
  const file = join(skillDir, "SKILL.md")
  const onProgress = vi.fn()
  const confirm = async () => ({ approved: true, content: draft.content })
  const save = async (content?: string) => {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(file, content ?? "", "utf8")
  }
  const side = { signal: new AbortController().signal, onProgress }
  try {
    writeFileSync(skillDir, "path conflict")
    await settleSkillProposal(confirm, save, side)
    expect(onProgress).toHaveBeenCalledExactlyOnceWith("error", expect.stringContaining("无法保存技能"))
    expect(readFileSync(skillDir, "utf8")).toBe("path conflict")

    rmSync(skillDir)
    onProgress.mockClear()
    await settleSkillProposal(confirm, save, side)
    expect(readFileSync(file, "utf8")).toBe(draft.content)
    expect(onProgress).toHaveBeenCalledExactlyOnceWith("settled", "")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("settles a declined proposal and skips an approval after the tab closes", async () => {
  const controller = new AbortController()
  const onProgress = vi.fn()
  const save = vi.fn()
  const side = { signal: controller.signal, onProgress }
  await settleSkillProposal(async () => ({ approved: false }), save, side)
  expect(onProgress).toHaveBeenCalledExactlyOnceWith("settled", "")
  onProgress.mockClear()

  await settleSkillProposal(async () => {
    controller.abort()
    return { approved: true }
  }, save, side)
  expect(save).not.toHaveBeenCalled()
  expect(onProgress).not.toHaveBeenCalled()
})
