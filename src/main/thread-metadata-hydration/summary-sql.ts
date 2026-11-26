// Match the generated child ID, so imported threads with a plain "btw-" prefix stay visible.
const uuidGlob = [8, 4, 4, 4, 12].map(n => "[0-9a-fA-F]".repeat(n)).join("-")
export const THREAD_DIRECTORY_VISIBLE_SQL = `threads.thread_id NOT GLOB '[bB][tT][wW]-${uuidGlob}-${uuidGlob}'`

export const THREAD_SUMMARY_METADATA_SQL = `CASE
  WHEN metadata IS NULL THEN NULL
  WHEN json_valid(metadata) THEN json_remove(
    metadata,
    '$.llmFileHistory',
    '$.llmModifiedFiles',
    '$.llmRecentlyRevertedFiles'
  )
  ELSE '{}'
END`
