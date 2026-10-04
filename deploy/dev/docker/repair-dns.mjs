import { readFile } from "node:fs/promises"
import { hostState, daemon, docker, colima } from "./host.mjs"

// Deliberately separate from vm-start: only the recorded one-off DNS repair
// script receives the user-authorized guest sudo, never generic provision.
export async function repairDns() {
  const state = await hostState()
  const before = await daemon(state)
  for (const args of [["ps", "-a", "-q"], ["volume", "ls", "-q"]]) {
    if (await docker(state, args, { stdoutOnly: true })) throw new Error("B00_DNS_REPAIR_IN_USE")
  }
  const input = await readFile(new URL("./repair-dns.sh", import.meta.url), "utf8")
  const result = await colima(state, ["ssh", "--", "sudo", "-n", "bash", "-s", "--", state.owner.id], { input, stdoutOnly: true, timeoutMs: 90000 })
  const after = await daemon(state)
  if (before.id !== after.id) throw new Error("B00_DAEMON_ID")
  return { result, daemon: after }
}
