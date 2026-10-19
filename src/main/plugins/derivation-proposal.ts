import { randomUUID } from "node:crypto"
import type { PluginDerivationCopy, PluginDerivationProposal } from "../../shared/plugin-derivation"
import type { DerivationSnapshot } from "./derivation-source"
import { prepareNodeCompositionFiles } from "./derivation-node-composition"
import { prepareFlowCompositionFiles } from "./derivation-flow-composition"

export interface DerivationProposalContext {
  owner: string
  identity: string
  modelRef?: string
  guard(): void
}
export interface DerivationProposalModelInput {
  instruction: string
  files: Array<{ path: string; text: string }>
}
interface ProposalEntry {
  kind: "skill" | "node-composition" | "flow-composition"
  context: DerivationProposalContext
  requestId: string
  value: PluginDerivationProposal
  expires: number
  applied?: PluginDerivationCopy
  applying?: Promise<PluginDerivationCopy>
}
const uuid = /^[a-f0-9-]{36}$/
const skillPath = /^skills\/(?:[a-zA-Z0-9_-]+\/)*SKILL\.md$/
const error = (message: string): never => {
  throw Error(message)
}

/** A narrow wording check, never a semantic safety proof; native protocols remain authoritative. */
function requestsProtocolBypass(text: string): boolean {
  const requests =
    /(?:跳过|绕过|禁用|忽略|关闭)(?=[^。！？；;，,\r\n]{0,12}(?:检查|验证|审批|hook|协议))|(?:skip|bypass|disable|ignore)(?=\s+(?:all\s+)?(?:checks?|validat\w*|approvals?|hooks?|protocols?))/gi
  for (const match of text.matchAll(requests)) {
    const prefix = text.slice(Math.max(0, match.index! - 64), match.index)
    const negation =
      /(?:不得|禁止|不能|不要|不应(?:当|该)?|不允许|严禁|切勿|勿|\bdo not|\bmust not|\bnever|\bshould not|\bdon't|\bcannot|\bcan't)\s*$/i.exec(
        prefix
      )
    if (!negation) return true
    // Do not let one safe clause bless a later request, or accept an explicit double negative.
    const beforeNegation = prefix.slice(0, negation.index)
    if (/(?:不(?:是)?|并非|并不|not|don't|do not)\s*$/i.test(beforeNegation)) return true
  }
  return false
}

export function proposalFiles(snapshot: DerivationSnapshot) {
  const files = snapshot.files.filter((file) => skillPath.test(file.path))
  if (!files.length || files.length > 128) throw Error("技能文件缺失或数量超过生成范围")
  return files.map((file) => {
    if (file.bytes.length > 256 * 1024) throw Error("技能文件过大，请使用高级修改")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    if (text.includes("\0")) throw Error("技能文件不是有效文本")
    return { path: file.path, text }
  })
}

/** Model values are additions only; the host constructs the exact reviewed final files. */
export function parseDerivationProposal(
  text: string,
  files: Array<{ path: string; text: string }>
): Pick<PluginDerivationProposal, "summary" | "files"> {
  if (Buffer.byteLength(text) > 96 * 1024) throw Error("模型建议过长")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw Error("模型未返回有效的修改建议，请重试")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("修改建议格式无效")
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some((key) => !["summary", "files"].includes(key)) ||
    typeof row.summary !== "string" ||
    !row.summary.trim() ||
    row.summary.length > 2000 ||
    !Array.isArray(row.files) ||
    !row.files.length ||
    row.files.length > 8
  )
    throw Error("修改建议格式无效")
  const seen = new Set<string>()
  const changes = row.files.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("修改文件格式无效")
    const file = item as Record<string, unknown>
    if (
      Object.keys(file).some((key) => !["path", "addition"].includes(key)) ||
      typeof file.path !== "string" ||
      typeof file.addition !== "string"
    )
      throw Error("修改文件格式无效")
    const original = files.find((source) => source.path === file.path)
    const addition = file.addition.trim()
    if (!original || seen.has(file.path)) throw Error("模型建议包含未知或重复技能文件")
    if (
      !addition ||
      addition.includes("\0") ||
      Buffer.byteLength(addition) > 8000 ||
      /```|~~~|<\/?script\b/i.test(addition)
    )
      throw Error("业务补充格式无效")
    if (requestsProtocolBypass(addition)) throw Error("业务补充不能要求绕过原检查或审批")
    seen.add(file.path)
    const after = `${original.text}\n\n## 本副本的补充业务要求\n\n以下要求补充原技能；原流程、工具、验证和人工审批协议继续有效。\n\n${addition}\n`
    if (Buffer.byteLength(after) > 256 * 1024) throw Error("修改后的技能文件过大")
    return { path: file.path, before: original.text, after }
  })
  return { summary: row.summary.trim(), files: changes }
}

export class DerivationProposalService {
  private readonly pending = new Map<
    string,
    { context: DerivationProposalContext; abort: AbortController }
  >()
  private readonly proposals = new Map<string, ProposalEntry>()
  constructor(
    private readonly deps: {
      snapshot(
        owner: string,
        copyId: string,
        digest: string,
        guard: () => void
      ): Promise<DerivationSnapshot>
      model(
        input: DerivationProposalModelInput,
        signal: AbortSignal,
        context: DerivationProposalContext
      ): Promise<string>
      apply(
        owner: string,
        proposal: PluginDerivationProposal,
        guard: () => void,
        kind?: "skill" | "node-composition" | "flow-composition"
      ): Promise<PluginDerivationCopy>
      timeoutMs?: number
    }
  ) {}

