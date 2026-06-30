/**
 * Unit + regression tests for plugin-aware cloud-evolution candidate matching.
 *
 * Run:
 *   npx tsx tests/plugin-skill-evolution-match.spec.ts
 */

import {
  evolutionSkillKey,
  selectAvailableUpdates
} from "../src/renderer/src/api/evolution-matching.ts"
import type {
  EvolutionAdoptionRecord,
  EvolutionCandidate,
  InstalledSkillLike
} from "../src/renderer/src/api/evolution.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function candidate(partial: Partial<EvolutionCandidate> & { skill_name: string }): EvolutionCandidate {
  return {
    candidate_id: `cand-${partial.skill_name}-${partial.target_version ?? "x"}`,
    run_id: "run-1",
    status: "published",
    recommendation: null,
    base_skill_id: partial.skill_name,
    full_bundle_path: "",
    files_changed: [],
    source_trace_ids: [],
    source_thread_ids: [],
    evolution_status: "published",
    auto_optimized: true,
    target_version: "v1.0.1",
    ...partial
  }
}

const NONE = { ignoredIds: new Set<string>(), adopted: new Map<string, EvolutionAdoptionRecord>() }

function run(): void {
  // ── evolutionSkillKey ──────────────────────────────────────────────
  assert(evolutionSkillKey("pdf") === "pdf", "standalone key is bare name")
  assert(evolutionSkillKey("pdf", null) === "pdf", "null pluginName → bare name")
  assert(
    evolutionSkillKey("pdf", "my-plugin") === "plugin:my-plugin/pdf",
    "plugin key is namespaced"
  )

  // ── Regression: standalone candidate matches a custom skill by name ──
  {
    const installed: InstalledSkillLike[] = [{ name: "pdf", version: "v1.0.0" }]
    const result = selectAvailableUpdates(
      [candidate({ skill_name: "pdf", target_version: "v1.0.1" })],
      installed,
      NONE
    )
    assert(result.length === 1, "standalone update should be available")
    assert(result[0].skill_name === "pdf", "standalone candidate matched")
  }

  // ── Regression: no update when target <= installed ─────────────────
  {
    const installed: InstalledSkillLike[] = [{ name: "pdf", version: "v2.0.0" }]
    const result = selectAvailableUpdates(
      [candidate({ skill_name: "pdf", target_version: "v1.0.1" })],
      installed,
      NONE
    )
    assert(result.length === 0, "older candidate suppressed")
  }

  // ── Collision guard: standalone candidate must NOT match a plugin skill ──
  {
    const installed: InstalledSkillLike[] = [
      { name: "pdf", version: "v1.0.0", pluginName: "my-plugin" }
    ]
    const result = selectAvailableUpdates(
      [candidate({ skill_name: "pdf", target_version: "v1.0.1" })], // no plugin_name
      installed,
      NONE
    )
    assert(result.length === 0, "standalone candidate must not match a plugin's same-named skill")
  }

  // ── Plugin candidate matches the installed plugin skill ────────────
  {
    const installed: InstalledSkillLike[] = [
      { name: "pdf", version: "v1.0.0", pluginName: "my-plugin", path: "/p/my-plugin/skills/pdf/SKILL.md" }
    ]
    const result = selectAvailableUpdates(
      [candidate({ skill_name: "pdf", plugin_name: "my-plugin", target_version: "v1.0.1" })],
      installed,
      NONE
    )
    assert(result.length === 1, "plugin update should be available")
    assert(result[0].plugin_name === "my-plugin", "matched candidate keeps plugin provenance")
  }

  // ── Plugin candidate must NOT match a same-named custom skill ───────
  {
    const installed: InstalledSkillLike[] = [{ name: "pdf", version: "v1.0.0" }] // custom only
    const result = selectAvailableUpdates(
      [candidate({ skill_name: "pdf", plugin_name: "my-plugin", target_version: "v1.0.1" })],
      installed,
      NONE
    )
    assert(result.length === 0, "plugin candidate must not match a custom same-named skill")
  }

  // ── Plugin + custom same name coexist; each matches its own ────────
  {
    const installed: InstalledSkillLike[] = [
      { name: "pdf", version: "v1.0.0" },
      { name: "pdf", version: "v1.0.0", pluginName: "my-plugin" }
    ]
    const result = selectAvailableUpdates(
      [
        candidate({ skill_name: "pdf", target_version: "v1.0.1" }),
        candidate({ skill_name: "pdf", plugin_name: "my-plugin", target_version: "v1.0.2" })
      ],
      installed,
      NONE
    )
    assert(result.length === 2, "plugin and custom same-named skills are distinct updates")
    const keys = new Set(result.map((c) => evolutionSkillKey(c.skill_name, c.plugin_name)))
    assert(keys.has("pdf") && keys.has("plugin:my-plugin/pdf"), "both identities present")
  }

  // ── Dedup keeps the latest target per (plugin) skill ───────────────
  {
    const installed: InstalledSkillLike[] = [
      { name: "pdf", version: "v1.0.0", pluginName: "my-plugin" }
    ]
    const result = selectAvailableUpdates(
      [
        candidate({ skill_name: "pdf", plugin_name: "my-plugin", target_version: "v1.0.1" }),
        candidate({ skill_name: "pdf", plugin_name: "my-plugin", target_version: "v1.0.3" })
      ],
      installed,
      NONE
    )
    assert(result.length === 1, "dedup to one plugin candidate")
    assert(result[0].target_version === "v1.0.3", "latest plugin version kept")
  }

  console.log("plugin-skill-evolution-match.spec: all assertions passed")
}

run()
