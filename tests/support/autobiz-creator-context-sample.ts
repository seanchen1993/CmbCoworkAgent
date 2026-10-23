import { execFile } from "node:child_process"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { prepareExtensionContext } from "../../src/main/harness-board/extension-context"
import { prepareAutobizCollectorFixture } from "./autobiz-collector-dependency-fixture"

const execute = promisify(execFile)

/** Original collector/render and a real read-only local knowledge source.
 * Only external application-type metadata is deterministic; no network is opened.
 */
export async function createAutobizSampleContext(source: string, workspace: string, root: string) {
  const knowledgeRoot = join(root, "knowledge")
  await mkdir(join(knowledgeRoot, "LA64"), { recursive: true })
  await writeFile(
    join(knowledgeRoot, "agents.manifest.json"),
    JSON.stringify({
      schemaVersion: "v1",
      systems: [
        {
          systemId: "LA64",
          systemName: "Controlled backend",
          agentsPath: "LA64/AGENTS.md",
          deployUnits: [{ deployUnitId: "LA64.05", description: "Controlled arithmetic sample" }]
        }
      ]
    })
  )
  await writeFile(
    join(knowledgeRoot, "LA64/AGENTS.md"),
    "# Backend rules\nCREATOR_KNOWLEDGE_MUST_SURVIVE: cover negative integers and reject non-integers.\n"
  )
  await writeFile(
    join(knowledgeRoot, "LA64/arithmetic.md"),
    "---\ntitle: Arithmetic constraints\ntype: Service Knowledge\ndeploy_unit: LA64.05\ndescription: CREATOR_KNOWLEDGE_MUST_SURVIVE\n---\nKeep the two capabilities independent and test the merged result.\n"
  )
  await writeFile(
    join(workspace, "AGENTS.md"),
    "# Workspace\nCREATOR_WORKSPACE_RULE_MUST_SURVIVE: preserve original artifact checks.\n"
  )
  const networkFixture = join(root, "metadata-fixture.cjs")
  await writeFile(
    networkFixture,
    `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
http.request=(options,callback)=>{if(options.hostname!=="archguardservice.paas.cmbchina.cn")throw Error("NETWORK_BLOCKED");
const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request};`
  )
  const originalCollector = join(source, "hooks/collect-knowledge.js")
  const invocation = {
    executable: "python",
    args: [
      "-I",
      "-B",
      "-X",
      "utf8",
      join(source, "hooks/render_collected_session_context.py"),
      "--selected-deployUnit",
      JSON.stringify([{ deployUnitId: "LA64.05" }]),
      "--session-workspace-path",
      workspace,
      "--node-command",
      process.execPath,
      "--knowledge-path",
      knowledgeRoot,
      "--knowledge-collector",
      originalCollector
    ]
  }
  const prepared = await prepareExtensionContext({
    sourceRoot: source,
    workspace,
    dataRoot: join(root, "data"),
    operation: "session-context",
    invocation,
    configuration: { directoryBinding: async () => knowledgeRoot }
  })
  const collector = prepared
    ? join(prepared.env.DEVCLAW_PLUGIN_DATA_ROOT, "collector")
    : join(root, "collector")
  prepareAutobizCollectorFixture(collector)
  let selected = prepared?.invocation ?? invocation
  if (!prepared) {
    await cp(originalCollector, join(collector, "collect-knowledge.js"))
    await cp(join(source, "hooks/package.json"), join(collector, "package.json"))
    selected = {
      ...invocation,
      args: invocation.args.map((arg) =>
        arg === originalCollector ? join(collector, "collect-knowledge.js") : arg
      )
    }
  }
  try {
    const result = await execute(selected.executable, selected.args, {
      cwd: source,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ...prepared?.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        npm_config_offline: "true",
        NODE_OPTIONS: `--require "${networkFixture.replace(/\\/g, "/")}"`
      }
    })
    await writeFile(join(root, "knowledge-render-stderr.txt"), result.stderr)
    const value = JSON.parse(result.stdout)
    if (
      value.ok !== true ||
      typeof value.sessionContext !== "string" ||
      !value.sessionContext.includes("CREATOR_KNOWLEDGE_MUST_SURVIVE") ||
      !value.sessionContext.includes("CREATOR_WORKSPACE_RULE_MUST_SURVIVE") ||
      !value.agentmdLoadStatus?.some((entry: { loaded: boolean }) => entry.loaded === true)
    )
      throw Error(`REAL_SAMPLE_KNOWLEDGE_NOT_LOADED: ${JSON.stringify(value)}`)
    const file = join(root, "actual-session-context.txt")
    await writeFile(file, value.sessionContext)
    await writeFile(join(root, "knowledge-result.json"), JSON.stringify(value, null, 2))
    // The native external-directory binding is read-only in the composed case.
    if (
      (await readFile(join(knowledgeRoot, "LA64/AGENTS.md"), "utf8")) !==
      "# Backend rules\nCREATOR_KNOWLEDGE_MUST_SURVIVE: cover negative integers and reject non-integers.\n"
    )
      throw Error("SAMPLE_KNOWLEDGE_SOURCE_CHANGED")
    return { file, text: value.sessionContext as string, knowledgeRoot }
  } finally {
    prepared?.release()
  }
}
