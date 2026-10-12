import { queryFunctionSessionRead as query } from "./session-read-core"
import { readColdFunctionSession } from "./session-cold-read"
export { compactFunctionSession } from "./session-read-core"
type Args = Parameters<typeof query>
export function queryFunctionSessionRead(
  manager: Args[0],
  assertPlainThread: Args[1],
  assertWorkspace: Args[2],
  workspace: Args[3],
  threadId: Args[4],
  method: Args[5],
  signal: Args[6],
  readCold = readColdFunctionSession,
  usageArgs: Args[8] = {}
) {
  return query(
    manager,
    assertPlainThread,
    assertWorkspace,
    workspace,
    threadId,
    method,
    signal,
    readCold,
    usageArgs
  )
}
