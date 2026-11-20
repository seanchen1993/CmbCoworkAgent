/** This checks a tool invocation against the user's words. It never routes an incoming message. */
export function requestedBotSkill(text: string, catalog: readonly string[], hint?: string): string {
  // A quoted reply or attachment is stripped by the host. Examples in a code block or a
  // Markdown quote are reference data too. Keep inline code around an actual skill name.
  const request = text.replace(/^\s*>\s?.*$/gm, "").replace(/```[\s\S]*?(?:```|$)/g, "")
  if (/(?:只(?:想|是)?(?:问|了解|知道|解释)|\b(?:just (?:explain|tell me|asking)|how (?:do|can|should) I use)\b)/iu.test(request))
    throw new Error("当前请求没有要求执行技能。查询技能说明可以直接回答。")

  const matched = new Set<string>()
  for (const name of new Set(hint ? [...catalog, hint] : catalog)) {
    if (!request.includes(name)) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const word = new RegExp("(?<![\\w./\\\\-])" + escaped + "(?![\\w./\\\\-])", "gu")
    for (const match of request.matchAll(word)) {
      const before = request.slice(0, match.index).replace(/[\s`「“"']+$/u, "")
      const after = request.slice(match.index + name.length).replace(/^[\s`」”"']+/u, "")
      const use = /(?:使用|调用|选用|采用|运用|启用|执行|运行|按照|用|按|\b(?:use|using|run|apply|invoke)(?:\s+(?:the|skill))?)(?:\s*(?:这个|一下|技能))?$/iu.test(before)
      const namedAction = /^(?:技能|skill\b)?\s*(?:来|帮我|处理|生成|整理|制作|更新|继续|执行|运行|to\s+\w+)/iu.test(after)
      if (!use && !namedAction) continue
      if (/(?:不(?:要|想|必|能|需要)?|别|无需|禁止|避免|without|never|don['’]t|do not)\s*(?:再|去)?\s*(?:使用|调用|选用|采用|执行|运行|用|按|use|using|run|apply)?\s*$/iu.test(before)) continue
      if (/^(?:技能|skill\b)?\s*(?:需要(?:哪些|什么|准备)|是什么|怎么用|的用法|有什么|能做什么)/iu.test(after)) continue
      matched.add(name)
    }
  }
  if (matched.size > 1) throw new Error("本条请求点名了多个技能，请先确认这项工作要使用哪一个。")
  const [name] = matched
  if (!name || (hint && hint !== name)) throw new Error("请使用本条请求中明确要求执行的技能名称。")
  return name
}
