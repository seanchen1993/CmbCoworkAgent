export function getDrawElementLabel(element: Element | null): string {
  if (!element) return ""
  if (element === element.ownerDocument?.documentElement || element === element.ownerDocument?.body) return "page"

  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ""
  const classes = Array.from(element.classList ?? [])
    .filter((className) => !className.startsWith("__"))
    .slice(0, 2)
    .map((className) => `.${className}`)
    .join("")
  const label = element.getAttribute("aria-label") || element.getAttribute("alt") || ""
  const text = (label || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)
  return `${tag}${id}${classes}${text ? ` '${text}'` : ""}`
}
