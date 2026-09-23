/** Upstream contract artifacts only; never a substitute for real business acceptance. */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { withPinnedAutobiz } from "../../src/main/mods/v2/autobiz-source"
const execute = promisify(execFile)

export async function writeArtifacts(
  root: string,
  options: { report?: string; removeProposal?: boolean } = {}
) {
  const featureDir = join(root, ".autobizdevops", "features", "order-export")
  await mkdir(join(featureDir, "specs", "orders"), { recursive: true })
  const proposal = `# Order export\n\n## Why\nThe export needs a stable contract.\n\n## What Changes\nAdd the order export contract.\n\n## Capability Index\n| Capability ID | Name | Operations | Path | Status |\n| --- | --- | --- | --- | --- |\n| CAP-orders | orders | ADDED | specs/orders/spec.md | planned |\n\n## Impact\nNo external impact.\n\n## Out of Scope\nNo migration.\n`
  if (!options.removeProposal) await writeFile(join(featureDir, "proposal.md"), proposal)
  await writeFile(
    join(featureDir, "specs", "orders", "spec.md"),
    `# Orders\n\nCapability-ID: \`CAP-orders\`\n\n## ADDED Requirements\n\n### REQ-orders-001: Export orders\n\n#### SCN-orders-001-01: Export succeeds\n- **WHEN** an order is ready\n- **THEN** it appears in the export\n`
  )
  await writeFile(
    join(featureDir, "design.md"),
    `# Design\n\n## Context / 输入上下文\nfixture\n\n## Code Evidence\nfixture\n\n## Spec Traceability\nREQ-orders-001\n\n## API Decisions\n| ID | Decision | |\n| --- | --- |\n| API-1 | none | |\n\nx-auto-no-http-api: true\n\n## Data Decisions\n| ID | Decision | |\n| --- | --- |\n| DATA-1 | none | |\n\nx-auto-no-sql: true\n\n## Technical Design\nfixture\n\n## Risks / Open Questions\nnone\n`
  )
  await writeFile(
    join(featureDir, "PLAN.md"),
    `# PLAN\n\n## 任务总览\n| ID | 状态 |\n| --- | --- |\n| T1 | 待做 |\n\n## 任务详情\n- T1\n  - **状态:** 待做\n  - **完成记录:** 无\n\n## Contract Coverage\n- REQ-orders-001 -> T1\n`
  )
  if (options.report !== undefined)
    await writeFile(join(featureDir, "REQUIREMENTS_EVAL.md"), options.report)
  return featureDir
}

export async function canonicalizeState(root: string) {
  await withPinnedAutobiz(undefined, async (source) => {
    await execute(
      "python",
      [
        "-I",
        "-B",
        "-c",
        "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from board_core.state_store import check_or_fix_state_sync; r=check_or_fix_state_sync(Path(sys.argv[2]), fix=True); assert not r.errors, r.errors",
        source,
        root
      ],
      { windowsHide: true }
    )
  })
}
