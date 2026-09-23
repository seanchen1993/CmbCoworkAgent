import { join } from "node:path"
import type { ModObject } from "../../../shared/mods/types"

/** Fixed host operation metadata, never a guest-selected file write or command. */
export function autobizCheckpointRequest(workspace: string, input: ModObject): ModObject {
  const names = ["evidenceId", "feature", "from", "to", "stateFingerprint", "idempotencyKey"]
  if (
    Object.keys(input).some((name) => !names.includes(name)) ||
    names.some(
      (name) =>
        typeof input[name] !== "string" || !input[name] || (input[name] as string).length > 256
    )
  )
    throw Error("MODS_AUTOBIZ_TRANSITION_ARGUMENTS")
  for (const name of ["feature", "from", "to"])
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input[name] as string))
      throw Error("MODS_AUTOBIZ_TRANSITION_ARGUMENTS")
  if (!/^[a-f0-9]{64}$/.test(input.stateFingerprint as string))
    throw Error("MODS_AUTOBIZ_TRANSITION_ARGUMENTS")
  return {
    ...Object.fromEntries(names.map((name) => [name, input[name]])),
    files: [
      join(workspace, ".autobizdevops", "state.json"),
      join(workspace, ".autobizdevops", "STATE.md")
    ]
  }
}
