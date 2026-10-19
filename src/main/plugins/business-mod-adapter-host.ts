import type { BusinessModAssemblyAdapter } from "./business-mod-assembly-contract"
import { businessModExtensionContract } from "./business-mod-assembly-contract"
import {
  wrapProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import { assertHostRuntimeSupported } from "../harness-board/project-runtime/host-validators"
import { parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"

/** Static projection to the existing Host state owner, executor, checks and approvals. */
export const hostLinearBusinessModAdapter: BusinessModAssemblyAdapter = {
  id: "host-linear-v1",
  mode: "host",
  stateOwner: "host",
  assertKernel(kernel) {
    if (kernel.boardConfigPath !== undefined) throw Error("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  },
  reservedPaths: () => [],
  project(context) {
    if (context.verifiedArtifactIds !== undefined)
      throw Error("VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
    if (context.contextProvider) throw Error("BUSINESS_MOD_HOST_CONTEXT_PROVIDER_UNSUPPORTED")
    if (context.files.some((file) => file.path === "devclaw.stage-checks.json"))
      throw Error("BUSINESS_MOD_LEGACY_CHECKS_REQUIRE_ADAPTER")
    for (const mod of context.modules) {
      if (!mod.host) throw Error("BUSINESS_MOD_HOST_DECLARATION_REQUIRED")
      if (
        mod.checks.validators.length ||
        mod.checks.guards.length ||
        Object.keys(mod.node).some((key) => !["id", "skill", "order"].includes(key))
      )
        throw Error("BUSINESS_MOD_LEGACY_CHECKS_REQUIRE_ADAPTER")
      if (
        mod.node.order !== undefined &&
        (typeof mod.node.order !== "number" || !Number.isSafeInteger(mod.node.order))
      )
        throw Error("BUSINESS_MOD_HOST_ORDER_INVALID")
      const skill = context.files.find((file) => file.path === mod.skill.entry)
      if (
        !skill ||
        parseSkillNameFromFrontmatterYaml(skill.bytes.toString("utf8")) !== mod.node.skill
      )
        throw Error("BUSINESS_MOD_HOST_SKILL_INVALID")
      // Every authored check must remain bound to its stage; unused declarations cannot imply a guarantee.
      if (
        mod.host.checks.some((check) => !mod.host!.stage.checkIds.includes(check.id)) ||
        mod.host.artifacts.some((artifact) => !mod.host!.stage.artifactIds.includes(artifact.id)) ||
        mod.host.actions.some(
          (action) =>
            !mod.host!.stage.actionIds.includes(action.id) &&
            !mod.host!.checks.some((check) => check.actionId === action.id)
        )
      )
        throw Error("BUSINESS_MOD_HOST_UNBOUND_DECLARATION")
      for (const artifact of mod.host.artifacts) {
        if (
          artifact.required &&
          !mod.host.checks.some(
            (check) =>
              check.artifactId === artifact.id && mod.host!.stage.checkIds.includes(check.id)
          )
        )
          throw Error("BUSINESS_MOD_HOST_REQUIRED_ARTIFACT_UNCHECKED")
      }
      if (!mod.host.stage.checkIds.length) throw Error("BUSINESS_MOD_HOST_STAGE_CHECK_REQUIRED")
    }
    const runtime: ProjectRuntimeManifest = {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: context.name, version: context.version },
      mode: "host",
      stateOwner: "host",
      stages: context.modules.map((mod) => ({
        ...mod.host!.stage,
        id: mod.id,
        title: mod.title,
        skill: mod.skill.entry
      })),
      actions: context.modules.flatMap((mod) => mod.host!.actions),
      artifacts: context.modules.flatMap((mod) => mod.host!.artifacts),
      checks: context.modules.flatMap((mod) => mod.host!.checks),
      environment: context.modules.flatMap((mod) => mod.host!.environment),
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    }
    const envelope = wrapProjectRuntimeManifest(
      runtime,
      businessModExtensionContract(context.contextProvider)
    )
    assertHostRuntimeSupported(envelope.runtime)
    return {
      runtime: envelope,
      generated: [],
      diagnostics: [],
      missingProviders: [],
      requiresFixedWorkflowAcknowledgement: false,
      portability: {
        compatibility:
          "Requires the negotiated v2 runtime and the native Host linear executor. No legacy board or plugin-owned checkpoint is used. Rebind local configuration and authorize the installed package; declarations and assembly locks grant no authority."
      }
    }
  }
}
