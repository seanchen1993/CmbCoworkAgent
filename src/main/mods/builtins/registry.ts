import type { DevClawBuiltinId, DevClawBuiltinStatus } from "../../../shared/mods/builtins"

const definitions: ReadonlyArray<Readonly<Omit<DevClawBuiltinStatus, "state">>> = Object.freeze(
  [
    {
      id: "devclaw-project-instructions",
      name: "项目规范",
      description: "查看本次宿主加载的规范来源和范围"
    },
    { id: "devclaw-change-review", name: "变更审阅", description: "按明确基线查看改动与检查范围" },
    { id: "devclaw-policy", name: "组织策略", description: "解释实际限制和需要确认的原因" },
    {
      id: "devclaw-observability",
      name: "执行度量",
      description: "在运行过程中查看已有记录的进度与用量"
    },
    {
      id: "devclaw-extension-authoring",
      name: "扩展开发助手",
      description: "描述需求、检查试用并应用自己的功能"
    },
    {
      id: "devclaw-project-advisor",
      name: "项目提示",
      description: "查看依据当前事实提出的下一步建议"
    }
  ].map((item) => Object.freeze(item)) as Array<Readonly<Omit<DevClawBuiltinStatus, "state">>>
)

/** Providers are supplied by application code, never an uploaded name or manifest. */
export function describeDevClawBuiltins(
  providers: Partial<Record<DevClawBuiltinId, DevClawBuiltinStatus["state"]>>
): DevClawBuiltinStatus[] {
  return definitions.map((item) => ({ ...item, state: providers[item.id] ?? "unavailable" }))
}
