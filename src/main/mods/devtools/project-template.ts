import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import { createNativeProjectTemplate } from "./project-native-template"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import {
  compileProjectHarness,
  HARNESS_SOURCE_PATH,
  type HarnessDefinition
} from "./project-harness"

export type ProjectTemplateKind =
  | "native-modular"
  | "project-lite"
  | "harness-lite"
  | "harness-fullstack"
  | "harness-data"

export interface ProjectTemplateInput {
  packageId: string
  name: string
  version?: string
  template?: ProjectTemplateKind
}

export function createProjectTemplate(input: ProjectTemplateInput): AuthoringSourceBundle {
  const version = input.version ?? "0.1.0"
  if (
    !/^[a-z][a-z0-9-]{0,47}$/.test(input.packageId) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(input.packageId) ||
    !input.name.trim() ||
    input.name.length > 100 ||
    !/^\d+\.\d+\.\d+$/.test(version)
  ) {
    throw Error("PROJECT_TEMPLATE_INPUT")
  }
  if (input.template === "native-modular") return createNativeProjectTemplate(input)
  if (input.template && input.template !== "project-lite") return createHarnessTemplate(input)
  const manifest: ProjectRuntimeManifest = parseProjectRuntimeManifest({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: input.packageId, version },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "draft",
        title: "起草",
        skill: "skills/draft/SKILL.md",
        actionIds: [],
        artifactIds: ["draft"],
        checkIds: ["draft-exists"],
        approval: "none"
      },
      {
        id: "review",
        title: "检查与确认",
        skill: "skills/draft/SKILL.md",
        actionIds: [],
        artifactIds: ["draft", "review"],
        checkIds: ["draft-exists", "review-schema"],
        approval: "human"
      }
    ],
    actions: [],
    artifacts: [
      { id: "draft", path: "draft.md", required: true },
      { id: "review", path: "review.json", required: true }
    ],
    checks: [
      { id: "draft-exists", kind: "file-exists", artifactId: "draft", sideEffect: "read" },
      {
        id: "review-schema",
        kind: "json-schema",
        artifactId: "review",
        sideEffect: "read",
        schema: {
          type: "object",
          required: ["summary", "checked"],
          additionalProperties: false,
          properties: {
            summary: { type: "string", minLength: 1, maxLength: 4000 },
            checked: { const: true }
          }
        }
      }
    ],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: false,
      cancellation: true
    }
  })
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  return createAuthoringSourceBundle([
    {
      path: "plugin.json",
      text: json({ name: input.packageId, version, description: input.name })
    },
    { path: "devclaw.project-runtime.json", text: json(manifest) },
    {
      path: "devclaw.capabilities.json",
      text: json({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: "project-flow",
            title: input.name,
            kind: "flow",
            usage: "project",
            entry: "devclaw.project-runtime.json"
          }
        ]
      })
    },
    {
      path: "skills/draft/SKILL.md",
      text: `---
name: ${input.packageId}-draft
description: 起草或复核当前轻量文档项目，在项目工作区生成 draft.md 和 review.json。
---

由宿主提供项目身份、工作区、当前阶段和用户目标。缺少目标时先向用户询问。

在 draft 阶段，根据目标撰写工作区中的 draft.md。保留用户已有内容；修改前先读取。
在 review 阶段，重新读取 draft.md，检查是否满足用户目标并修正文档；完成后写入 review.json，
结构为 {"summary":"说明实际检查范围、结论及未解决问题","checked":true}。

只报告真实执行的工作。文件存在或 JSON 结构检查通过，不代表内容质量通过。
阶段推进、验收证据和人工确认由宿主处理；不要编辑宿主数据库、伪造审批或自行宣告项目已完成。
用户拒绝确认时保留产物，按照反馈修复后再请求原确认入口。
`
    },
    {
      path: "tests/project-contract.json",
      text: json({
        apiVersion: "devclaw.project-contract/v1",
        cases: [
          { id: "missing-draft", stageId: "draft", files: [], expected: "failed" },
          {
            id: "draft-present",
            stageId: "draft",
            files: [{ path: "draft.md", text: "# 示例草稿\n" }],
            expected: "passed"
          },
          {
            id: "invalid-review",
            stageId: "review",
            files: [
              { path: "draft.md", text: "# 示例草稿\n" },
              { path: "review.json", text: '{"checked":false}' }
            ],
            expected: "failed"
          },
          {
            id: "review-present",
            stageId: "review",
            files: [
              { path: "draft.md", text: "# 示例草稿\n" },
              { path: "review.json", text: '{"summary":"仅验证测试数据结构","checked":true}' }
            ],
            expected: "passed"
          }
        ]
      })
    }
  ])
}

