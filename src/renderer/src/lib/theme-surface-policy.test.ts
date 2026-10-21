import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, describe, expect, it } from "vitest"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"

const RENDERER_ROOT = join(process.cwd(), "src/renderer/src")
const HTML_PREVIEW_LIGHT_CANVAS_RULE =
  /\.html-preview-light-canvas\s*\{\s*background-color:\s*#ffffff;\s*\}/

// These fixed backgrounds are intentionally decorative rather than application surfaces.
// Keying allowances by file and token, with a maximum count, prevents the exception from
// silently authorizing additional fixed-color UI in the same component.
const FIXED_DECORATIVE_SURFACE_ALLOWANCES: Readonly<Record<string, number>> = {
  "components/browser/BrowserScriptRecordingResultDialog.tsx:bg-slate-900": 1,
  "components/chat/ChatScrollNavigator.tsx:bg-[#0F766E]/10": 1,
  "components/chat/ChatScrollNavigator.tsx:bg-[#D97757]": 1,
  "components/chat/ChatScrollNavigator.tsx:bg-[#eb31ba]": 1,
  "components/chat/ChatScrollNavigator.tsx:dark:bg-[#2DD4BF]": 1,
  "components/chat/ChatScrollNavigator.tsx:dark:bg-[#2DD4BF]/15": 1,
  "components/chat/ChatScrollNavigator.tsx:dark:bg-[#E58A68]": 1,
  "components/chat/OutputStyleSwitcher.tsx:bg-slate-500/10": 1,
  "components/customize/EvolutionPanel.tsx:bg-zinc-400": 1,
  "components/customize/EvolutionPanel.tsx:bg-zinc-500/15": 2,
  "components/customize/EvolutionPanel.tsx:bg-zinc-500/30": 1,
  "components/customize/AppearancePanel.tsx:bg-[#c4c4c4]": 1,
  "components/customize/AppearancePanel.tsx:bg-[#cfcfcf]": 1,
  "components/customize/AppearancePanel.tsx:bg-[#d2d2d2]": 2,
  "components/customize/AppearancePanel.tsx:bg-[#dedede]": 1,
  "components/customize/AppearancePanel.tsx:bg-[#e2e2e2]": 1,
  "components/dashboard/panels/AdvancedFeaturesPanel.tsx:bg-slate-500": 1,
  "components/dashboard/panels/AdvancedFeaturesPanel.tsx:bg-stone-800": 1,
  "components/dashboard/panels/OverviewPanel.tsx:bg-zinc-500": 1,
  "components/git/TaskCardPicker.tsx:bg-slate-400": 1,
  "components/ui/toggle-thumb.tsx:bg-[#fff]": 1
}

type RendererFile = { file: string; source: string }
const FILE_CONCURRENCY = 8
const isRendererSource = (file: string) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts")

async function readRendererSnapshot(): Promise<RendererFile[]> {
  const directories = [RENDERER_ROOT]
  const files: string[] = []
  while (directories.length) {
    const batch = await Promise.all(
      directories.splice(0, FILE_CONCURRENCY).map(async (directory) => ({
        directory,
        entries: await readdir(directory, { withFileTypes: true })
      }))
    )
    for (const { directory, entries } of batch)
      for (const entry of entries) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) directories.push(file)
        else if (isRendererSource(file) || file.endsWith(".css")) files.push(file)
      }
  }
  const snapshot: RendererFile[] = []
  // Bound pending IO and preserve deterministic ordering across assertions and platforms.
  files.sort()
  for (let index = 0; index < files.length; index += FILE_CONCURRENCY)
    snapshot.push(
      ...(await Promise.all(
        files.slice(index, index + FILE_CONCURRENCY).map(async (file) => ({
          file,
          source: await readFile(file, "utf8")
        }))
      ))
    )
  return snapshot
}

function isBrightSurfaceColor(red: number, green: number, blue: number, alpha = 1): boolean {
  return alpha >= 0.25 && red >= 215 && green >= 215 && blue >= 215
}

