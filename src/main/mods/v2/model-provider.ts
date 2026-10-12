import { invokeFunctionModelWith } from "./model-provider-core"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { type FunctionModelReply, type FunctionModelRequest } from "./model-sdk"

export async function resolveFunctionModel(name: string): Promise<ResolvedModelConfig> {
  const registry = await import("../../models/registry")
  // A miss must not silently route a plugin's data to a different model.
  const model =
    name === "default" ? registry.getDefaultModelConfig() : registry.getModelConfigByRef(name)
  if (!model?.apiKey) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
  return model
}

/** The existing provider handles protocols; no history, tools or user credentials enter the VM. */
export async function invokeFunctionModel(
  config: ResolvedModelConfig,
  request: FunctionModelRequest,
  signal: AbortSignal
): Promise<FunctionModelReply> {
  const { getModelInstance } = await import("../../agent/runtime")
  return invokeFunctionModelWith(config, request, signal, (settings) =>
    getModelInstance(settings, undefined, 1, "function-completion")
  )
}
