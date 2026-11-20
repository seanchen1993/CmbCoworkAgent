/** Strip legacy inline think blocks only when reasoning is already rendered separately. */
export function stripThinkBlocksForDisplay(text: string): string {
  const markerProbe = `${text.slice(0, 64)}${text.slice(-64)}`.toLocaleLowerCase()
  if (!markerProbe.includes("<think") && !markerProbe.includes("</think>")) return text
  const open = /<think>/gi
  const close = /<\/think>\s*/gi
  const visible: string[] = []
  let end = 0
  let block: RegExpExecArray | null
  while ((block = open.exec(text))) {
    close.lastIndex = open.lastIndex
    if (!close.exec(text)) break
    visible.push(text.slice(end, block.index))
    end = close.lastIndex
    open.lastIndex = end
  }
  visible.push(text.slice(end))
  const body = visible.join("")
  if (/^\s*<think>/i.test(body)) return ""
  close.lastIndex = 0
  return close.exec(body) ? body.slice(close.lastIndex) : body
}
