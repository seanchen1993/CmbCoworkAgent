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
