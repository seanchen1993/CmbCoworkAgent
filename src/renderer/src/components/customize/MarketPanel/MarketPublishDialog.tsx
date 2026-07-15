import type React from "react"
import { marketApi, type MarketItem, type MarketItemType } from "../../../api/market"
import {
  UniversalUploadDialog,
  type GeneratedMarketFileBuildContext
} from "./UniversalUploadDialog"
import { markUploadedItemInStorage } from "./marketPublishStorage"

type PublishMode = "upload" | "update"

export type MarketPublishTarget = {
  type: Exclude<MarketItemType, "skill" | "orgSkill">
  name: string
  description?: string
  chineseName?: string
  category?: string
  guidance?: string
}

export type MarketPublishFileBuildContext = GeneratedMarketFileBuildContext

function getTypeLabel(type: MarketPublishTarget["type"]): string {
  return type === "mcp" ? "MCP 连接器" : "Plugin"
}

export function MarketPublishDialog(props: {
  open: boolean
  mode: PublishMode
  target: MarketPublishTarget | null
  marketInfo?: Pick<
    MarketItem,
    "name" | "description" | "category" | "chinese_name" | "guidance" | "version"
  >
  buildFile: (
    target: MarketPublishTarget,
    context: MarketPublishFileBuildContext
  ) => Promise<{ success: boolean; file?: File; error?: string }>
  onOpenChange: (open: boolean) => void
  onSuccess: (payload: {
    name: string
    type: MarketPublishTarget["type"]
    mode: PublishMode
  }) => void
}): React.JSX.Element {
  const { open, mode, target, marketInfo, buildFile, onOpenChange, onSuccess } = props
  const label = target ? getTypeLabel(target.type) : "项目"

  return (
    <UniversalUploadDialog
      open={open}
      onOpenChange={onOpenChange}
      onSuccess={() => {
        if (!target) return
        markUploadedItemInStorage(target.name, target.type)
        onSuccess({ name: target.name, type: target.type, mode })
      }}
      resourceType={target?.type ?? "mcp"}
      onUpload={(file, name, description, category, version, guidance, chineseName, userId) => {
        if (!target) return Promise.resolve({ success: false, error: "未选择项目" })
        if (mode === "update") {
          return marketApi.updateItem(
            file,
            target.type,
            name,
            description,
            category,
            version,
            guidance,
            chineseName,
            userId
          )
        }
        if (!file) return Promise.resolve({ success: false, error: "文件不能为空" })
        return marketApi.uploadFile(
          file,
          target.type,
          name,
          description,
          category,
          version,
          guidance,
          chineseName,
          userId
        )
      }}
      isUpdate={mode === "update"}
      existingItem={
        target
          ? {
              name: target.name,
              description: target.description || marketInfo?.description || "",
              category: target.category || marketInfo?.category || "",
              version: marketInfo?.version || undefined,
              guidance: target.guidance || marketInfo?.guidance || "",
              chinese_name: target.chineseName || marketInfo?.chinese_name || ""
            }
          : undefined
      }
      generatedFile={
        target
          ? {
              label: target.type === "mcp" ? "将自动生成 MCP JSON 配置" : "将自动打包 Plugin ZIP",
              build: (context) => buildFile(target, context)
            }
          : undefined
      }
      lockName
      titleOverride={mode === "update" ? `更新市场${label}` : `发布${label}到市场`}
      descriptionOverride={`会自动打包当前${label}并提交到应用市场。名称不可修改。`}
      submitLabel={mode === "update" ? "更新发布" : "一键发布"}
      submittingLabel={mode === "update" ? "更新中..." : "发布中..."}
    />
  )
}
