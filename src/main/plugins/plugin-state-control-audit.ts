import type { PluginStateControlAudit } from "../../shared/plugin-modularization"
import type { DerivationSnapshot } from "./derivation-source"

/** Discover candidate paths without executing code, inferring edges or trusting declarations as tests. */
export function inspectPluginStateControl(
  snapshot: DerivationSnapshot,
  runtime: "host" | "legacy" | "unknown"
): PluginStateControlAudit {
  const paths = snapshot.files.map((file) => file.path)
  const all = {
    writerCandidates: paths.filter((path) =>
      /(?:^|\/)[^/]*(?:state(?:_store)?|checkpoint|transition|rollback)[^/]*\.(?:[cm]?[jt]s|py|json|md)$/i.test(
        path
      )
    ),
    hooks: paths.filter((path) => /(?:^|\/)hooks(?:\/|\.)/i.test(path)),
    configuration: paths.filter((path) =>
      /(?:^|\/)(?:[^/]*config[^/]*|plugin|manifest|devclaw\.[^/]+)\.json$/i.test(path)
    ),
    knowledge: paths.filter((path) =>
      /(?:^|\/)(?:knowledge|references|context)(?:\/|\.)/i.test(path)
    ),
    functionEntries: paths.filter((path) => /^mods\/.*\.[cm]?[jt]sx?$/.test(path))
  }
  return {
    schemaVersion: 1,
    authority:
      runtime === "host"
        ? "existing-host"
        : runtime === "legacy"
          ? "original-plugin-writer"
          : "unidentified-original",
    migration: runtime === "host" ? "not-required-for-host" : "not-migrated",
    functionExtensions: all.functionEntries.length ? "present-unverified" : "not-detected",
    graph: runtime === "host" ? "existing-host-contract" : "author-confirmation-required",
    execution: "unverified",
    sources: Object.fromEntries(
      Object.entries(all).map(([key, value]) => [key, value.slice(0, 64)])
    ) as PluginStateControlAudit["sources"],
    sourcePathsTruncated: Object.values(all).some((paths) => paths.length > 64),
    next: { tool: "mod_authoring", action: "scaffold", kind: "state-extension" }
  }
}
