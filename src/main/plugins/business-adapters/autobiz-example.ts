import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { bundledModExamplesRoot } from "../../mods/bundled-examples"
import { parseBusinessModCatalog } from "../business-mod-manifest"

export const autobizKnowledgeExample = {
  exampleId: "autobiz-knowledge",
  title: "AutoBiz 知识与上下文",
  description:
    "Python 上下文提供器、只读知识配置和经真实校验的 knowledge-sync 知识草稿 Skill；不会自动发布远端。",
  kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" }
} as const

/** Only shipped SDK assets can be read here. This is source data, never an installer or authority. */
export async function readAutobizKnowledgeExample(mainDirectory: string) {
  const namespace = "mods/business/autobiz.knowledge"
  const assets = [
    ["autobiz-knowledge/register.ts", `${namespace}/register.ts`],
    ["autobiz-context-provider.py", `${namespace}/provider.py`],
    ["autobiz-knowledge/collector-gray-matter.cjs", `${namespace}/collector-gray-matter.cjs`],
    ["autobiz-knowledge/collector-THIRD-PARTY-NOTICES.md", `${namespace}/collector-THIRD-PARTY-NOTICES.md`],
    ["autobiz-knowledge/validate-knowledge-draft.py", `${namespace}/validate-knowledge-draft.py`],
    [
      "autobiz-knowledge/skills/knowledge-sync/SKILL.md",
      `${namespace}/skills/knowledge-sync/SKILL.md`
    ]
  ]
  const root = bundledModExamplesRoot(mainDirectory)
  const files = await Promise.all(
    assets.map(async ([asset, path]) => {
      const text = await readFile(join(root, asset), "utf8")
      if (Buffer.byteLength(text) > 64 * 1024)
        throw Error("BUSINESS_CREATOR_EXAMPLE_RESOURCE_LIMIT")
      return { path, text }
    })
  )
  const catalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: autobizKnowledgeExample.kernelRef,
    modules: [],
    extensions: [
      {
        id: "autobiz.knowledge",
        title: autobizKnowledgeExample.title,
        kind: "function",
        entry: `${namespace}/register.ts`,
        resources: assets.slice(1).map(([, target]) => target),
        skills: [`${namespace}/skills/knowledge-sync/SKILL.md`],
        dependencies: { required: [], advisory: [] },
        usage: "project",
        userConfig: {
          knowledgeRoot: {
            type: "directory",
            title: "只读知识目录",
            description: "可选。绑定已有知识时只读；留空使用宿主分配的同步缓存。",
            required: false
          }
        },
        contextProvider: {
          entry: `${namespace}/provider.py`,
          operations: ["session-context", "sync-knowledge"],
          knowledgeBinding: "knowledgeRoot",
          required: true
        }
      }
    ]
  })
  return {
    ...autobizKnowledgeExample,
    kind: "sdk-source-template",
    installed: false,
    draft: {
      id: "autobiz-knowledge",
      name: autobizKnowledgeExample.title,
      modules: catalog.modules,
      extensions: catalog.extensions,
      files
    },
    instruction:
      "Inspect the actual installed AutoBiz kernel first. Save draft with that inspectionId and revision:0; retain all declared files, auxiliary skills and contextProvider. The host binds the real kernel, and the original preview/review/approval still apply. This example does not install, grant access, publish knowledge remotely or prove project success."
  }
}
