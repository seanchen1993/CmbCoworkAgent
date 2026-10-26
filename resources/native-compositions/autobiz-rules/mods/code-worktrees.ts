import { createCodeEvidenceReader } from "./code-evidence-reader"
/** Follow only the original inspect API's bounded resource pages. */
export async function readCodeWorktrees($, envelope, run, reader?) {
  const inspect = reader ?? await createCodeEvidenceReader($)
  if (
    !Number.isInteger(run.worktreeCount) ||
    run.worktreeCount < 1 ||
    run.worktreeCount > 8 ||
    run.worktreeOffset !== 0 ||
    !Array.isArray(run.worktrees) ||
    !run.worktrees.length
  )
    throw Error("AUTOBIZ_CODE_RESOURCE_PAGE_INVALID")
  const trees = [...run.worktrees]
  let offset = run.nextWorktreeOffset
  let previous = 0
  for (let page = 0; offset !== null; page++) {
    if (
      page >= 8 ||
      !Number.isInteger(offset) ||
      offset <= previous ||
      offset !== trees.length ||
      offset >= run.worktreeCount
    )
      throw Error("AUTOBIZ_CODE_RESOURCE_PAGE_INVALID")
    const receipt = await inspect(
      { runId: run.runId, worktreeOffset: offset, actionOffset: 0, limit: 32 },
      envelope.executionId + ":code-worktrees:" + offset
    )
    const current = receipt.value?.run
    if (
      receipt.status !== "succeeded" ||
      !receipt.value?.found ||
      !current ||
      current.runId !== run.runId ||
      current.status !== "completed" ||
      current.scriptSha256 !== run.scriptSha256 ||
      current.resultTruncated ||
      JSON.stringify(current.result) !== JSON.stringify(run.result) ||
      current.actionCount !== run.actionCount ||
      current.worktreeCount !== run.worktreeCount ||
      current.worktreeOffset !== offset ||
      !Array.isArray(current.worktrees) ||
      !current.worktrees.length ||
      current.worktrees.length > run.worktreeCount - offset
    )
      throw Error("AUTOBIZ_CODE_RESOURCE_PAGE_CHANGED")
    trees.push(...current.worktrees)
    previous = offset
    offset = current.nextWorktreeOffset
  }
  if (
    trees.length !== run.worktreeCount ||
    new Set(trees.map((tree) => tree.id)).size !== trees.length
  )
    throw Error("AUTOBIZ_CODE_RESOURCE_PAGE_INCOMPLETE")
  return trees
}
