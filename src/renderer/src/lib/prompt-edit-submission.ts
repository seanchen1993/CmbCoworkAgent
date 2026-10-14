const preparing = new Set<string>()
type ValidatedDraft = { text: string; revision: number }

/** Holds only editor validation. The existing task/queue/command locks own the actual submit. */
export async function submitAfterPromptEdit<T>(
  threadId: string,
  options: {
    flush(): Promise<ValidatedDraft>
    read(): { text: string; revision: number }
    isConfirmed?(draft: ValidatedDraft): boolean
    assertCurrent?(): void
    submit(draft: { text: string; revision: number }): Promise<T>
  }
): Promise<T | undefined> {
  if (preparing.has(threadId)) return
  preparing.add(threadId)
  let submitted: Promise<T>
  try {
    // flush reserves the send intent synchronously, before its first await. A later
    // editor version belongs to the next message and must not replace this result.
    const confirmed = await options.flush()
    if (options.isConfirmed && !options.isConfirmed(confirmed))
      throw Error("MODS_PROMPT_EDIT_CONFLICT")
    options.assertCurrent?.()
    submitted = options.submit(confirmed)
  } finally {
    preparing.delete(threadId)
  }
  return submitted
}
