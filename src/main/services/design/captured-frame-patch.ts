import type { DesignPatchMetrics, DesignPatchTarget } from "../../../shared/design-patch"
import { decorateDesignNodes } from "../../../shared/design-node-ids"
import { frameNodeId, splitFrameNodeId } from "../../../shared/design-captured-frame"
import { readCapturedFrames, updateCapturedFrames } from "./captured-frame-source"
import { sourceHash } from "./document-index"
import { DesignPatchTargetError } from "./patch-context"
import { executeDesignPatch, type PatchExecutorOptions } from "./patch-executor"
import type { AppliedDesignCandidate } from "./patch-applier"

type DocumentScope = Pick<PatchExecutorOptions, "html" | "artifactPath" | "request" | "tweaks"> & {
  frameId?: string
}
interface Options extends Omit<PatchExecutorOptions, "validate" | "scopedFrame"> {
  capturePath?: string
  validate: (candidate: AppliedDesignCandidate, scope: DocumentScope) => Promise<string[]>
}

/** Reuse document-local validation and publish all annotated documents as one revision. */
export async function executeDesignArtifactPatch(options: Options): Promise<AppliedDesignCandidate> {
  const groups = new Map<string | undefined, DesignPatchTarget[]>()
  for (const target of options.request.targets) {
    const scoped = splitFrameNodeId(target.nodeId)
    const group = groups.get(scoped?.frameId) ?? []
    group.push(scoped ? { ...target, nodeId: scoped.nodeId } : target)
    groups.set(scoped?.frameId, group)
  }
  if (![...groups.keys()].some(Boolean)) {
    const { candidate } = await executeDesignPatch({
      ...options, validate: (candidate) => options.validate(candidate, options)
    })
    return candidate
  }

  const frames = readCapturedFrames(options.html, options.capturePath)
  const changes = new Map<string, string>()
  const candidates: AppliedDesignCandidate[] = []
  let root: AppliedDesignCandidate | undefined
  let cumulative: DesignPatchMetrics | undefined
  // Resolve every document before any model call.
  for (const id of groups.keys())
    if (id && !frames.byId.get(id)?.editable)
      throw new DesignPatchTargetError("此嵌入页面没有可编辑的源码")
  for (const [id, targets] of groups) {
    const frame = id ? frames.byId.get(id) : undefined
    const observations = options.request.observations?.flatMap((item) => {
      const scoped = splitFrameNodeId(item.nodeId)
      return scoped?.frameId === id ? [{ ...item, nodeId: scoped?.nodeId ?? item.nodeId }] : []
    })
    const scope: DocumentScope = {
      frameId: id,
      html: frame ? decorateDesignNodes(frame.html) : options.html,
      artifactPath: frame?.file ?? options.artifactPath,
      tweaks: frame ? null : options.tweaks,
      request: { ...options.request, targets, observations, variationId: frame ? null : options.request.variationId }
    }
    const report = (metrics: DesignPatchMetrics): DesignPatchMetrics => ({
      modelCalls: (cumulative?.modelCalls ?? 0) + metrics.modelCalls,
      inputTokens: (cumulative?.inputTokens ?? 0) + metrics.inputTokens,
      outputTokens: (cumulative?.outputTokens ?? 0) + metrics.outputTokens,
      contextBytes: (cumulative?.contextBytes ?? 0) + metrics.contextBytes,
      expansions: (cumulative?.expansions ?? 0) + metrics.expansions,
      repairs: (cumulative?.repairs ?? 0) + metrics.repairs,
      validationMs: (cumulative?.validationMs ?? 0) + metrics.validationMs,
      usageReported: cumulative?.usageReported || metrics.usageReported
    })
    const { candidate, metrics } = await executeDesignPatch({
      ...options,
      ...scope,
      scopedFrame: !!frame,
      metrics: (result) => options.metrics?.(report(result)),
      validate: (candidate) => options.validate(candidate, scope)
    })
    cumulative = report(metrics)
    if (id) {
      changes.set(id, candidate.html)
      candidate.patch.targetIds = candidate.patch.targetIds.map((nodeId) => frameNodeId(id, nodeId))
    } else root = candidate
    candidates.push(candidate)
  }
  options.signal.throwIfAborted()
  const first = root ?? candidates[0]
  return {
    ...first,
    html: updateCapturedFrames(root?.html ?? options.html, frames.roots, changes),
    tweaks: root?.tweaks ?? options.tweaks,
    patch: {
      ...first.patch,
      mode: "reload",
      targetIds: candidates.flatMap(({ patch }) => patch.targetIds),
      summary: candidates.map(({ patch }) => patch.summary).join("；")
    },
    baseSourceHash: sourceHash(options.html),
    baseTweakRevision: options.tweaks?.revision ?? 0,
    tweakReads: root?.tweakReads ?? {},
    tweakUpdates: root?.tweakUpdates ?? {},
    externalFiles: Object.assign({}, ...candidates.map((candidate) => candidate.externalFiles),
      Object.fromEntries([...frames.sources].map(([file, source]) => [file, sourceHash(source)])))
  }
}
