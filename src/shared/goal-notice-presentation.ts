export function parseGoalNoticeText(text: string): {
  title: string
  meta?: string
  rows: Array<{ label?: string; text: string }>
  actions: string[]
} | null {
  const cleanText = text.replace(/^●\s*/, "").replace(/^(?:Ⅱ|✓)\s*/, "").trim()
  const lines = cleanText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return null

  const first = lines[0]
  if (
    !first.startsWith("Goal ") &&
    !first.startsWith("继续 Goal") &&
    !first.startsWith("当前没有 active goal") &&
    !first.startsWith("没有可继续的 goal") &&
    !first.startsWith("请写明 goal 目标") &&
    !first.startsWith("附件和显式技能不会用于 /goal 控制命令") &&
    !first.startsWith("该 /goal 命令") &&
    !first.startsWith("当前线程正在运行") &&
    !first.startsWith("你发送了新消息，active goal 已暂停")
  ) {
    return null
  }

  const rows: Array<{ label?: string; text: string }> = []
  const actions: string[] = []

  const pushActionText = (text: string): void => {
    const normalized = text.replace(/[。.\s]+$/g, "")
    for (const part of normalized.split(/[，,、；;·]/)) {
      const trimmed = part.trim().replace(/^(可用|需要继续时发送|稍后发送|补充信息后请发送|用)\s*/, "")
      if (trimmed.includes("/goal")) actions.push(trimmed)
    }
  }

  const pushCommandSentence = (sentence: string): boolean => {
    const commandIndex = sentence.indexOf("/goal")
    if (commandIndex < 0) return false
    const prefix = sentence
      .slice(0, commandIndex)
      .replace(/[，,；;\s]+$/g, "")
      .trim()
    const command = sentence.slice(commandIndex).replace(/[。.\s]+$/g, "").trim()
    if (prefix && !/^(用|可用|需要继续时发送|稍后发送|补充信息后请发送)$/.test(prefix)) {
      rows.push({ text: prefix })
    }
    if (command) actions.push(command)
    return true
  }

  const pushActionLine = (line: string): boolean => {
    if (!line.includes("/goal")) return false
    pushActionText(line)
    return true
  }

  const splitSentences = (body: string): string[] =>
    body
      .split(/(?<=[。.!！?？])\s*/)
      .map((item) => item.trim())
      .filter(Boolean)

  const pushBodySentences = (body: string): void => {
    for (const sentence of splitSentences(body)) {
      if (pushCommandSentence(sentence)) continue
      rows.push({ text: sentence.replace(/[。.\s]+$/g, "").trim() })
    }
  }

  const setMatch = first.match(/^Goal 已设置(?:（([^）]+)）)?[。.]?\s*(.*)$/)
  if (setMatch) {
    const body = setMatch[2]?.trim() || ""
    const actionIndex = body.indexOf("可用")
    const description =
      actionIndex >= 0 ? body.slice(0, actionIndex).replace(/[；;，,\s]+$/g, "").trim() : body
    const actionText = actionIndex >= 0 ? body.slice(actionIndex) : ""
    if (description) rows.push({ text: description })
    if (actionText) pushActionText(actionText)
    return { title: "Goal 已设置", meta: setMatch[1], rows, actions }
  }

  const noActiveMatch = first.match(/^当前没有 active goal[。.]?\s*(.*)$/)
  if (noActiveMatch) {
    const body = noActiveMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "当前没有 active goal", rows, actions }
  }

  if (first === "没有可继续的 goal。" || first === "没有可继续的 goal") {
    return { title: "没有可继续的 goal", rows, actions }
  }

  const invalidGoalMatch = first.match(/^(请写明 goal 目标\/完成条件)[，,。.]?\s*(.*)$/)
  if (invalidGoalMatch) {
    const body = invalidGoalMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: "请写明 Goal 目标", rows, actions }
  }

  const transportControlMatch = first.match(
    /^(附件和显式技能不会用于 \/goal 控制命令)[，,。.]?\s*(.*)$/
  )
  if (transportControlMatch) {
    const body = transportControlMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: "Goal 控制命令未发送上下文", rows, actions }
  }

  const unavailableGoalMatch = first.match(/^该 \/goal 命令需要在当前运行结束后发送[。.]?$/)
  if (unavailableGoalMatch) {
    rows.push({ text: "当前运行结束后再发送该命令" })
    return { title: "Goal 命令暂不可用", rows, actions }
  }

  const preemptedGoalMatch = first.match(/^你发送了新消息，active goal 已暂停[。.]?\s*(.*)$/)
  if (preemptedGoalMatch) {
    const body = preemptedGoalMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "active goal 已暂停", rows, actions }
  }

  const goalBusyMatch = first.match(/^(Goal 正在进行中)[，,]\s*(.*)$/)
  if (goalBusyMatch) {
    const body = goalBusyMatch[2]?.trim()
    if (body) rows.push({ text: body.replace(/[。.\s]+$/g, "") })
    return { title: goalBusyMatch[1], rows, actions }
  }

  const completeMatch = first.match(/^✓?\s*(Goal 已完成)(?:\s*\(([^)]+)\))?[：:]\s*(.*)$/)
  if (completeMatch) {
    const reason = completeMatch[3]?.trim()
    if (reason) rows.push({ text: reason })
    return { title: completeMatch[1], meta: completeMatch[2], rows, actions }
  }

  const goalAlreadyMatch = first.match(/^(Goal (?:已完成|已经暂停))(?:[，,。.]?\s*)(.*)$/)
  if (goalAlreadyMatch && !goalAlreadyMatch[2]?.startsWith("：")) {
    const body = goalAlreadyMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: goalAlreadyMatch[1], rows, actions }
  }

  const threadBusyMatch = first.match(/^当前线程正在运行[，,]\s*(.*)$/)
  if (threadBusyMatch) {
    const body = threadBusyMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "当前线程正在运行", rows, actions }
  }

  const singleLineMatch = first.match(/^(Goal (?:等待补充信息|已暂停|已继续|当前状态|已清除))[：:]\s*(.*)$/)
  if (singleLineMatch) {
    const title = singleLineMatch[1]
    let body = singleLineMatch[2]?.trim() || ""
    const waitSplit = body.split("。补充信息后")
    if (waitSplit.length > 1) {
      body = waitSplit[0].trim()
      actions.push("/goal resume", "/goal clear")
    }
    if (body) rows.push({ text: body })
    return { title, rows, actions }
  }

  if (first.startsWith("Goal 已清除")) {
    const body = first.replace(/^Goal 已清除[。:：，,\s]*/, "").trim()
    if (body) rows.push({ text: body })
    return { title: "Goal 已清除", rows, actions }
  }

  const continueMatch = first.match(/^(继续 Goal)(?:\s*\(([^)]+)\))?[：:]\s*(.*)$/)
  if (continueMatch) {
    const body = continueMatch[3]?.trim()
    if (body) rows.push({ text: body })
    return { title: continueMatch[1], meta: continueMatch[2], rows, actions }
  }

  const title = first
  let meta: string | undefined
  for (const line of lines.slice(1)) {
    if (!meta && /^\d+s\s*·/.test(line)) {
      meta = line
      continue
    }
    if (pushActionLine(line)) continue
    const labeled = line.match(/^(目标|完成条件|最近评估|暂停原因)[：:]\s*(.*)$/)
    if (labeled) {
      rows.push({ label: labeled[1], text: labeled[2].trim() })
    } else {
      rows.push({ text: line })
    }
  }
  return { title, meta, rows, actions }
}



export function projectGoalNoticeVisibleText(text: string): string | null {
  const parsed = parseGoalNoticeText(text)
  if (!parsed) return null
  return [
    parsed.title,
    parsed.meta ?? "",
    ...parsed.rows.flatMap((row) => row.label ? [row.label, row.text] : [row.text]),
    ...parsed.actions
  ].filter(Boolean).join("\n")
}
