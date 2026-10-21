import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { businessModCatalog, businessModResources } from "./business-mod-manifest"
import type { DerivationFile, DerivationSnapshot } from "./derivation-source"

/** Publish only declared implementations and tutorial entry points, never the whole checkout. */
export function portableBusinessModFiles(snapshot: DerivationSnapshot): DerivationFile[] {
  const catalog = businessModCatalog(snapshot)
  const paths = [
    BUSINESS_MOD_MANIFEST,
    ...snapshot.manifests,
    ...(catalog.kernel
      ? [
          ...catalog.kernel.resources,
          ...(catalog.kernel.boardConfigPath ? [catalog.kernel.boardConfigPath] : [])
        ]
      : []),
    ...catalog.modules.flatMap((mod) => [
      mod.skill.entry,
      ...mod.skill.resources,
      ...mod.resources
    ]),
    ...(catalog.extensions ?? []).flatMap((extension) => [
      extension.entry,
      ...extension.resources,
      ...(extension.skills ?? [])
    ])
  ]
  // A function source remains independently installable. The assembler still regenerates its own
  // native manifest instead of copying a source package's registration/bootstrap into a new plugin.
  if (
    catalog.extensions?.length &&
    snapshot.files.some((file) => file.path === "mods/manifest.json")
  )
    paths.push("mods/manifest.json")
  if (
    catalog.extensions?.some((extension) => extension.stageRecoveryAdapter) &&
    snapshot.files.some((file) => file.path === "devclaw.stage-recovery-adapter.json")
  )
    paths.push("devclaw.stage-recovery-adapter.json")
  // Explicit tutorial allowlist. These are source-side reproduction aids, not runtime resources
  // and are never implicitly materialized into generated plugins by the assembler.
  for (const path of [
    "README.md",
    "README.zh-CN.md",
    "demo/prepare.py",
    "demo/advance.py",
    "demo/templates/plan.json",
    "demo/templates/B001.plan.json",
    "demo/templates/B002.plan.json"
  ])
    if (snapshot.files.some((file) => file.path === path)) paths.push(path)
  return businessModResources(snapshot, paths).sort((a, b) => a.path.localeCompare(b.path, "en"))
}
