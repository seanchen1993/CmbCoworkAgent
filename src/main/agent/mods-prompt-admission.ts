import { ModFunctionError } from "../../shared/mods/v2/contracts"

/** Acceptance is durable fact; a best-effort transcript write is insufficient for next(). */
export function persistAcceptedComposerPrompt(
  id: string,
  text: string,
  write: () => void,
  read: () => { role: string; content: unknown } | undefined
): void {
  if (!id || !text.trim()) throw new ModFunctionError("MODS_PROMPT_SUBMIT_EMPTY")
  write()
  const stored = read()
  if (!stored || stored.role !== "user" || stored.content !== text)
    throw new ModFunctionError("MODS_PROMPT_SUBMIT_PERSISTENCE")
}