  prepareNodeComposition(
    context: DerivationProposalContext,
    input: { copyId: string; expectedDigest: string; requestId: string }
  ) {
    return this.propose(context, { ...input, instruction: "启用原生节点组合" }, "node-composition")
  }

  prepareFlowComposition(
    context: DerivationProposalContext,
    input: { copyId: string; expectedDigest: string; requestId: string }
  ) {
    return this.propose(context, { ...input, instruction: "用于完整流程组合" }, "flow-composition")
  }

  async propose(
    context: DerivationProposalContext,
    input: {
      copyId: string
      expectedDigest: string
      instruction: string
      requestId: string
    },
    kind: "skill" | "node-composition" | "flow-composition" = "skill"
  ): Promise<PluginDerivationProposal> {
    context.guard()
    if (
      !uuid.test(input.requestId) ||
      typeof input.instruction !== "string" ||
      !input.instruction.trim() ||
      Buffer.byteLength(input.instruction) > 16000
    )
      throw Error("请填写有效且不超过 16000 字节的修改要求")
    for (const [id, item] of this.proposals)
      if (item.expires < Date.now()) this.proposals.delete(id)
    const key = JSON.stringify([context.identity, input.requestId])
    if (
      this.pending.has(key) ||
      [...this.proposals.values()].some(
        (item) => item.context.identity === context.identity && item.requestId === input.requestId
      )
    )
      throw Error("生成请求已提交，请勿重复发送")
    if (
      this.pending.size >= 4 ||
      this.proposals.size >= 32 ||
      [...this.pending.values()].some((item) => item.context.identity === context.identity)
    )
      throw Error("已有生成请求，请取消或等待完成")
    const abort = new AbortController()
    this.pending.set(key, { context, abort })
    const timer = setTimeout(
      () => abort.abort(Error("生成超时，请重试")),
      this.deps.timeoutMs ?? 60_000
    )
    const guard = () => {
      context.guard()
      abort.signal.throwIfAborted()
    }
    try {
      const snapshot = await this.deps.snapshot(
        context.owner,
        input.copyId,
        input.expectedDigest,
        guard
      )
      guard()
      let parsed: Pick<PluginDerivationProposal, "summary" | "files">
      if (kind === "node-composition") {
        parsed = prepareNodeCompositionFiles(snapshot)
      } else if (kind === "flow-composition") {
        parsed = prepareFlowCompositionFiles(snapshot)
      } else {
        const files = proposalFiles(snapshot)
        const modelInput = {
          instruction: input.instruction,
          files: files.map((file) => ({
            path: file.path,
            text:
              file.text.length <= 1000
                ? file.text
                : `${file.text.slice(0, 600)}\n[标题概览]\n${file.text
                    .split(/\r?\n/)
                    .filter((line) => /^#{1,6} /.test(line))
                    .join("\n")
                    .slice(0, 200)}\n[结尾]\n${file.text.slice(-200)}`
          }))
        }
        const reply = await Promise.race([
          this.deps.model(modelInput, abort.signal, context),
          new Promise<never>((_, reject) =>
            abort.signal.addEventListener(
              "abort",
              () => reject(abort.signal.reason ?? Error("生成已取消")),
              { once: true }
            )
          )
        ])
        guard()
        parsed = parseDerivationProposal(reply, files)
      }
      await this.deps.snapshot(context.owner, input.copyId, snapshot.digest, guard)
      guard()
      const value = {
        proposalId: randomUUID(),
        copyId: input.copyId,
        baseDigest: snapshot.digest,
        ...parsed
      }
      this.proposals.set(value.proposalId, {
        kind,
        context,
        requestId: input.requestId,
        value,
        expires: Date.now() + 30 * 60_000
      })
      return structuredClone(value)
    } finally {
      clearTimeout(timer)
      this.pending.delete(key)
    }
  }

  async apply(context: DerivationProposalContext, proposalId: string) {
    const entry = this.entry(context, proposalId)
    if (entry.applied) return structuredClone(entry.applied)
    if (entry.applying) return structuredClone(await entry.applying)
    const guard = () => {
      context.guard()
      entry.context.guard()
      if (this.proposals.get(proposalId) !== entry) throw Error("修改建议已取消")
    }
    entry.applying = this.deps.apply(context.owner, entry.value, guard, entry.kind)
    try {
      const result = await entry.applying
      entry.applied = result
      return structuredClone(result)
    } finally {
      entry.applying = undefined
    }
  }

  private entry(context: DerivationProposalContext, proposalId: string): ProposalEntry {
    context.guard()
    const entry = this.proposals.get(proposalId)
    if (!entry || entry.context.identity !== context.identity || entry.expires < Date.now())
      return error("修改建议已失效，请重新生成")
    entry.context.guard()
    return entry
  }

  cancel(context: DerivationProposalContext, input: { requestId?: string; proposalId?: string }) {
    context.guard()
    if (
      (!input.requestId && !input.proposalId) ||
      (input.requestId !== undefined && !uuid.test(input.requestId)) ||
      (input.proposalId !== undefined && !uuid.test(input.proposalId))
    )
      throw Error("取消请求无效")
    if (input.requestId) {
      const key = JSON.stringify([context.identity, input.requestId])
      this.pending.get(key)?.abort.abort(Error("生成已取消"))
    }
    for (const [id, entry] of this.proposals) {
      if (
        entry.context.identity === context.identity &&
        (id === input.proposalId || entry.requestId === input.requestId)
      )
        this.proposals.delete(id)
    }
  }
}
