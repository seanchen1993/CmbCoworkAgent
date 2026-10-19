import type { ProjectCompositionCatalogEntry } from "../../../../shared/project-runtime/composition-api"
import type { ProjectCompositionUnit } from "../../../../shared/project-runtime/composition"

export function ProjectCompositionWorkflow({ title, catalog, value, disabled, onChange }: {
  title: string
  catalog: NonNullable<ProjectCompositionCatalogEntry["workflow"]>
  value: ProjectCompositionUnit["workflow"]
  disabled: boolean
  onChange(value: ProjectCompositionUnit["workflow"]): void
}) {
  const templates = catalog.config.templates.filter((item) => item.templateType === "custom")
  const template = templates.find((item) => item.id === value?.templateId)
  return <fieldset disabled={disabled} className="space-y-2 rounded-md bg-muted/30 p-3">
    <legend className="text-sm font-medium">{title} · 项目步骤</legend>
    <label className="grid gap-1 text-sm">
      执行范围
      <select aria-label={`${title} · 执行范围`} value={value?.templateId ?? ""}
        className="w-full rounded-md border bg-background p-2"
        onChange={(event) => {
          const selected = templates.find((item) => item.id === event.target.value)
          onChange(selected ? {
            templateId: selected.id,
            nodeIds: catalog.config.nodes.filter((node) => selected.requiredNodes.includes(node.id))
              .map((node) => node.id)
          } : undefined)
        }}>
        <option value="">原插件默认流程</option>
        {templates.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    {template && value && <>
      <p className="text-xs text-muted-foreground">
        选择本次需要的步骤。预览会调用原插件补齐依赖，并保留原检查和人工确认。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {catalog.config.nodes.map((node) => {
          const required = template.requiredNodes.includes(node.id)
          return <label key={node.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={value.nodeIds.includes(node.id)} disabled={required}
              onChange={(event) => {
                const ids = new Set(value.nodeIds)
                if (event.target.checked) ids.add(node.id)
                else ids.delete(node.id)
                onChange({ ...value,
                  nodeIds: catalog.config.nodes.filter((item) => ids.has(item.id)).map((item) => item.id) })
              }} />
            <span>{node.label}{required ? "（必需）" : ""}</span>
          </label>
        })}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={value.includeOptionalDependencies ?? true}
          onChange={(event) => onChange({ ...value, includeOptionalDependencies: event.target.checked })} />
        自动加入可选输入的上游步骤
      </label>
      {value.includeOptionalDependencies === false && <p className="text-xs text-muted-foreground">
        按原插件的可选输入和入口降级声明处理；预览会列出需补充的资料，必需节点和原检查仍然保留。
      </p>}
    </>}
  </fieldset>
}
