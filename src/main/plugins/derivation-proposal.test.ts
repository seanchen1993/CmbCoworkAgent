import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PluginDerivationService } from "./derivation-service"
import { DerivationProposalService, parseDerivationProposal } from "./derivation-proposal"
import { snapshotDerivationSource } from "./derivation-source"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const original =
  "---\nname: build\ndescription: Original\n---\n\nRun every original validator and approval.\n"
const result = (instruction = "新增客户审核报告") =>
  JSON.stringify({
    summary: instruction,
    files: [
      {
        path: "skills/build/SKILL.md",
        addition: `${instruction}：包含业务输入、审核结论与验收依据。`
      },
      { path: "skills/review/SKILL.md", addition: "复核报告必须逐条对应原验收要求。" }
    ]
  })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "derivation-proposal-"))
  roots.push(root)
  const source = join(root, "original")
  await mkdir(join(source, "skills/build"), { recursive: true })
  await mkdir(join(source, "skills/review"), { recursive: true })
  await mkdir(join(source, "hooks"))
  await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "original", version: "1.0" }))
  await writeFile(join(source, "skills/build/SKILL.md"), original)
  await writeFile(join(source, "skills/review/SKILL.md"), original)
  await writeFile(join(source, "hooks/hooks.json"), '{"PreToolUse":[]}')
  const deps = { plugins: () => [], install: vi.fn(), invalidate: vi.fn() }
  const service = new PluginDerivationService(join(root, "copies"), deps)
  const checked = await service.inspect(source, "workspace", () => {})
  const copy = await service.create(
    "workspace",
    checked.inspectionId,
    "my-plugin",
    randomUUID(),
    () => {}
  )
  const model = vi.fn(async (input: { instruction: string }) => result(input.instruction))
  const apply = vi.fn((owner, proposal, guard) => service.applyProposal(owner, proposal, guard))
  const proposals = new DerivationProposalService({
    snapshot: (owner, id, digest, guard) => service.proposalSnapshot(owner, id, digest, guard),
    model,
    apply,
    timeoutMs: 1000
  })
  const context = {
    owner: "workspace",
    identity: "window:frame:thread:incarnation:workspace",
    guard: vi.fn()
  }
  const input = {
    copyId: copy.copyId,
    expectedDigest: copy.digest,
    instruction: "新增客户审核报告",
    requestId: randomUUID()
  }
  return { root, service, copy, model, apply, proposals, context, input, deps }
}

