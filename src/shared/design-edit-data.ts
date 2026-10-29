/** Standalone data binding adapter for controlled React/Vue templates and exported HTML. */
export function designEditDataRuntime(): void {
  const w = window as unknown as { designData?: { get: (path: string) => unknown; data: unknown } }
  const read = () => {
    try {
      return (
        JSON.parse(
          document.querySelector('script[type="application/design-edit+json"]')?.textContent || "{}"
        ).data ?? {}
      )
    } catch {
      return {}
    }
  }
  w.designData = {
    get(path: string) {
      return path
        .split("/")
        .slice(1)
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce(
          (value, key) =>
            value && typeof value === "object" && Object.hasOwn(value, key)
              ? value[key]
              : undefined,
          read()
        )
    },
    get data() {
      return read()
    }
  }
}
export function installDesignEditDataRuntime(html: string): string {
  if (!/type=["']application\/design-edit\+json["']/.test(html)) return html
  html = html.replace(
    /<script\b[^>]*\bdata-design-edit-data-runtime[^>]*>[\s\S]*?<\/script\s*>/gi,
    ""
  )
  return html.replace(
    /(<script\b[^>]*type=["']application\/design-edit\+json["'][^>]*>[\s\S]*?<\/script\s*>)/i,
    `$1<script data-design-edit-data-runtime>(${designEditDataRuntime.toString().replace(/<\/script/gi, "<\\/script")})();</script>`
  )
}
