export interface DesignStyleSample {
  color: string
  background: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  padding: string
  gap: string
  borderRadius: string
  border: string
  boxShadow: string
}

export interface DesignStyleSnapshot {
  body: DesignStyleSample
  elements: Partial<
    Record<"heading" | "text" | "button" | "link" | "input" | "card", DesignStyleSample>
  >
  colors: string[]
  spacing: string[]
  radius: string[]
  viewport: { width: number; height: number }
}

/** Runs in the page's isolated world; reads computed styles, never form values or page text. */
export function extractDesignStyleSnapshot(): DesignStyleSnapshot {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    )
  }
  const sample = (element: Element): DesignStyleSample => {
    const style = getComputedStyle(element)
    return {
      color: style.color,
      background: style.backgroundColor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      padding: style.padding,
      gap: style.gap,
      borderRadius: style.borderRadius,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      boxShadow: style.boxShadow
    }
  }
  const nodes = [...document.querySelectorAll("body *")]
    .slice(0, 3000)
    .filter(visible)
    .slice(0, 400)
  const colors = new Map<string, number>(),
    spacing = new Map<string, number>(),
    radius = new Map<string, number>()
  const add = (map: Map<string, number>, value: string) => {
    if (value && !["none", "normal", "0px", "transparent", "rgba(0, 0, 0, 0)"].includes(value))
      map.set(value, (map.get(value) || 0) + 1)
  }
  for (const element of nodes) {
    const style = getComputedStyle(element)
    add(colors, style.color)
    add(colors, style.backgroundColor)
    for (const value of [
      style.paddingTop,
      style.paddingRight,
      style.paddingBottom,
      style.paddingLeft,
      style.rowGap,
      style.columnGap
    ])
      add(spacing, value)
    add(radius, style.borderRadius)
  }
  const top = (map: Map<string, number>, count: number) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([value]) => value)
  const selectors = {
    heading: "h1,h2,[role=heading]",
    text: "p,li",
    button: "button,[role=button]",
    link: "a[href]",
    input: "input:not([type=hidden]),textarea,select",
    card: "article,[class*=card],[class*=panel]"
  }
  const elements: DesignStyleSnapshot["elements"] = {}
  for (const [key, selector] of Object.entries(selectors)) {
    const element = [...document.querySelectorAll(selector)].find(visible)
    if (element) elements[key as keyof typeof elements] = sample(element)
  }
  return {
    body: sample(document.body || document.documentElement),
    elements,
    colors: top(colors, 8),
    spacing: top(spacing, 8),
    radius: top(radius, 6),
    viewport: { width: innerWidth, height: innerHeight }
  }
}

export function buildDesignSystemMarkdown(
  title: string,
  sourceUrl: string,
  snapshot: DesignStyleSnapshot
): string {
  const safeTitle =
    title
      .replace(/[\r\n#]/g, " ")
      .trim()
      .slice(0, 80) || "网页设计规范"
  const display = (values: string[]) =>
    values.length ? values.map((value) => `\`${value}\``).join("、") : "未观察到，请补充"
  const names = {
    heading: "标题",
    text: "正文",
    button: "按钮",
    link: "链接",
    input: "输入控件",
    card: "内容容器"
  }
  const components = Object.entries(names)
    .map(([key, name]) => {
      const item = snapshot.elements[key as keyof typeof names]
      return item
        ? `### ${name}\n\n- 字体：${item.fontFamily}；字号：${item.fontSize}；字重：${item.fontWeight}；行高：${item.lineHeight}\n- 前景：${item.color}；背景：${item.background}\n- 内边距：${item.padding}；间距：${item.gap}；圆角：${item.borderRadius}\n- 边框：${item.border}；阴影：${item.boxShadow}`
        : `### ${name}\n\n当前页面未观察到此类组件，请按产品需要补充。`
    })
    .join("\n\n")
  return `# ${safeTitle}\n\n来源：${sourceUrl}\n\n本规范根据网页当前状态的计算样式提取，是可编辑草稿；页面内容、登录信息和表单值不包含在规范中。\n\n## 色彩\n\n- 页面背景：${snapshot.body.background}\n- 正文颜色：${snapshot.body.color}\n- 常用颜色（按出现频率）：${display(snapshot.colors)}\n\n## 字体与排版\n\n- 基础字体：${snapshot.body.fontFamily}\n- 基础字号：${snapshot.body.fontSize}\n- 基础字重：${snapshot.body.fontWeight}\n- 基础行高：${snapshot.body.lineHeight}\n\n## 布局与间距\n\n- 抓取视口：${snapshot.viewport.width} × ${snapshot.viewport.height}px\n- 常用内边距和组件间距：${display(snapshot.spacing)}\n- 常用圆角：${display(snapshot.radius)}\n- 响应式断点与页面最大宽度无法从单一视口确定，请补充。\n\n## 组件规范\n\n${components}\n\n## 交互与待补充项\n\n静态样式不代表完整交互规范。请补充悬停、聚焦、禁用、加载、错误状态和动效规则，并检查对比度与键盘可访问性。\n`
}