function createHarnessTemplate(input: ProjectTemplateInput): AuthoringSourceBundle {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const configurations = {
    "harness-lite": [
      ["draft", "起草", "draft.md", "根据用户目标起草文档，读取并保留已有内容。"],
      [
        "review",
        "检查与确认",
        "review.json",
        "读取并保留 draft.md，不修改前序草稿；将修订内容写入 reviewed.md，无问题时也保存复核版本，再在 review.json 记录实际检查范围和结论。"
      ]
    ],
    "harness-fullstack": [
      ["design", "需求与接口设计", "design.md", "明确用户目标、页面、接口、数据模型与验收条件。"],
      [
        "implement",
        "实现与验证",
        "implementation.md",
        "根据 design.md 在项目工作区实现前后端，运行适当检查，记录改动和真实结果。"
      ],
      ["review", "交付确认", "review.json", "对照设计复核实现，记录测试、未解决问题与交付范围。"]
    ],
    "harness-data": [
      [
        "source",
        "数据口径",
        "source.md",
        "明确用户授权的数据来源、字段口径与质量规则；不读取未授权数据或凭据。"
      ],
      [
        "transform",
        "数据开发",
        "transformation.md",
        "按 source.md 实现转换与质量检查，记录输入、输出及真实执行结果。"
      ],
      ["review", "结果确认", "review.json", "复核转换逻辑和数据质量，记录验证范围、问题和结论。"]
    ]
  } as const
  const template = input.template as keyof typeof configurations
  const steps: readonly (readonly [string, string, string, string])[] = configurations[template]
  if (!steps) throw Error("PROJECT_TEMPLATE_UNSUPPORTED")
  const definition: HarnessDefinition = {
    apiVersion: "devclaw.harness/v1",
    nodes: steps.map(([id, title, path]) => ({
      id,
      title,
      skill: `skills/${id}/SKILL.md`,
      approval: id === "review" ? "human" : "none",
      artifacts: [
        {
          id,
          path,
          example:
            id === "review"
              ? json({ summary: "仅验证样例结构；未执行业务", checked: true })
              : `# ${title}\n隔离样例\n`,
          ...(id === "review"
            ? {
                schema: {
                  type: "object",
                  required: ["summary", "checked"],
                  additionalProperties: false,
                  properties: {
                    summary: { type: "string", minLength: 1 },
                    checked: { const: true }
                  }
                }
              }
            : {})
        },
        ...(template === "harness-lite" && id === "review"
          ? [{ id: "reviewed", path: "reviewed.md", example: "# 复核版本\n隔离样例\n" }]
          : [])
      ]
    }))
  }
  return compileProjectHarness(
    createAuthoringSourceBundle([
      {
        path: "plugin.json",
        text: json({
          name: input.packageId,
          version: input.version ?? "0.1.0",
          description: input.name
        })
      },
      { path: HARNESS_SOURCE_PATH, text: json(definition) },
      ...steps.map(([id, title, path, instruction]) => ({
        path: `skills/${id}/SKILL.md`,
        text:
          `---\nname: ${input.packageId}-${id}\ndescription: ${title}\n---\n\n${instruction}\n\n` +
          `宿主提供项目工作区、目标与前序产物。缺少必要信息时先询问用户。当前节点产物为 ${path}${template === "harness-lite" && id === "review" ? " 和 reviewed.md" : ""}。\n` +
          (id === "review"
            ? '写入 {"summary":"实际检查范围、结论和未解决问题","checked":true}，仅在实际复核后填写。\n'
            : "") +
          "只报告真实执行结果。文件存在和结构通过不代表业务质量通过。审批与推进由宿主负责，不修改宿主状态或伪造验收。\n"
      })),
      {
        path: "README.md",
        text:
          `# ${input.name}\n\n编辑 devclaw.harness.json 的有序节点和 skills/*/SKILL.md。节点只描述 skill、必需产物、可选 JSON schema 和人工确认。example 是隔离测试文本，不会写入项目工作区。\n\n` +
          "修改节点后运行 openwork plugin compile <源码目录> --out <新目录>，再运行 doctor/test；AI 创作使用 project_compile(id,revision)。编译生成标准 devclaw.project-runtime.json 和逐个缺失产物/通过样例，实际测试使用宿主校验器。\n\n" +
          "复用业务能力通过 project_actions 与 project_bind_action 绑定已安装且授权的公开动作。重新编译保留绑定；不复制业务 hooks。测试不执行模型、技能或业务动作，也不证明代码或数据质量。\n"
      }
    ])
  )
}
