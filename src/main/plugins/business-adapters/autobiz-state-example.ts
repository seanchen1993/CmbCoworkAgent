import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { bundledModExamplesRoot } from "../../mods/bundled-examples"
import { parseBusinessModCatalog } from "../business-mod-manifest"

export const autobizStateExample = {
  exampleId: "autobiz-state-machine",
  title: "AutoBiz 可执行状态决策",
  description:
    "普通 Function Mod 固定图决策、原产物与 Hooks 预检、原 writer 兼容提交和只读对账；不表示已接管全部旧入口。",
  kernelRef: { id: "autobiz.original-234-kernel", version: "1.0.3" }
} as const

/** Shipped plugin source only, using the same closed registry and native authoring review. */
export async function readAutobizStateExample(mainDirectory: string) {
  const namespace = "mods/business/autobiz.state-machine"
  const names = [
    "register.ts",
    "graph.ts",
    "adapter.py",
    "commit.py",
    "journal.py",
    "stage_checks.py",
    "hook_checks.py",
    "SKILL.md"
  ]
  const skillPath = `${namespace}/skills/autobiz-mod-state-control/SKILL.md`
  const root = bundledModExamplesRoot(mainDirectory)
  const files = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(root, "autobiz-state-machine", name), "utf8")
      if (Buffer.byteLength(text) > 64 * 1024)
        throw Error("BUSINESS_CREATOR_EXAMPLE_RESOURCE_LIMIT")
      return { path: name === "SKILL.md" ? skillPath : `${namespace}/${name}`, text }
    })
  )
  const catalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: autobizStateExample.kernelRef,
    modules: [],
    extensions: [
      {
        id: "autobiz.state-machine",
        title: autobizStateExample.title,
        kind: "function",
        entry: `${namespace}/register.ts`,
        resources: files
          .filter((file) => file.path !== `${namespace}/register.ts`)
          .map((file) => file.path),
        skills: [skillPath],
        dependencies: { required: [], advisory: [] },
        usage: "project"
      }
    ]
  })
  return {
    ...autobizStateExample,
    kind: "sdk-source-template",
    installed: false,
    execution: "requires-native-approved-business-trial",
    boundaries: [
      "The graph and original checks apply only to the declared fixed stages.",
      "Original initialization, feature creation, rollback and legacy direct-writer paths are not all intercepted.",
      "Windows NTFS compatibility commit is plugin-owned; it is not a platform-wide atomic file transaction or a native approval receipt.",
      "Preserve the exact original kernel, Hooks, configuration, knowledge and writer; do not weaken checks to make a trial pass."
    ],
    draft: {
      id: "autobiz-state-machine",
      name: autobizStateExample.title,
      modules: catalog.modules,
      extensions: catalog.extensions,
      files
    },
    instruction:
      "Inspect the actual installed compatible kernel first and verify its exact id/version/resources. Read all source pages, save this draft with that native inspectionId and revision:0, preserving all eight files and the auxiliary Skill. Preview with the original kernel plus this extension, then request_trial and await fresh native approval. Follow state_read, state_preflight, state_advance and state_reconcile with exact original state digest/requestKey. Source material is executable, but discovery, compilation or installation is not business success. Do not report committed without the real writer outcome and a fresh read; unknown is never replayed. This template grants no permissions and adds no platform state-machine API."
  }
}
