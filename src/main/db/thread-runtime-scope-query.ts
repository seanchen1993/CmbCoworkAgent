// SQLite maintains this read-only expression in the same transaction as every thread write.
// Keep index creation and every indexed consumer identical; this is not an authority cache.
export const THREAD_RUNTIME_SCOPE_INDEX = "idx_threads_runtime_scope_v1"
export const THREAD_RUNTIME_SCOPE_EXPRESSION =
  "CASE WHEN json_valid(metadata) THEN json_remove(metadata, '$.llmFileHistory') ELSE metadata END"
