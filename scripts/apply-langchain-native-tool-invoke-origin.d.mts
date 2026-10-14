import type { PreparedPackagePlan } from "./langchain-native-foundation-batch.mjs"

export declare function prepareLangchainNativeFoundationPlan(options?: {
  workspaceRoot?: string
}): Promise<PreparedPackagePlan>

export declare function verifyLangchainNativeToolInvokeOverlay(options?: { workspaceRoot?: string }): Promise<boolean>
export declare function classifyLangchainNativeFoundations(options?: { workspaceRoot?: string }): Promise<"pristine" | "base" | "overlay" | "mixed" | undefined>
export declare function readLangchainNativeStreamBaseFiles(options?: { workspaceRoot?: string }): Promise<Map<string, Buffer | undefined>>
export declare function readLangchainNativeToolInvokeBeforeFiles(options?: { workspaceRoot?: string }): Promise<Map<string, Buffer | undefined>>
export declare function installLangchainNativeToolInvokeOrigin(options?: { workspaceRoot?: string; checkOnly?: boolean }): Promise<{ status: string; version: string }>
