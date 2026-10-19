/** Controlled model decisions only. All tools, checkpoint receipts and files are produced
 * by the original app/CLI. In particular no state file or validation receipt is authored here. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface WarehouseExportStep {
  key: string
  name: "read_file" | "execute" | "project_checkpoint"
  args: Record<string, unknown>
}
export function warehouseExportProgram(input: {
  source: string
  workspace: string
  feature: string
  skill: string
  skillPath: string
  commands: Set<string>
}): WarehouseExportStep[] {
  const { source, workspace, feature, skill, skillPath, commands } = input
  const base = join(workspace, ".autobizdevops/features", feature)
  const stateBytes = readFileSync(join(workspace, ".autobizdevops/state.json"))
  const currentCheckpoint = JSON.parse(stateBytes.toString("utf8")).features[feature].checkpoint
  const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
  const read = (key: string, file_path: string): WarehouseExportStep => ({ key, name: "read_file", args: { file_path } })
  const execute = (key: string, script: string, args: string[]): WarehouseExportStep => {
    const command = ["python -I -B -X utf8", quote(script), ...args.map(quote)].join(" ")
    commands.add(command)
    return { key, name: "execute", args: { command, cwd: workspace } }
  }
  const checkpoint = (name: string): WarehouseExportStep => ({
    key: `checkpoint-${name}`, name: "project_checkpoint", args: {
      checkpoint: name,
      expectedStateDigest: createHash("sha256").update(stateBytes).digest("hex")
    }
  })
  const check = (id: string, operation: string) => execute(`${id}-${operation}`,
    join(source, `mods/business/${id}/check.py`), [operation, "--feature-dir", base])
  const sample = resolve("tests/support/autobiz-warehouse-input-sample.py")
  const steps = [read("read-original-skill", skillPath)]
  if (skill === "autobiz-requirement-discuss") {
    steps.push(execute("write-prd-input", sample, ["--plugin-root", source, "--workspace", workspace,
      "--feature", feature, "--step", "prd"]), checkpoint("prd_done"))
  } else if (skill === "autodev-specs") {
    steps.push(checkpoint("specs_in_progress"), execute("write-specs-input", sample,
      ["--plugin-root", source, "--workspace", workspace, "--feature", feature, "--step", "specs"]), checkpoint("specs_done"))
  } else if (skill === "warehouse-model") {
    steps.push(read("read-prd", join(base, "PRD.md")), checkpoint("warehouse_model_in_progress"),
      check("warehouse.model", "init-demo"), check("warehouse.model", "build"),
      read("read-model", join(base, "warehouse/MODEL.json")),
      read("read-input", join(base, "warehouse/INPUT.json")), checkpoint("warehouse_model_done"))
  } else if (skill === "warehouse-sql") {
    steps.push(read("consume-model", join(base, "warehouse/MODEL.json")),
      read("consume-input", join(base, "warehouse/INPUT.json")),
      read("consume-csv", join(base, "warehouse/orders.csv")), checkpoint("warehouse_sql_in_progress"),
      check("warehouse.sql", "run"), read("read-sql-execution", join(base, "warehouse/SQL_RUN.json")),
      read("read-sql-results", join(base, "warehouse/SQL_RESULTS.json")), checkpoint("warehouse_sql_done"))
  } else {
    assert.equal(skill, "warehouse-quality")
    steps.push(read("consume-sql-results", join(base, "warehouse/SQL_RESULTS.json")),
      read("consume-sql-run", join(base, "warehouse/SQL_RUN.json")), checkpoint("warehouse_quality_in_progress"),
      check("warehouse.quality", "check"), read("read-quality", join(base, "warehouse/QUALITY.json")),
      checkpoint("warehouse_quality_done"))
  }
  // The original controller may already have entered a stage. Never replay that transition.
  // A completed transition still needs its original host receipt for final composition proof.
  return steps.filter(step => step.name !== "project_checkpoint" || step.args.checkpoint !== currentCheckpoint)
}
