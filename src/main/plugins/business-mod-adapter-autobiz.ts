import type { BusinessModAssemblyAdapter } from "./business-mod-assembly-contract"
import { businessModExtensionContract } from "./business-mod-assembly-contract"
import { businessModId, businessModObject } from "./business-mod-manifest"
import { assertPortableBusinessBoard } from "./business-mod-user-config"
import { businessModIntegrityDiagnostics } from "./business-mod-integrity"
import { projectBusinessModWorkflow } from "./business-mod-workflow-projection"
import { businessModCheckpoints, projectBusinessModNodes } from "./business-mod-workflow"
import {
  isReviewedAutobizKernelIdentity,
  reviewedAutobizRequiredHookIds
} from "./autobiz-required-hooks"
import {
  wrapProjectRuntimeManifest,
  VERIFIED_ARTIFACTS_PROTOCOL,
  EXTENSION_BOARD_API_VERSION
} from "../../shared/project-runtime"
import { AUTOBIZ_CONTEXT_OUTPUT } from "../../shared/project-runtime/autobiz-handoff"

/** Compatibility projection for admitted legacy board kernels. It does not execute their code. */
export const autobizBusinessModAdapter: BusinessModAssemblyAdapter = {
  id: "autobiz-v1",
  mode: "legacy",
  stateOwner: "plugin",
  assertKernel(kernel) {
    if (typeof kernel.boardConfigPath !== "string" || !kernel.boardConfigPath)
      throw Error("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  },
  ownsKernelIdentity: isReviewedAutobizKernelIdentity,
  reservedPaths: (kernel) => [kernel.boardConfigPath!, "devclaw.stage-checks.json"],
  project(context) {
    const { kernel, modules, verifiedArtifactIds } = context
    if (modules.some((mod) => mod.host !== undefined))
      throw Error("BUSINESS_MOD_HOST_DECLARATION_RUNTIME_CONFLICT")
    const nodes = projectBusinessModNodes(modules)
    const seenCheckpoints = new Set<string>()
    for (const node of nodes) {
      businessModCheckpoints(node)
      for (const checkpoint of node.checkpoints as string[]) {
        if (seenCheckpoints.has(checkpoint)) throw Error("业务 Mods 状态标识冲突")
        seenCheckpoints.add(checkpoint)
      }
    }
    if (verifiedArtifactIds !== undefined) {
      if (!isReviewedAutobizKernelIdentity(kernel))
        throw Error("VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
      if (
        !Array.isArray(verifiedArtifactIds) ||
        !verifiedArtifactIds.length ||
        verifiedArtifactIds.length > 64 ||
        new Set(verifiedArtifactIds).size !== verifiedArtifactIds.length ||
        !verifiedArtifactIds.every(
          (id) => typeof id === "string" && /^[a-zA-Z0-9][\w.-]{0,79}$/.test(id)
        )
      )
        throw Error("VERIFIED_ARTIFACTS_SELECTION_INVALID")
      const outputs = modules.flatMap((mod) => {
        const artifacts = businessModObject(mod.node.artifacts ?? {})
        return Array.isArray(artifacts.outputs) ? artifacts.outputs.map(businessModObject) : []
      })
      for (const id of verifiedArtifactIds)
        if (outputs.filter((output) => output.id === id).length !== 1)
          throw Error("VERIFIED_ARTIFACTS_OUTPUT_UNDECLARED_OR_AMBIGUOUS")
    }
    const contract = businessModExtensionContract(context.contextProvider)
    if (verifiedArtifactIds) {
      contract.requires.push(VERIFIED_ARTIFACTS_PROTOCOL)
      contract.verifiedArtifacts = { artifactIds: [...verifiedArtifactIds] }
    }
    const boardPath = kernel.boardConfigPath!
    const boardFile = context.snapshot.files.find((file) => file.path === boardPath)
    if (!boardFile) throw Error("共享内核流程配置缺失")
    const board = businessModObject(JSON.parse(boardFile.bytes.toString("utf8")))
    assertPortableBusinessBoard(board)
    const workflow = businessModObject(board.workflow)
    const projection = projectBusinessModWorkflow(modules, workflow)
    const integrity = businessModIntegrityDiagnostics(
      board,
      context.files,
      context.skillSearchRoots
    )
    const diagnostics = [...integrity.diagnostics, ...projection.diagnostics]
    const artifacts = new Set<string>()
    for (const node of nodes) {
      const contract = businessModObject(node.artifacts ?? {})
      for (const input of Array.isArray(contract.inputs) ? contract.inputs : []) {
        const artifact = businessModObject(input)
        if (artifact.required !== false && !artifacts.has(String(artifact.path))) {
          const extract =
            artifact.extract === undefined ? undefined : businessModObject(artifact.extract)
          if (!extract || typeof extract.degrade !== "string" || !extract.degrade.trim())
            throw Error(`${node.id} 必需输入没有上游生产者：${artifact.path}`)
          diagnostics.push(
            `${node.id} 输入 ${artifact.path} 来自用户或已有资料，保留原缺失处理与检查`
          )
        }
      }
      for (const output of Array.isArray(contract.outputs) ? contract.outputs : [])
        artifacts.add(String(businessModObject(output).path))
    }
    const skipPolicy =
      workflow.skipPolicy === undefined ? {} : businessModObject(workflow.skipPolicy)
    const locked = skipPolicy.lockedNodes ?? []
    if (!Array.isArray(locked) || locked.length > 64) throw Error("共享内核跳过规则无效")
    const chosen = new Set(modules.map((mod) => mod.id))
    const routing = projection.routing
    const composedBoard = {
      ...board,
      apiVersion: EXTENSION_BOARD_API_VERSION,
      workflow: {
        ...workflow,
        nodes: projection.nodes,
        templates: routing.templates,
        profiles: routing.profiles,
        dynamicStages: routing.dynamicStages,
        skipPolicy: {
          ...skipPolicy,
          lockedNodes: locked.map(businessModId).filter((id) => chosen.has(id))
        },
        checkpoints: routing.checkpoints,
        transitions: routing.transitions
      }
    }
    let requiredHooks: string[] | undefined
    if (isReviewedAutobizKernelIdentity(kernel)) {
      const hooksPath =
        typeof kernel.pluginFields?.hooks === "string"
          ? kernel.pluginFields.hooks
          : "hooks/hooks.json"
      const file = context.files.find((entry) => entry.path === hooksPath)
      if (!file) throw Error("AUTOBIZ_REQUIRED_HOOKS_SOURCE_MISSING")
      requiredHooks = reviewedAutobizRequiredHookIds(JSON.parse(file.bytes.toString("utf8")))
    }
    return {
      runtime: wrapProjectRuntimeManifest(
        {
          apiVersion: "devclaw.project-runtime/v1",
          plugin: { id: context.name, version: context.version },
          mode: "legacy",
          stateOwner: "plugin",
          stages: modules.map((mod) => ({
            id: mod.id,
            title: mod.title,
            actionIds: [],
            artifactIds: [],
            checkIds: [],
            approval: "none"
          })),
          actions: [],
          artifacts: verifiedArtifactIds ? [{ ...AUTOBIZ_CONTEXT_OUTPUT, required: true }] : [],
          checks: [],
          environment: [],
          capabilities: {
            execution: true,
            conditionalTransition: false,
            idempotency: false,
            reconciliation: false,
            cancellation: true
          }
        },
        contract
      ),
      generated: [
        { path: boardPath, value: composedBoard },
        {
          path: "devclaw.stage-checks.json",
          value: {
            apiVersion: "devclaw.stage-check-adapter/v1",
            adapter: "autobiz-v1"
          }
        }
      ],
      ...(requiredHooks ? { requiredHooks } : {}),
      diagnostics,
      missingProviders: integrity.missingProviders,
      requiresFixedWorkflowAcknowledgement: projection.requiresFixedWorkflowAcknowledgement,
      portability: {
        metadata: { boardApiVersion: EXTENSION_BOARD_API_VERSION },
        compatibility:
          "Requires the v2 runtime and board API 2. Hosts supporting only board API 1 reject this package through their existing version check. This report grants no authority; never remove or downgrade either manifest to bypass admission."
      }
    }
  }
}
