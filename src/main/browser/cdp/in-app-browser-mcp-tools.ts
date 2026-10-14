const IN_APP_BROWSER_PROVIDER_NAME = "inappbrowser"
const IN_APP_BROWSER_SCREENSHOT_TOOL_NAME = "browser_take_screenshot"

function normalizeProviderName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function shouldSuppressInAppBrowserMcpTool(options: {
  providerDisplayName: string
  toolName: string
}): boolean {
  return (
    normalizeProviderName(options.providerDisplayName) === IN_APP_BROWSER_PROVIDER_NAME &&
    options.toolName === IN_APP_BROWSER_SCREENSHOT_TOOL_NAME
  )
}
