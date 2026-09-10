/** Strip legacy inline think blocks only when reasoning is already rendered separately. */
export function stripThinkBlocksForDisplay(text: string): string {
  const markerProbe = `${text.slice(0, 64)}${text.slice(-64)}`.toLocaleLowerCase()
  if (!markerProbe.includes("<think") && !markerProbe.includes("</think>")) return text
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/^\s*<think>[\s\S]*$/i, "")
    .replace(/^[\s\S]*?<\/think>\s*/i, "")
}
