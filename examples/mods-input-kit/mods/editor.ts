export function register(on) {
  on("prompt.edit", {}, async (_$, edit, next) => {
    const result = await next({ ...edit, inputText: edit.inputText.toUpperCase() })
    return { ...result, decorations: result.text.length ?
      [{ start: 0, end: Math.min(5, result.text.length), color: "warning", underline: true }] : [] }
  })
}
