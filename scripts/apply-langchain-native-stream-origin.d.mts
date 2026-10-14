export interface LangchainNativeStreamOriginInstallOptions {
  workspaceRoot?: string
  checkOnly?: boolean
}

export declare function installLangchainNativeStreamOrigin(
  options?: LangchainNativeStreamOriginInstallOptions
): Promise<{ status: "installed" | "patched"; version: string }>
