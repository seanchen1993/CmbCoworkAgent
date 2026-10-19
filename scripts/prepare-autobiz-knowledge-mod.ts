import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/** Materialize a portable source Mod. Existing output is never overwritten. */
export async function prepareAutobizKnowledgeMod(output: string, kernelVersion = "1.0.0") {
  if (!["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"].includes(kernelVersion))
    throw Error("Unsupported reviewed kernel version")
  const repository = resolve(__dirname, "..")
  const namespace = "mods/business/autobiz.knowledge"
  const assets = [
    ["resources/mods/autobiz-knowledge/register.ts", `${namespace}/register.ts`],
    ["resources/mods/autobiz-context-provider.py", `${namespace}/provider.py`],
    [
      "resources/mods/autobiz-knowledge/validate-knowledge-draft.py",
      `${namespace}/validate-knowledge-draft.py`
    ],
    [
      "resources/mods/autobiz-knowledge/skills/knowledge-sync/SKILL.md",
      `${namespace}/skills/knowledge-sync/SKILL.md`
    ]
  ]
  const files = [
    [
      "plugin.json",
      JSON.stringify(
        {
          name: "autobiz-knowledge-support",
          version: kernelVersion,
          description: "只读知识绑定、宿主缓存同步与有证据的知识沉淀草稿"
        },
        null,
        2
      )
    ],
    [
      "mods/business/manifest.json",
      JSON.stringify(
        {
          apiVersion: "devclaw.business-mods/v1",
          kind: "catalog",
          kernelRef: { id: "autobiz.python-kernel", version: kernelVersion },
          modules: [],
          extensions: [
            {
              id: "autobiz.knowledge",
              title: "AutoBiz 知识与上下文",
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
        },
        null,
        2
      )
    ],
    ...(await Promise.all(
      assets.map(async ([source, target]) => [
        target,
        await readFile(join(repository, source), "utf8")
      ])
    ))
  ]
  await mkdir(output, { recursive: false })
  for (const [path, text] of files) {
    const target = join(output, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${text}\n`, { flag: "wx" })
  }
  return { directory: resolve(output), files: files.length }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-knowledge-mod.ts")
) {
  const output = process.argv[2]
  if (!output) throw Error("请指定一个尚不存在的输出目录")
  void prepareAutobizKnowledgeMod(resolve(output))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
