export interface LangchainInnerStreamOriginInstallOptions {
  workspaceRoot?: string
  checkOnly?: boolean
}
export declare function installLangchainInnerStreamOrigin(
  options?: LangchainInnerStreamOriginInstallOptions
): Promise<{ status: "installed" | "patched"; targets: 18 }>
export declare function prepareLangchainInnerStreamPlan(
  options?: { workspaceRoot?: string }
): Promise<PreparedInnerPlan>
import type { PreparedInnerPlan } from "./langchain-native-foundation-batch.mjs"
