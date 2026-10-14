import type { PluginMetadata } from "../../types"
import { createHash } from "node:crypto"

/** Catalogue metadata only: discovery must not read credentials or start a plugin/MCP. */
export function pluginMigrationReport(plugins: PluginMetadata[], id?: string) {
  const selected = id ? plugins.filter((plugin) => plugin.id === id) : plugins
  if (id && !selected.length) throw Error("DEVELOPMENT_PLUGIN_MISSING")
  return selected.slice(0, 128).map((plugin) => {
    const origin = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      skillCount: plugin.skillCount,
      mcpServerCount: plugin.mcpServerCount,
      hookCount: plugin.hookCount,
      modCount: plugin.modCount ?? 0
    }
    return {
      ...origin,
      dependencyState: {
        installed: true,
        enabled: plugin.enabled,
        availability: "not-checked",
        live: "not-checked"
      },
      catalogueDigest: createHash("sha256").update(JSON.stringify(origin)).digest("hex"),
      migration: {
        strategy: "preserve-original-and-add-pure-function-adapter",
        skills: plugin.skillCount ? "reuse-original-skill-source" : "none",
        mcp: plugin.mcpServerCount ? "reuse-original-configured-server" : "none",
        hooks: plugin.hookCount ? "needs-explicit-event-and-side-effect-review" : "none",
        scripts: "explicit-source-read-only-no-execution",
        capabilities: [
          {
            kind: "ui-and-local-commands",
            adaptation: "independent-function-source",
            trial: "check-current-catalog-and-request-approval"
          },
          {
            kind: "skills",
            adaptation: "preserve-original-identity",
            trial: "use-original-skill-or-explicit-formal-claw-composition"
          },
          {
            kind: "mcp-and-external-side-effects",
            adaptation: "requires-explicit-formal-integration",
            trial: "unavailable-in-session-development"
          }
        ],
        automaticConversion: false,
        next: "按用户目标生成独立适配草稿；保留原 Skill/MCP 来源，在 Claw 中显式组合。工具调用、脚本和复杂 Hook 必须验证输入输出与副作用，不能自动认定等价。"
      }
    }
  })
}
