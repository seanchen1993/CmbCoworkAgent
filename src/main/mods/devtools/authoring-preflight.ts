import { compileFunctionPlugin } from "../v2/loader"
import { analyzeFunctionSdk } from "./sdk-usage"
import { checkFunctionAuthorTypes } from "./authoring-check"

/** CPU-heavy analysis. Production calls this exclusively inside its disposable Worker. */
export async function analyzeAuthoringPreview(directory: string) {
  const compiled = await compileFunctionPlugin(directory, { captureSources: true })
  const sdk = await analyzeFunctionSdk(compiled)
  const typecheck = await checkFunctionAuthorTypes(directory)
  if (typecheck.digest !== compiled.digest) throw Error("AUTHORING_PREVIEW_SOURCE_CHANGED")
  return {
    compiled: {
      name: compiled.name,
      digest: compiled.digest,
      modelProtocol: compiled.modelProtocol,
      code: compiled.code,
      options: compiled.options
    },
    sdk,
    typecheck
  }
}
export type AuthoringPreviewAnalysis = Awaited<ReturnType<typeof analyzeAuthoringPreview>>
