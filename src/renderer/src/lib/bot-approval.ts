export function isBotPluginGrant(prompt: string): boolean {
  try {
    const value: unknown = JSON.parse(prompt)
    if (!value || typeof value !== "object" || !("pluginGrant" in value)) return false
    const grant = value.pluginGrant
    return (
      !!grant &&
      typeof grant === "object" &&
      "name" in grant &&
      "digest" in grant &&
      typeof grant.name === "string" &&
      typeof grant.digest === "string"
    )
  } catch {
    return false
  }
}
