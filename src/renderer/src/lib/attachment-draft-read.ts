/** Preserve draft ownership across a dialog, a browser File read, or a parser IPC. */
export async function readForCurrentAttachmentDraft<T>(
  isCurrent: () => boolean,
  read: () => Promise<T>
): Promise<T | undefined> {
  if (!isCurrent()) return undefined
  const result = await read()
  return isCurrent() ? result : undefined
}
