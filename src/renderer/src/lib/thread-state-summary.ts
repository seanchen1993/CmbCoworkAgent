import type { Subagent } from "@/types"

export type KanbanSubagentSummary = Pick<
  Subagent,
  "id" | "name" | "description" | "status"
>

export function projectKanbanSubagents(
  subagents: readonly Subagent[],
  previousSubagents: readonly Subagent[] | undefined,
  previousProjection: readonly KanbanSubagentSummary[] | undefined
): readonly KanbanSubagentSummary[] {
  if (previousProjection && previousSubagents === subagents) return previousProjection

  const next = subagents.map(({ id, name, description, status }) => ({
    id,
    name,
    description,
    status
  }))
  if (
    previousProjection?.length === next.length &&
    next.every(
      (subagent, index) =>
        subagent.id === previousProjection[index].id &&
        subagent.name === previousProjection[index].name &&
        subagent.description === previousProjection[index].description &&
        subagent.status === previousProjection[index].status
    )
  ) {
    return previousProjection
  }
  return next
}
