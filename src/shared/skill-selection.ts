/** Feature selection, not a filesystem/tool permission boundary. Undefined/null means all. */
export function intersectSkillNames(
  ...selections: Array<readonly string[] | null | undefined>
): string[] | undefined {
  let result: string[] | undefined
  for (const selection of selections) {
    if (selection == null) continue
    const names = new Set(selection)
    result = result === undefined ? [...names] : result.filter((name) => names.has(name))
  }
  return result
}
