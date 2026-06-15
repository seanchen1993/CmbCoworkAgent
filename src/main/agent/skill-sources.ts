export function combineSkillMiddlewareSources(
  standaloneSkillSources: string[],
  pluginSkillSources: string[]
): string[] {
  return [...pluginSkillSources, ...standaloneSkillSources]
}
