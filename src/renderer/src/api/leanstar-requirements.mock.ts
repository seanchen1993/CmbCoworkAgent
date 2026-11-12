import type {
  ProductRequirement,
  RequirementDetail,
  RequirementDocumentContent,
  RichComponent
} from "./leanstar-requirements"

export const REQUIREMENT_SPACE_MOCK_ENABLED = import.meta.env.DEV
export const REQUIREMENT_SPACE_MOCK_CODE = "MOCK-SPACE-001"

export const REQUIREMENT_SPACE_MOCK: ProductRequirement = {
  id: "mock-space-001",
  code: REQUIREMENT_SPACE_MOCK_CODE,
  title: "【Mock】需求空间3.0功能验证需求",
  status: "DEVELOPING",
  priority: "P1",
  ownerSapId: "mock-user-001",
  ownerName: "测试用户",
  createTime: "2026-11-12T10:30:00",
  functionRequirements: [
    { code: "MOCK-FR-001", title: "富文本附件预览" },
    { code: "MOCK-FR-002", title: "项目模式携带PRD文件" },
    { code: "MOCK-FR-003", title: "继续设计与重置" }
  ]
}

export const REQUIREMENT_SPACE_MOCK_COMPONENT: RichComponent = {
  id: "mockimage001",
  resourceName: "验证图片",
  resourceVersion: "1",
  type: "IMAGE"
}

export const REQUIREMENT_SPACE_MOCK_DETAIL: RequirementDetail = {
  code: REQUIREMENT_SPACE_MOCK_CODE,
  title: REQUIREMENT_SPACE_MOCK.title,
  description: "用于验证需求空间3.0详情页、设计入口和项目模式文件附件。"
}

export const REQUIREMENT_SPACE_MOCK_DOCUMENT: RequirementDocumentContent = {
  code: REQUIREMENT_SPACE_MOCK_CODE,
  title: REQUIREMENT_SPACE_MOCK.title,
  documentTextContent: [
    "# 产品特性需求说明书",
    "",
    "| 文档信息 | 内容 |",
    "| --- | --- |",
    "| 文档编号 | MOCK-SPACE-001 |",
    "| 版本 | V1.0 |",
    "| 申请部门 | 财富平台部 |",
    "| 业务联系人 | 测试用户 |",
    "| 保密级别 | 内部 |",
    "",
    "## 需求说明",
    "",
    "验证需求空间3.0的列表分页、详情预览、富文本图片及项目模式PRD文件携带功能。",
    "",
    "![验证图片](picmockimage001)"
  ].join("\n"),
  richComponents: [REQUIREMENT_SPACE_MOCK_COMPONENT]
}

export const REQUIREMENT_SPACE_MOCK_DESCRIPTION =
  "这是一张用于验证富文本资源下载、Markdown图片显示和附件描述写入PRD文件的测试图片。"

export function createRequirementSpaceMockImage(): Blob {
  return new Blob(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320">',
      '<rect width="720" height="320" rx="24" fill="#eef2ff"/>',
      '<rect x="60" y="64" width="600" height="192" rx="16" fill="#ffffff" stroke="#6366f1" stroke-width="3"/>',
      '<text x="360" y="145" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#312e81">需求空间3.0 富文本图片</text>',
      '<text x="360" y="195" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#6366f1">Mock resource loaded successfully</text>',
      "</svg>"
    ],
    { type: "image/svg+xml" }
  )
}
