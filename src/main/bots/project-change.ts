import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { BotProjectFiles, ProjectFileChange } from "./project-files"

export function botProjectChangeAction(root: string, change: ProjectFileChange) {
  return {
    project: {
      root,
      path: change.path,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      diff: change.diff.slice(0, 48_000),
      diffTruncated: change.diff.length > 48_000
    }
  }
}

/** The ordinary project editor and exact skill-file copies share recovery evidence
 * and the same CAS writer; importing a skill cannot create a second write policy.
 */
export async function commitBotProjectChange(
  request: BotRuntimeRequest,
  files: BotArtifacts,
  project: BotProjectFiles,
  change: ProjectFileChange,
  id: string,
  check: () => void
): Promise<string> {
  request.store.localTools.assertStartedEffect(request.lease, id)
  check()
  const patch = await files.publish(
    {
      id: `${id}:patch`,
      conversationId: request.run.conversationId,
      runId: request.run.id,
      name: "project-change.patch",
      origin: "project",
      mime: "text/x-diff"
    },
    Buffer.from(change.diff),
    request.lease
  )
  let backup: string | null = null
  if (change.beforeBytes !== null)
    backup = (
      await files.publish(
        {
          id: `${id}:before`,
          conversationId: request.run.conversationId,
          runId: request.run.id,
          name: "project-before.txt",
          mime: "text/plain"
        },
        change.beforeBytes,
        request.lease
      )
    ).id
  const result = await project.commit(change, () => {
    request.store.localTools.assertStartedEffect(request.lease, id)
    check()
  })
  return JSON.stringify({ ...result, patchArtifactId: patch.id, beforeArtifactId: backup })
}
