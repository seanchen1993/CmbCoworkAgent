import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const PROJECT_SEARCH_FIXTURE_ADAPTER = "search-fixture"
export const PROJECT_SEARCH_FIXTURE_FEATURE_TITLE = "Offline Search Feature"

/** Real Board inspection, with a deterministic local adapter in the isolated test profile. */
export function installProjectSearchHarnessAdapter(dataRoot: string, featureSlug: string): string {
  const pluginRoot = join(dataRoot, "project-search-fixture-adapter")
  const configDir = join(pluginRoot, "board_core")
  mkdirSync(configDir, { recursive: true })
  const invocationLog = join(pluginRoot, "invocations.log")
  const script = join(pluginRoot, "inspect.cjs")
  const run = {
    featureId: featureSlug,
    featureName: PROJECT_SEARCH_FIXTURE_FEATURE_TITLE,
    currentNodeId: "plan",
    currentNodeStatus: "in_progress",
    nodeIds: ["plan"],
    nodes: [{ id: "plan", nodeStatus: "in_progress" }]
  }
  writeFileSync(script, [
    'const fs = require("node:fs")',
    'const [mode, ...dirs] = process.argv.slice(2)',
    'fs.appendFileSync(' + JSON.stringify(invocationLog) + ', mode + "\\n")',
    'const workflow = { nodes: [{ id: "plan", label: "Plan" }] }',
    'const run = ' + JSON.stringify(run),
    'const projects = Object.fromEntries(dirs.map((dir) => [dir, { runs: [run] }]))',
    'process.stdout.write(JSON.stringify(mode === "project" ? { workflow, projects } : { workflow, run }))'
  ].join("\n"))
  const quote = (path: string) => '"' + path.replace(/\\/g, "/") + '"'
  const command = quote(process.execPath) + " " + quote(script)
  writeFileSync(join(configDir, "board_config.json"), JSON.stringify({
    apiVersion: 1,
    inspectCommands: {
      [process.platform]: {
        project_status: command + " project $" + "{projectDirs...}",
        feature_status: command + " feature"
      }
    }
  }))
  writeFileSync(join(dataRoot, "plugins.json"), JSON.stringify([{
    id: PROJECT_SEARCH_FIXTURE_ADAPTER,
    name: PROJECT_SEARCH_FIXTURE_ADAPTER,
    path: pluginRoot,
    version: "1.0.0",
    enabled: true,
    description: "Local browser test fixture",
    author: "e2e",
    skillCount: 0,
    mcpServerCount: 0,
    createdAt: "",
    updatedAt: ""
  }]))
  return invocationLog
}
