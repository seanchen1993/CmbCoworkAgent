import type { StageCheckContract } from "../../../shared/project-runtime/stage-check-receipt"
import { stageCheckArtifactAllowed } from "../../../shared/project-runtime/stage-check-receipt"
import type { StoredStageCheck } from "./composition-stage-check-store"
import type { BigIntStats } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { readRuntimeScopedFileAsync, runtimeDirectoryAsync } from "./safe-files-async"
import { dirname, join } from "node:path"
import type {
  HarnessRunDetailViewModel,
  ManagedRunEvent,
  ManagedRunSnapshot
} from "../../../shared/harness-board-types"
import type { CompositionCompletionProof } from "../../../shared/project-runtime/composition"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { runtimeDigest, runtimeRelativePath } from "./safe-files"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import {
  isAutobizContextOutput,
  type AutobizContextFile
} from "../../../shared/project-runtime/autobiz-handoff"

/** One bounded observation per path, shared by receipt verification, evidence and handoff. */
export async function artifactObserver(workspace: string) {
  const files = new Map<string, string>()
  const contents = new Map<string, Buffer>()
  const observations = new Map<string, string>()
  const directories = new Map<string, Array<[string, string]>>()
  let bytes = 0
  const identity = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
  const rootIdentity = identity(await lstat(workspace, { bigint: true }))
  const inspect = async (relative: string) => {
    runtimeRelativePath(relative)
    let stat: BigIntStats
    try {
      stat = await lstat(join(workspace, relative), { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw Error("COMPOSITION_LEGACY_ARTIFACT_UNPROVEN")
      throw error
    }
    if (stat.isSymbolicLink()) throw Error("COMPOSITION_LEGACY_ARTIFACT_LINK")
    const previous = observations.get(relative)
    if (previous && previous !== identity(stat)) throw Error("COMPOSITION_LEGACY_ARTIFACT_CHANGED")
    if (!previous && observations.size >= 256) throw Error("COMPOSITION_LEGACY_ARTIFACT_LIMIT")
    observations.set(relative, identity(stat))
    return stat
  }
  const file = async (relative: string): Promise<string> => {
    await inspect(relative)
    const cached = files.get(relative)
    if (cached) return cached
    if (files.size >= 128) throw Error("COMPOSITION_LEGACY_ARTIFACT_LIMIT")
    const result = await readRuntimeScopedFileAsync(
      workspace,
      relative,
      Math.min(4 * 1024 * 1024, 16 * 1024 * 1024 - bytes)
    )
    if (!result.bytes) throw Error("COMPOSITION_LEGACY_ARTIFACT_UNPROVEN")
    await inspect(relative)
    bytes += result.bytes.length
    const digest = runtimeDigest(result.bytes)
    files.set(relative, digest)
    contents.set(relative, result.bytes)
    return digest
  }
  const entries = async (relative: string, depth = 0): Promise<Array<[string, string]>> => {
    if (depth > 16) throw Error("COMPOSITION_LEGACY_ARTIFACT_LIMIT")
    const stat = await inspect(relative)
    if (!stat.isDirectory()) return [[relative, await file(relative)]]
    await runtimeDirectoryAsync(join(workspace, relative))
    const cached = directories.get(relative)
    if (cached) return cached
    const result: Array<[string, string]> = [[relative, "directory"]]
    const names = (await readdir(join(workspace, relative))).sort()
    if (names.length > 128) throw Error("COMPOSITION_LEGACY_ARTIFACT_LIMIT")
    for (const name of names) result.push(...(await entries(`${relative}/${name}`, depth + 1)))
    await inspect(relative)
    directories.set(relative, result)
    return result
  }
  return {
    file,
    entries,
    async content(relative: string) {
      await file(relative)
      return contents.get(relative)!
    },
    async verify() {
      await runtimeDirectoryAsync(workspace)
      if (identity(await lstat(workspace, { bigint: true })) !== rootIdentity)
        throw Error("COMPOSITION_LEGACY_ARTIFACT_CHANGED")
      for (const relative of observations.keys()) {
        await inspect(relative)
        await runtimeDirectoryAsync(dirname(join(workspace, relative)))
        if (directories.has(relative)) await runtimeDirectoryAsync(join(workspace, relative))
      }
    }
  }
}

/** Observations must come from the original pinned inspector and healthy ManagedRun journal. */
export async function observeLegacyCompositionCompletion(
  context: CompositionExecutionContext,
  input: {
    projectId: string
    featureId: string
    managed: ManagedRunSnapshot
    events: readonly ManagedRunEvent[]
    detail: HarnessRunDetailViewModel
    journalHealthy: boolean
    stageChecks?: { contracts: StageCheckContract[]; receipts: StoredStageCheck[] }
  },
  collectHandoff = false,
  selectedArtifactIds?: readonly string[]
): Promise<{ proof: CompositionCompletionProof; files: AutobizContextFile[] }> {
  const { detail, managed, events } = input
  const done = (status: string | undefined) => status === "done" || status === "archived"
  const workspace = await runtimeDirectoryAsync(context.executionWorkspace ?? context.workspace)
  if (
    !input.journalHealthy ||
    managed.status !== "completed" ||
    managed.projectId !== input.projectId ||
    managed.featureId !== input.featureId ||
    detail.project.projectId !== input.projectId ||
    detail.run.slug !== input.featureId ||
    detail.adapterSnapshot.mock ||
    !done(detail.run.featureStatus) ||
    !isSameWorkspacePath(detail.project.projectRootPath, workspace) ||
    !events.length ||
    events.length > 10000 ||
    events.some((event) => event.runId !== managed.runId) ||
    !events.some((event) => event.type === "run_completed")
  )
    throw Error("COMPOSITION_LEGACY_NOT_COMPLETED")
  const nodes = detail.workflow.nodes
  if (
    !nodes.length ||
    nodes.length > 64 ||
    new Set(nodes.map((node) => node.id)).size !== nodes.length ||
    detail.run.currentNodeId !== nodes.at(-1)!.id ||
    detail.run.nodes.length !== nodes.length
  )
    throw Error("COMPOSITION_LEGACY_STAGES_INCOMPLETE")
  const evidence: unknown[] = []
  const checked = input.stageChecks
  if (checked) {
    if (!checked.contracts.length || !checked.receipts.length || checked.receipts.length > 256)
      throw Error("COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN")
    for (const receipt of checked.receipts) {
      const contract = checked.contracts.find(
        (item) =>
          item.nodeId === receipt.receipt.nodeId &&
          item.checkId === receipt.receipt.checkId &&
          item.contractDigest === receipt.receipt.contractDigest
      )
      if (
        receipt.runId !== context.runId ||
        receipt.unitId !== context.unit.id ||
        receipt.engineRunId !== managed.runId ||
        receipt.packageDigest !== context.unit.source.packageDigest ||
        !contract ||
        receipt.receipt.artifacts.some((artifact) => !stageCheckArtifactAllowed(contract, artifact))
      )
        throw Error("COMPOSITION_LEGACY_RECEIPT_SCOPE_CHANGED")
    }
    for (const contract of checked.contracts) {
      if (
        !nodes.some((node) => node.id === contract.nodeId) ||
        !checked.receipts.some(
          (item) =>
            item.receipt.nodeId === contract.nodeId &&
            item.receipt.checkId === contract.checkId &&
            item.receipt.contractDigest === contract.contractDigest
        )
      )
        throw Error("COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN")
    }
    evidence.push(checked)
  }
  const observer = await artifactObserver(workspace)
  const receiptProvesFile = async (artifactId: string, path: string): Promise<boolean> => {
    const latest = checked?.receipts
      .flatMap((item) => item.receipt.artifacts)
      .filter((item) => item.id === artifactId && item.path === path)
      .at(-1)
    return Boolean(latest && (await observer.file(path)) === latest.digest)
  }
  const receiptProvesPath = async (artifactId: string, path: string): Promise<boolean> => {
    const entries = (await observer.entries(path)).filter(([, digest]) => digest !== "directory")
    if (!entries.length) return false
    for (const [file] of entries) if (!(await receiptProvesFile(artifactId, file))) return false
    return true
  }
  for (const definition of nodes) {
    const node = detail.run.nodes.find((node) => node.id === definition.id)
    if (!node || !done(node.nodeStatus)) throw Error("COMPOSITION_LEGACY_STAGES_INCOMPLETE")
    const sessions = new Set(
      events
        .filter(
          (event) =>
            event.nodeId === node.id &&
            (event.type === "session_created" || event.type === "session_started")
        )
        .map((event) => event.targetThreadId)
        .filter(Boolean)
    )
    for (const required of definition.hookDefinitions?.filter((hook) => hook.required) ?? []) {
      // Some original validators are invoked by the skill after its done checkpoint.
      // Only the matching original check's main-owned receipt may substitute for a
      // Hook log; generic postcheck or another stage's receipt cannot do so.
      const originalCheck = checked?.receipts.find(
        (item) => item.receipt.nodeId === node.id && item.receipt.checkId === required.id
      )
      if (originalCheck) {
        evidence.push(originalCheck)
        continue
      }
      const receipts = node.hooks
        .filter(
          (hook) =>
            hook.eventId === required.id &&
            hook.nodeId === node.id &&
            hook.pluginId === context.unit.source.pluginId &&
            hook.featureId === input.featureId &&
            sessions.has(hook.sessionId)
        )
        .sort((left, right) => left.ts.localeCompare(right.ts))
      const latest = receipts.at(-1)
      if (!latest || latest.eventStatus !== "success")
        throw Error("COMPOSITION_LEGACY_REQUIRED_HOOK_UNPROVEN")
      evidence.push(latest)
    }
    const requiredIds = new Set([
      ...(definition.artifactDefinitions
        ?.filter((artifact) => artifact.required)
        .map((artifact) => artifact.id) ?? []),
      ...node.artifacts.filter((artifact) => artifact.required).map((artifact) => artifact.id)
    ])
    if (checked && requiredIds.size && !checked.contracts.some((item) => item.nodeId === node.id))
      throw Error("COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN")
    for (const id of requiredIds) {
      const artifact = node.artifacts.find((artifact) => artifact.id === id)
      if (
        !artifact ||
        (!checked && (artifact.exists !== true || artifact.validation?.status !== "valid"))
      )
        throw Error("COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN")
      const paths = [
        ...new Set([...(artifact.path ? [artifact.path] : []), ...(artifact.paths ?? [])])
      ]
      if (!paths.length || paths.length > 32) throw Error("COMPOSITION_LEGACY_ARTIFACT_UNPROVEN")
      for (const path of paths) {
        if (checked && !(await receiptProvesPath(id, path)))
          throw Error("COMPOSITION_LEGACY_REQUIRED_CHECK_UNPROVEN")
        evidence.push({
          nodeId: node.id,
          artifactId: id,
          path,
          digest: runtimeDigest(JSON.stringify(await observer.entries(path))),
          validation: artifact.validation
        })
      }
    }
    for (const event of events.filter(
      (event) => event.nodeId === node.id && event.type === "human_gate_invoked"
    )) {
      const decision = events.find(
        (receipt) =>
          receipt.type === "managed_run_decision" &&
          receipt.gateId === event.gateId &&
          receipt.sourceEventId === event.eventId &&
          receipt.decisionActor === "user" &&
          receipt.decisionAction === "approve_human_gate" &&
          ["desktop", "im"].includes(receipt.decisionChannel ?? "")
      )
      if (
        !event.gateId ||
        !decision ||
        !events.some(
          (receipt) =>
            receipt.type === "human_gate_approved" &&
            receipt.gateId === event.gateId &&
            receipt.decisionEventId === decision.eventId
        )
      )
        throw Error("COMPOSITION_LEGACY_APPROVAL_UNPROVEN")
    }
  }
  const artifacts: CompositionCompletionProof["artifacts"] = []
  for (const output of context.unit.outputs) {
    if (collectHandoff && isAutobizContextOutput(output)) continue
    const declared = detail.run.nodes
      .flatMap((node) => node.artifacts)
      .some(
        (artifact) =>
          artifact.id === output.id &&
          [artifact.path, ...(artifact.paths ?? [])].includes(output.path) &&
          (checked || artifact.validation?.status === "valid")
      )
    if (!declared || (checked && !(await receiptProvesFile(output.id, output.path))))
      throw Error("COMPOSITION_LEGACY_OUTPUT_UNPROVEN")
    artifacts.push({ ...output, digest: await observer.file(output.path) })
  }
  const files: AutobizContextFile[] = []
  if (collectHandoff) {
    if (!checked) throw Error("AUTOBIZ_HANDOFF_CONTRACT_REQUIRED")
    if (selectedArtifactIds !== undefined && (!selectedArtifactIds.length ||
      selectedArtifactIds.length > 64 || new Set(selectedArtifactIds).size !== selectedArtifactIds.length ||
      !selectedArtifactIds.every(id => /^[a-zA-Z0-9][\w.-]{0,79}$/.test(id))))
      throw Error("AUTOBIZ_HANDOFF_SELECTION_INVALID")
    if (selectedArtifactIds?.some(id => detail.run.nodes.flatMap(node => node.artifacts)
      .filter(output => output.id === id).length !== 1))
      throw Error("AUTOBIZ_HANDOFF_OUTPUT_UNDECLARED_OR_AMBIGUOUS")
    const selected = new Set<string>()
    const latestById = new Map<
      string,
      Map<
        string,
        {
          receipt: StoredStageCheck["receipt"]
          artifact: StoredStageCheck["receipt"]["artifacts"][number]
        }
      >
    >()
    for (const row of checked.receipts)
      for (const artifact of row.receipt.artifacts) {
        let paths = latestById.get(artifact.id)
        if (!paths) latestById.set(artifact.id, (paths = new Map()))
        paths.set(artifact.path, { receipt: row.receipt, artifact })
      }
    // The original inspector lists outputs only. Receipts alone also contain validated inputs.
    for (const node of detail.run.nodes)
      for (const output of node.artifacts) {
        if (selectedArtifactIds && !selectedArtifactIds.includes(output.id)) continue
        const paths = [output.path, ...(output.paths ?? [])].filter((path): path is string =>
          Boolean(path)
        )
        for (const latest of latestById.get(output.id)?.values() ?? []) {
          const candidate = latest.artifact
          if (
            candidate.id !== output.id ||
            !paths.some((path) => candidate.path === path || candidate.path.startsWith(path + "/"))
          )
            continue
          if (
            !checked.contracts.some(
              (contract) =>
                contract.nodeId === node.id && stageCheckArtifactAllowed(contract, candidate)
            )
          )
            continue
          const key = JSON.stringify([candidate.id, candidate.path])
          if (selected.has(key)) continue
          selected.add(key)
          if (
            selected.size > 128 ||
            !candidate.path.startsWith(`.autobizdevops/features/${input.featureId}/`)
          )
            throw Error("AUTOBIZ_HANDOFF_SCOPE_INVALID")
          const bytes = await observer.content(candidate.path)
          if (runtimeDigest(bytes) !== latest.artifact.digest)
            throw Error("AUTOBIZ_HANDOFF_ARTIFACT_CHANGED")
          let content: string
          try {
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
          } catch {
            throw Error("AUTOBIZ_HANDOFF_TEXT_REQUIRED")
          }
          if (content.includes("\0")) throw Error("AUTOBIZ_HANDOFF_TEXT_REQUIRED")
          files.push({
            id: candidate.id,
            path: candidate.path,
            digest: latest.artifact.digest,
            outputNodeId: node.id,
            checkedBy: {
              nodeId: latest.receipt.nodeId,
              checkId: latest.receipt.checkId,
              contractDigest: latest.receipt.contractDigest
            },
            content
          })
        }
      }
    if (!files.length) throw Error("AUTOBIZ_HANDOFF_OUTPUTS_REQUIRED")
    if (selectedArtifactIds?.some(id => !files.some(file => file.id === id)))
      throw Error("AUTOBIZ_HANDOFF_SELECTED_OUTPUT_UNPROVEN")
    files.sort(
      (left, right) =>
        left.path.localeCompare(right.path, "en") || left.id.localeCompare(right.id, "en")
    )
  }
  await observer.verify()
  return {
    files,
    proof: {
      kind: "flow-completed",
      engineRunId: managed.runId,
      artifacts,
      evidenceDigest: runtimeDigest(
        JSON.stringify({ source: context.unit.source, managed, events, evidence, artifacts })
      )
    }
  }
}

export async function proveLegacyCompositionCompletion(
  context: CompositionExecutionContext,
  input: Parameters<typeof observeLegacyCompositionCompletion>[1]
): Promise<CompositionCompletionProof> {
  return (await observeLegacyCompositionCompletion(context, input)).proof
}
