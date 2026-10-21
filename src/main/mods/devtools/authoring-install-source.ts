import { readAuthoringSourceBundle } from "./authoring-bundle"

/** Deliberately narrow creator package format. Unknown installation declarations fail closed. */
export function readPureFunctionSource(input: unknown) {
  const source = readAuthoringSourceBundle(input)
  const plugin = source.files.find((file) => file.path === "plugin.json")
  const manifest = source.files.find((file) => file.path === "mods/manifest.json")
  if (!plugin || !manifest) throw Error("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
  for (const file of source.files) {
    if (
      !["plugin.json", "README.md", "mods/manifest.json"].includes(file.path) &&
      // Inert author notes and test vectors are retained with the exact source bundle;
      // they do not introduce Skill/Hook/script registration or an executable test runner.
      !/^(?:references\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|json)|tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json)$/.test(
        file.path
      ) &&
      !/^mods\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|css)$/.test(file.path)
    )
      throw Error("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
  }
  const metadata: unknown = JSON.parse(plugin.text)
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).some(
      (key) => !["name", "version", "description", "mods"].includes(key)
    ) ||
    Object.entries(metadata).some(([, value]) => typeof value !== "string") ||
    !("name" in metadata) ||
    typeof metadata.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(metadata.name) ||
    !("mods" in metadata) ||
    metadata.mods !== "mods/manifest.json"
  )
    throw Error("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
  const definition: unknown = JSON.parse(manifest.text)
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    !("apiVersion" in definition) ||
    definition.apiVersion !== "cmb.mods/v2" ||
    Object.keys(definition).some(
      (key) =>
        !["apiVersion", "id", "claw", "entry", "userConfig", "userConfigSchema", "cmbCompatibility", "options", "modelProtocol"].includes(
          key
        )
    )
  )
    throw Error("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
  return source
}
