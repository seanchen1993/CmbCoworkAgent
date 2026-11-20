/** The original Runtime's free-form choices are provided by the client's text field. */
export function isFreeformUserInputOption(label: string): boolean {
  const normalized = label.trim().toLowerCase()
  const compact = normalized.replace(/[\s\p{P}\p{S}]/gu, "")

  return (
    /^(其他|其它|other)(?:[\s:：,，、\-—_].+|[（(].+[）)])?$/iu.test(normalized) ||
    /^(不对|不是这样).*(补充|说明|填写|自定义)/u.test(compact) ||
    /^(我来)?(补充|自定义|填写).*/u.test(compact) ||
    /^(以上都不|以上均不|都不是|无上述|没有合适)/u.test(compact)
  )
}