describe("theme surface policy", () => {
  let rendererSources: RendererFile[]
  let rendererStyles: RendererFile[]
  let rendererContents: Map<string, string>
  const sourcesUnder = (directory: string) =>
    rendererSources.filter(
      ({ file }) => file.startsWith(directory + "/") || file.startsWith(directory + "\\")
    )
  const readRendererFile = (file: string) => {
    const source = rendererContents.get(file)
    if (source === undefined) throw Error(`Renderer source was not captured: ${file}`)
    return source
  }

  beforeAll(async () => {
    const snapshot = await readRendererSnapshot()
    rendererSources = snapshot.filter(({ file }) => isRendererSource(file))
    rendererStyles = snapshot.filter(({ file }) => file.endsWith(".css"))
    rendererContents = new Map(snapshot.map(({ file, source }) => [file, source]))
  })

  it("pairs legacy light status surfaces with a dark override", () => {
    const lightSurface =
      /bg-(?:slate|gray|zinc|stone|neutral|red|orange|amber|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200)(?!\d)(?:\/[0-9]+)?/
    const violations = rendererSources.flatMap(({ file, source }) =>
      source
        .split("\n")
        .map((line, index) => ({ file, line, lineNumber: index + 1 }))
        .filter(
          ({ line }) =>
            lightSurface.test(line) &&
            !line.includes("dark:bg-") &&
            !line.includes("dark:hover:bg-")
        )
    )

    expect(violations).toEqual([])
  })

  it("keeps component CSS surfaces on semantic theme tokens", () => {
    const violations = rendererStyles.flatMap(({ file, source }) => {
      const css = source.replace(HTML_PREVIEW_LIGHT_CANVAS_RULE, "")
      const runtimeCss = file.endsWith("index.css")
        ? css.replace(/:root\s*\{[\s\S]*?\n\}/, "")
        : css

      return [...runtimeCss.matchAll(/background(?:-color)?\s*:\s*([^;]+);/gi)].flatMap((match) => {
        const value = match[1]
        const brightHex = [...value.matchAll(/#([0-9a-f]{6})\b/gi)].some((color) => {
          const number = Number.parseInt(color[1], 16)
          return isBrightSurfaceColor(number >> 16, (number >> 8) & 255, number & 255)
        })
        const brightRgb = [
          ...value.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/gi)
        ].some((color) =>
          isBrightSurfaceColor(
            Number(color[1]),
            Number(color[2]),
            Number(color[3]),
            color[4] === undefined ? 1 : Number(color[4])
          )
        )
        const mixesWhiteIntoCanvas = /color-mix\([^;]*\bwhite\b[^;]*var\(--background\)/i.test(
          value
        )

        return brightHex || brightRgb || mixesWhiteIntoCanvas
          ? [{ file, declaration: match[0] }]
          : []
      })
    })

    expect(violations).toEqual([])
  })

  it("keeps known rich-content surfaces theme-driven", () => {
    const css = rendererStyles.map(({ source }) => source).join("\n")
    const selectors = [
      ".streaming-markdown-inline-code",
      ".streaming-markdown-code-block",
      ".markdown-preview pre",
      ".markdown-preview code:not(pre code)",
      ".market-update-badge",
      ".shiki-wrapper"
    ]

    for (const selector of selectors) {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`))?.[1]
      expect(rule, `${selector} must exist`).toBeDefined()
      expect(rule, `${selector} must use theme variables`).toContain("var(--")
    }
  })

  it("rejects fixed light canvases in renderer components", () => {
    const componentRoots = [join(RENDERER_ROOT, "components"), join(RENDERER_ROOT, "features")]
    const fixedLightCanvas =
      /useDarkTheme=\{false\}|theme:\s*["']github-light["']|\bbg-\[rgba\(255,255,255|\bbg-white\b|\btext-black\b|background(?:Color)?:\s*["'](?:white|#fff(?:fff)?)["']/gi
    const violations = componentRoots.flatMap((root) =>
      sourcesUnder(root).flatMap(({ file, source: content }) => {
        const source = content.replace(/dark:(?:hover:)?bg-white(?:\/(?:\[[^\]]+\]|\d+))?/g, "")
        return [...source.matchAll(fixedLightCanvas)].map((match) => ({
          file,
          value: match[0]
        }))
      })
    )

    expect(violations).toEqual([])
  })

  it("prevents new fixed-color application surfaces", () => {
    const componentRoots = [join(RENDERER_ROOT, "components"), join(RENDERER_ROOT, "features")]
    const fixedSourceSurface =
      /(?:(?:[a-z-]+):)*bg-(?:slate|gray|zinc|stone|neutral)-(?:50|100|200|300|400|500|600|700|800|900|950)(?!\d)(?:\/(?:\[[^\]]+\]|\d+))?|(?:(?:[a-z-]+):)*bg-\[(?:#[0-9a-f]{3,8}|rgba?\([^\]]+\))\](?:\/(?:\[[^\]]+\]|\d+))?|background(?:Color)?\s*:\s*["'](?:#[0-9a-f]{3,8}|rgba?\([^"']+\))["']/gi
    const usageCounts = new Map<string, number>()
    const sourceViolations = componentRoots.flatMap((root) =>
      sourcesUnder(root).flatMap(({ file, source: content }) => {
        const source = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, (comment) =>
          comment.replace(/[^\n]/g, " ")
        )
        const relativeFile = relative(RENDERER_ROOT, file).replace(/\\/g, "/")

        return source.split("\n").flatMap((line, index) =>
          [...line.matchAll(fixedSourceSurface)].flatMap((match) => {
            const token = match[0]
            const key = `${relativeFile}:${token}`
            const count = (usageCounts.get(key) ?? 0) + 1
            usageCounts.set(key, count)
            return count > (FIXED_DECORATIVE_SURFACE_ALLOWANCES[key] ?? 0)
              ? [{ file, lineNumber: index + 1, token }]
              : []
          })
        )
      })
    )

    const fixedCssSurface = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^;]+\))\s*;/gi
    const cssViolations = rendererStyles.flatMap(({ file, source }) => {
      let css = source.replace(HTML_PREVIEW_LIGHT_CANVAS_RULE, "")
      if (file.endsWith("index.css")) css = css.replace(/:root\s*\{[\s\S]*?\n\}/, "")
      return [...css.matchAll(fixedCssSurface)].map((match) => ({
        file,
        declaration: match[0]
      }))
    })

    expect([...sourceViolations, ...cssViolations]).toEqual([])
  })

  it("reserves the fixed light canvas for isolated HTML previews", () => {
    const skillsPanelPath = join(RENDERER_ROOT, "components/customize/SkillsPanel.tsx")
    const chatHtmlPreviewPath = join(RENDERER_ROOT, "components/chat/previews/HtmlPreview.tsx")
    const usages = rendererSources
      .filter(({ source }) => source.includes("html-preview-light-canvas"))
      .map(({ file }) => file)
    const skillsPanel = readRendererFile(skillsPanelPath)
    const chatHtmlPreview = readRendererFile(chatHtmlPreviewPath)
    const css = readRendererFile(join(RENDERER_ROOT, "index.css"))

    expect(usages).toEqual([chatHtmlPreviewPath, skillsPanelPath])
    expect(skillsPanel).toMatch(
      /previewKind === "html"[\s\S]{0,300}html-preview-light-canvas[\s\S]{0,300}srcDoc=/
    )
    expect(chatHtmlPreview).toMatch(
      /<iframe[\s\S]{0,300}srcDoc=[\s\S]{0,300}html-preview-light-canvas/
    )
    expect(css).toMatch(HTML_PREVIEW_LIGHT_CANVAS_RULE)
  })

  it("keeps inline SVG icons inheriting their semantic text color", () => {
    const invalidCurrentColor = /fill=["']curreColor["']/gi
    const violations = rendererSources.flatMap(({ file, source }) =>
      [...source.matchAll(invalidCurrentColor)].map((match) => ({
        file,
        value: match[0]
      }))
    )

    expect(violations).toEqual([])
  })

  it("keeps semantic status text stable on hover", () => {
    const statusHoverText = /(?:hover|group-hover):text-status-(?:critical|warning|nominal|info)\b/g
    const violations = rendererSources.flatMap(({ file, source }) =>
      [...source.matchAll(statusHoverText)].map((match) => ({
        file,
        value: match[0]
      }))
    )

    expect(violations).toEqual([])
  })

  it("keeps shared chrome roles separate from accent decoration", () => {
    const button = readRendererFile(join(RENDERER_ROOT, "components/ui/button.tsx"))
    const sidebar = readRendererFile(join(RENDERER_ROOT, "components/sidebar/ThreadSidebar.tsx"))
    const themeCss = readRendererFile(join(RENDERER_ROOT, "index.css"))

    expect(button).toContain("bg-button text-button-foreground")
    expect(sidebar).toMatch(
      /isSelected\s*\?\s*"bg-sidebar-accent text-sidebar-accent-foreground"\s*:\s*"hover:bg-sidebar-hover"/
    )
    expect(themeCss).toContain("--color-button: var(--button)")
    expect(themeCss).toContain("--color-sidebar-hover: var(--sidebar-hover)")
    expect(themeCss).toContain("--color-sidebar-accent: var(--sidebar-accent)")
  })

  it("keeps embedded code and diagram renderers on shared theme tokens", () => {
    const codeViewer = readRendererFile(join(RENDERER_ROOT, "components/tabs/CodeViewer.tsx"))
    const codeHighlightWorker = readRendererFile(
      join(RENDERER_ROOT, "components/tabs/code-highlight-worker.ts")
    )
    const scriptEditor = readRendererFile(
      join(RENDERER_ROOT, "components/browser/BrowserScriptEditor.tsx")
    )
    const taskMmd = readRendererFile(join(RENDERER_ROOT, "components/customize/TaskMmdPanel.tsx"))
    const claudeCode = readRendererFile(
      join(RENDERER_ROOT, "components/customize/ClaudeCodePanel.tsx")
    )

    expect(codeHighlightWorker).toContain("createCssVariablesTheme")
    expect(codeViewer).not.toContain("github-light")
    expect(codeHighlightWorker).not.toContain("github-light")
    expect(scriptEditor).not.toMatch(/bg-\[#[0-9a-f]{6}\]/i)
    expect(taskMmd).toContain("subscribeThemePreference")
    expect(taskMmd).not.toMatch(/primaryColor:\s*["']#/i)
    expect(claudeCode).toContain("flattenXtermColor(palette.mutedForeground, palette.background)")
  })

  it("keeps file-preview code blocks block-level and padded", () => {
    const themeCss = readRendererFile(join(RENDERER_ROOT, "index.css"))
    const rule = themeCss.match(/\.markdown-preview code\.hljs\s*\{([^}]+)\}/)?.[1]
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "```ts\nconst answer = 42\n```",
        showHeader: false,
        showModeToggle: false
      })
    )

    expect(markup).toMatch(
      /<div class="[^"]*markdown-preview[^"]*">[\s\S]*<code class="[^"]*hljs[^"]*language-ts[^"]*">/
    )
    expect(rule).toContain("display: block")
    expect(rule).toContain("overflow-x: auto")
    expect(rule).toContain("padding: 0.75rem")
  })

  it("keeps Recharts tooltip text paired with its themed surface", () => {
    const dashboardSource = sourcesUnder(join(RENDERER_ROOT, "components/dashboard"))
      .map(({ source }) => source)
      .join("\n")
    const themedTooltipSurfaces = [
      ...dashboardSource.matchAll(/backgroundColor:\s*["']var\(--color-card\)["']([\s\S]{0,180})/g)
    ]

    expect(themedTooltipSurfaces.length).toBeGreaterThan(0)
    for (const match of themedTooltipSurfaces) {
      expect(match[1]).toContain('color: "var(--color-foreground)"')
    }
  })

  it("keeps the embedded diff viewer connected to the active theme", () => {
    const source = readRendererFile(join(RENDERER_ROOT, "components/chat/DiffDisplay.tsx"))

    expect(source).not.toContain("useDarkTheme={false}")
    expect(source).not.toMatch(/diffViewerBackground:\s*["']#fff(?:fff)?["']/i)
    expect(source).toContain('diffViewerBackground: "var(--background-elevated)"')
    expect(source).toContain("dark: DIFF_VIEWER_THEME_VARIABLES")
    expect(source).toContain("subscribeThemePreference")
  })

  it("keeps the global toaster connected to the active application theme", () => {
    const source = readRendererFile(join(RENDERER_ROOT, "App.tsx"))

    expect(source).toContain("subscribeThemePreference")
    expect(source).toContain("getThemeDefinition(themePreference).colorScheme")
    expect(source).toContain("theme={toastTheme}")
    expect(source).not.toContain('theme="system"')
  })

  it("keeps context reminders distinct from ordinary unread indicators", () => {
    const source = readRendererFile(join(RENDERER_ROOT, "components/sidebar/ThreadSidebar.tsx"))
    const reminderPattern =
      /hasContextReminder(?:Thread)?[\s\S]{0,180}?<span\s+className="([^"]*\bsize-2\b[^"]*)"/g
    const unreadPattern =
      /(?:isUnread|unreadCount\s*>\s*0)[\s\S]{0,180}?<span\s+className="([^"]*\bsize-2\b[^"]*)"/g
    const reminderClasses = [...source.matchAll(reminderPattern)].map((match) => match[1])
    const unreadClasses = [...source.matchAll(unreadPattern)].map((match) => match[1])

    expect(reminderClasses).toHaveLength(2)
    expect(unreadClasses).toHaveLength(2)
    expect(
      reminderClasses.every((className) => className.includes("bg-status-warning-foreground"))
    ).toBe(true)
    expect(unreadClasses.every((className) => className.includes("bg-status-info"))).toBe(true)
  })

  it("keeps merged right-panel sizing and chat notices theme-aware", () => {
    const rightPanel = readRendererFile(join(RENDERER_ROOT, "components/panels/RightPanel.tsx"))
    const chatContainer = readRendererFile(join(RENDERER_ROOT, "components/chat/ChatContainer.tsx"))

    expect(rightPanel).toContain("const workspacePanelRef = useRef<HTMLDivElement>(null)")
    expect(rightPanel).toContain("workspacePanelRef.current.clientHeight")
    expect(rightPanel).toMatch(/ref=\{workspacePanelRef\}[\s\S]{0,120}workspace-info-panel/)
    expect(chatContainer).toContain(
      "border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-status-warning-foreground"
    )
    expect(chatContainer).toContain("border-status-warning/30 bg-status-warning/10 p-4")
    expect(chatContainer).not.toContain("border-amber-300/60 bg-amber-50/60")
    expect(chatContainer).not.toContain("border-amber-400/60 bg-amber-50/50")
  })
})