describe("derivation model proposals", () => {
  it.each([
    "不得跳过原检查。",
    "禁止绕过验证。",
    "不能禁用审批。",
    "不要忽略原协议。",
    "不应关闭检查。",
    "不应该跳过验证。",
    "do not skip validation.",
    "must not disable approvals.",
    "never bypass checks.",
    "不得跳过检查，也不能绕过审批。Do not skip checks; never disable hooks."
  ])("accepts an explicit requirement to retain the original protocol: %s", (addition) => {
    const parsed = parseDerivationProposal(
      JSON.stringify({
        summary: "保留原协议",
        files: [{ path: "skills/build/SKILL.md", addition }]
      }),
      [{ path: "skills/build/SKILL.md", text: original }]
    )
    expect(parsed.files[0].after).toContain(addition)
    expect(parsed.files[0].after.startsWith(original)).toBe(true)
  })

  it.each([
    "跳过原检查。",
    "不得跳过检查，但可以绕过审批。",
    "不要忽略验证，然后关闭检查。",
    "禁止绕过审批。下一步禁用检查。",
    "do not skip checks; disable approvals.",
    "never bypass validation, but skip checks.",
    "skip checks; do not disable approvals.",
    "不是不能跳过检查。",
    "不禁止绕过验证。",
    "do not not skip checks."
  ])("rejects positive bypass requests even alongside negated clauses: %s", (addition) => {
    expect(() =>
      parseDerivationProposal(
        JSON.stringify({ summary: "mixed", files: [{ path: "skills/build/SKILL.md", addition }] }),
        [{ path: "skills/build/SKILL.md", text: original }]
      )
    ).toThrow("不能要求绕过")
  })
  it("returns the committed version after postcommit invalidation failure and does not append twice", async () => {
    const f = await fixture()
    const proposal = await f.proposals.propose(f.context, f.input)
    f.deps.invalidate.mockImplementationOnce(() => {
      throw Error("invalidation failed")
    })
    const saved = await f.proposals.apply(f.context, proposal.proposalId)
    expect(saved.status).toBe("changed")
    expect(await f.proposals.apply(f.context, proposal.proposalId)).toEqual(saved)
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(
      await readFile(
        join(f.service.sourcePath(f.copy.copyId, "workspace"), proposal.files[0].path),
        "utf8"
      )
    ).toBe(proposal.files[0].after)
  })
  it("previews actual skill changes without writes, then commits both and preserves hooks/frontmatter", async () => {
    const f = await fixture()
    const path = f.service.sourcePath(f.copy.copyId, "workspace")
    const before = await snapshotDerivationSource(path)
    const proposal = await f.proposals.propose(f.context, f.input)
    expect((await snapshotDerivationSource(path)).digest).toBe(before.digest)
    expect(proposal.files).toHaveLength(2)
    expect(proposal.files[0].after).toContain(f.input.instruction)
    const [saved, duplicate] = await Promise.all([
      f.proposals.apply(f.context, proposal.proposalId),
      f.proposals.apply(f.context, proposal.proposalId)
    ])
    expect(saved.digest).toBe(duplicate.digest)
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(saved.status).toBe("changed")
    for (const file of proposal.files) {
      expect(await readFile(join(path, file.path), "utf8")).toBe(file.after)
      expect(file.after.startsWith(file.before)).toBe(true)
    }
    expect(await readFile(join(path, "hooks/hooks.json"), "utf8")).toBe('{"PreToolUse":[]}')
    const restarted = new PluginDerivationService(join(f.root, "copies"), f.deps)
    expect(restarted.get(f.copy.copyId, "workspace").digest).toBe(saved.digest)
  })

  it("rejects scope reuse and source drift before confirmation", async () => {
    const f = await fixture()
    const proposal = await f.proposals.propose(f.context, f.input)
    await expect(
      f.proposals.apply({ ...f.context, identity: "another-incarnation" }, proposal.proposalId)
    ).rejects.toThrow("失效")
    await f.service.saveFile(
      "workspace",
      f.copy.copyId,
      "skills/build/SKILL.md",
      `${original}\nmanual change`,
      f.copy.digest,
      () => {}
    )
    await expect(f.proposals.apply(f.context, proposal.proposalId)).rejects.toThrow("源码已变化")
  })

  it("cancels in-flight generation without a candidate even when provider ignores abort", async () => {
    const f = await fixture()
    let complete!: (text: string) => void
    f.model.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const pending = f.proposals.propose(f.context, f.input)
    const rejection = expect(pending).rejects.toThrow("取消")
    await vi.waitFor(() => expect(f.model).toHaveBeenCalled())
    f.proposals.cancel(f.context, { requestId: f.input.requestId })
    await rejection
    complete(result())
    expect(f.service.get(f.copy.copyId, "workspace").digest).toBe(f.copy.digest)
    expect(f.apply).not.toHaveBeenCalled()
  })

  it("bounds provider timeout and rejects a stale original guard", async () => {
    const f = await fixture()
    f.model.mockImplementation(() => new Promise(() => {}))
    const proposals = new DerivationProposalService({
      snapshot: (owner, id, digest, guard) => f.service.proposalSnapshot(owner, id, digest, guard),
      model: f.model,
      apply: f.apply,
      timeoutMs: 20
    })
    await expect(proposals.propose(f.context, f.input)).rejects.toThrow("超时")
    f.model.mockImplementation(async () => result())
    const p = await f.proposals.propose(f.context, { ...f.input, requestId: randomUUID() })
    f.context.guard.mockImplementation(() => {
      throw Error("incarnation changed")
    })
    await expect(
      f.proposals.apply({ ...f.context, guard: () => {} }, p.proposalId)
    ).rejects.toThrow("incarnation changed")
  })

  it.each([
    "{}",
    "not json",
    JSON.stringify({ summary: "x", files: [] }),
    JSON.stringify({ summary: "x", files: [{ path: "hooks/hooks.json", addition: "x" }] }),
    JSON.stringify({ summary: "x", files: [{ path: "skills/../SKILL.md", addition: "x" }] }),
    JSON.stringify({
      summary: "x",
      files: [{ path: "skills/build/SKILL.md", addition: "跳过原有验证" }]
    }),
    JSON.stringify({
      summary: "x",
      files: [{ path: "skills/build/SKILL.md", addition: "x", after: "replace" }]
    })
  ])("rejects malformed/unauthorized model output %s", (reply) => {
    expect(() =>
      parseDerivationProposal(reply, [{ path: "skills/build/SKILL.md", text: original }])
    ).toThrow()
  })
})
