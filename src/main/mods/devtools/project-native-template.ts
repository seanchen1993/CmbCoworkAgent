import { compileNativeComposition, type NativeComposition } from "../../plugins/native-composition"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import type { ProjectTemplateInput } from "./project-template"

/** Generic author source with real artifact contracts; no business adapter or provider is required. */
export function createNativeProjectTemplate(input: ProjectTemplateInput) {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const documentSchema = {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    properties: { content: { type: "string", minLength: 1 } }
  }
  const reviewSchema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "accepted"],
    properties: {
      summary: { type: "string", minLength: 1 },
      accepted: { const: true }
    }
  }
  const source: NativeComposition = {
    apiVersion: "devclaw.native-composition/v1",
    plugin: {
      id: input.packageId,
      version: input.version ?? "0.1.0",
      title: input.name,
      description: "可组合文档流程：起草、独立复核与成果确认。"
    },
    resources: ["tests/project-contract.json"],
    environment: [],
    modules: [
      {
        id: "draft",
        version: "1.0.0",
        title: "起草",
        skill: "modules/draft/SKILL.md",
        inputs: [],
        outputs: [{ id: "document", path: "document.json", contract: "document/v1" }],
        checks: [
          {
            id: "document-schema",
            kind: "json-schema",
            artifactId: "document",
            schema: documentSchema
          }
        ],
        approval: "none",
        resultApproval: "none"
      },
      {
        id: "review",
        version: "1.0.0",
        title: "复核与成果确认",
        skill: "modules/review/SKILL.md",
        inputs: [{ artifactId: "document", contract: "document/v1" }],
        outputs: [{ id: "review", path: "review.json", contract: "review/v1" }],
        checks: [
          { id: "review-schema", kind: "json-schema", artifactId: "review", schema: reviewSchema }
        ],
        approval: "none",
        resultApproval: "human"
      }
    ]
  }
  const document = { path: "document.json", text: json({ content: "示例文档" }) }
  const files = [
    {
      path: "modules/draft/SKILL.md",
      text: `---\nname: ${input.packageId}-draft\ndescription: 根据用户目标生成文档产物。\n---\n\n读取用户目标，缺少关键信息时通过原生输入请求询问。将实际文档写入 document.json，格式为 {"content":"文档正文"}。修改前读取已有文件，不编造用户要求。完成后由平台执行结构校验和状态提交，不自行修改运行状态。\n`
    },
    {
      path: "modules/review/SKILL.md",
      text: `---\nname: ${input.packageId}-review\ndescription: 复核前序文档并提交成果供用户确认。\n---\n\n读取 document.json 并对照用户目标。保留前序产物，不静默改写。将实际复核范围与结论写入 review.json，格式为 {"summary":"复核结论与限制","accepted":true}。发现不满足目标时写 accepted:false 并解释问题，不能为通过校验虚构成功。通过结构校验后仍须由用户确认实际成果，确认结果由平台保存。\n`
    },
    {
      path: "tests/project-contract.json",
      text: json({
        apiVersion: "devclaw.project-contract/v1",
        cases: [
          { id: "missing-document", stageId: "draft", files: [], expected: "failed" },
          { id: "valid-document", stageId: "draft", files: [document], expected: "passed" },
          {
            id: "review-refused",
            stageId: "review",
            files: [
              document,
              { path: "review.json", text: json({ summary: "仍存在问题", accepted: false }) }
            ],
            expected: "failed"
          },
          {
            id: "review-structure",
            stageId: "review",
            files: [
              document,
              { path: "review.json", text: json({ summary: "已完成复核", accepted: true }) }
            ],
            expected: "passed"
          }
        ]
      })
    }
  ]
  const compiled = compileNativeComposition(source, {
    files: files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
    actionCatalog: []
  })
  return createAuthoringSourceBundle(
    compiled.files.map((file) => ({
      path: file.path,
      text: file.bytes.toString("utf8")
    }))
  )
}
