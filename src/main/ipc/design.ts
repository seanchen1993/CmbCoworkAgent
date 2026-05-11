/**
 * Design IPC Handlers
 *
 * Streams Claude AI responses for the Design tab.
 * Uses the same ChatOpenAI streaming pattern as optimizer.ts.
 * The renderer sends a prompt, receives streamed text tokens,
 * and the final HTML is displayed in the canvas panel.
 */

import fs from "fs"
import path from "path"
import { ipcMain, BrowserWindow, app, net } from "electron"
import Store from "electron-store"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages"
import { deleteThreadCheckpoint, getCustomModelConfigs, getOpenworkDir } from "../storage"
import {
  closeCheckpointer,
  createAgentRuntime,
  createRetryingFetch,
  type ModelRetryHooks
} from "../agent/runtime"
import { isRetryableApiError } from "../agent/failover"
import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"

// ─────────────────────────────────────────────────────────
// System Prompt — Dynamic Questions Generation
// ─────────────────────────────────────────────────────────

const QUESTIONS_SYSTEM_PROMPT = `You are a design strategist. Analyze the user's design request carefully and generate 4–6 highly targeted clarifying questions that are SPECIFIC to what they asked — not generic design questions.

Return ONLY a valid JSON array. No markdown fences, no explanation, no preamble — just the raw JSON array.

## Question object schema

Each question object must have:
- "id": unique snake_case identifier
- "type": "text" | "textarea" | "chips"
- "label": question label in Chinese (specific to the request)
- "hint": optional helper text in Chinese — only include when genuinely useful
- "options": array of Chinese strings — required only for type "chips"
- "multi": boolean — for chips questions, set true if multiple selections make sense (e.g. features, sections, platforms), set false if only one answer is valid (e.g. product category, tone)

## Critical rules

1. **Read the request carefully** — if the user asks for a dashboard, ask about data types and KPIs, not generic style. If they ask for a mobile app, ask about key screens. If they ask for a landing page, ask about CTAs and sections. Never ask questions irrelevant to the task.
2. **No redundant questions** — don't ask for "brand name" if the request already contains one. Don't ask for "product type" if they clearly said it's a SaaS.
3. **Mix question types thoughtfully** — use "chips" for categorical choices, "multi:true chips" for features/sections (user may want several), "text" for names/short facts, "textarea" for descriptions or content.
4. **Options must be relevant and non-obvious** — tailor chip options to the domain, not generic catch-all lists.

## Examples of differentiated questions by request type

For "设计一个数据分析 dashboard":
[
  {"id":"metrics","type":"chips","label":"需要展示哪些核心指标？","options":["用户增长","收入趋势","转化率","留存率","活跃用户","漏斗分析","地域分布"],"multi":true},
  {"id":"data_period","type":"chips","label":"数据时间维度","options":["实时","日","周","月","季度","自定义范围"],"multi":false},
  {"id":"audience","type":"chips","label":"谁会看这个 dashboard？","options":["CEO/高管","产品经理","运营团队","技术团队","外部客户"],"multi":true},
  {"id":"chart_style","type":"chips","label":"图表风格偏好","options":["简洁线图","面积图","柱状图","混合多图","卡片数字为主"],"multi":false},
  {"id":"color_scheme","type":"chips","label":"配色方向","options":["深色主题","浅色商务","品牌色主导","中性灰调"],"multi":false}
]

For "设计一个移动 App 登录和注册流程":
[
  {"id":"app_name","type":"text","label":"App 名称是什么？","hint":"将显示在页面 logo 处"},
  {"id":"auth_methods","type":"chips","label":"支持哪些登录方式？","options":["手机号+验证码","邮箱+密码","微信一键登录","Apple 登录","Google 登录","人脸/指纹"],"multi":true},
  {"id":"app_tone","type":"chips","label":"App 的整体调性","options":["专业商务","年轻活泼","温暖治愈","极简高冷","科技感强"],"multi":false},
  {"id":"brand_color","type":"text","label":"品牌主色是什么？","hint":"如"#FF5C00"或"靛蓝色"，无品牌色可留空"},
  {"id":"extra_fields","type":"chips","label":"注册时需要收集哪些信息？","options":["昵称","头像","生日","性别","职业","兴趣标签","推荐码"],"multi":true}
]

For "帮我做一个产品宣传落地页":
[
  {"id":"product_name","type":"text","label":"产品或品牌名称","hint":"将作为页面标题展示"},
  {"id":"core_value","type":"textarea","label":"用一两句话描述产品核心价值","hint":"它解决什么痛点？为谁解决？"},
  {"id":"sections","type":"chips","label":"落地页需要包含哪些模块？","options":["Hero 大图","功能介绍","用户评价","定价方案","FAQ","团队介绍","合作品牌"],"multi":true},
  {"id":"cta","type":"text","label":"主要行动按钮的文案是什么？","hint":"如"免费试用"、"立即下载""},
  {"id":"style","type":"chips","label":"视觉风格方向","options":["极简留白","科技深色","插画轻松","商务稳重","大胆撞色"],"multi":false}
]`

// ─────────────────────────────────────────────────────────
// System Prompt — Claude Design style
// ─────────────────────────────────────────────────────────

const DESIGN_SYSTEM_PROMPT = `You are an expert designer working with the user as a manager. You produce design artifacts in HTML on behalf of the user.

You must embody an expert in the relevant domain: UX designer, prototyper, data visualizer, slide designer, animator — whatever the task demands. Avoid generic web design tropes unless the task is literally a webpage.

## Choosing the right medium

Before writing a single line of HTML, decide what format best serves the content:
- **Static visual exploration** (color, type, layout options) → lay variations side by side on a canvas
- **Interactions, flows, or complex UI** → build a hi-fi clickable prototype with working states
- **Data presentation** → design the chart/dashboard as the primary artifact
- **Animation** → make it move; use CSS keyframes or JS timelines

## Your output rules

1. **Always produce a complete HTML file** — the design artifact must start with \`<!DOCTYPE html>\`, end with \`</html>\`. No fragments, no partial snippets.
2. **Self-contained** — inline all CSS in \`<style>\` and all JS in \`<script>\`. CDN links for fonts or libraries are fine.
3. **Two variations** — unless told otherwise, always produce exactly **2 distinct variations** within a single HTML file:
   - **Variation A** — conventional, safe, closest to established patterns
   - **Variation B** — bold, novel, pushes the aesthetic or interaction in a surprising direction

   **CRITICAL — wrapping structure:**
   Each variation MUST be a direct child of \`<body>\`, carry the EXACT \`id\` attribute shown, AND a \`data-label\` attribute with a short, descriptive Chinese name (2–5 characters) that captures the visual personality of that variation — NOT generic labels like "方案A" or "变体一".

   Good \`data-label\` examples by context:
   - Color/theme variations: 极简白、暗夜深、暖橙调、薄荷绿、石墨灰
   - Layout variations: 居中聚焦、左右分栏、全屏沉浸
   - Style variations: 商务稳重、轻盈现代、大胆撞色、柔和治愈
   - Component variations: 卡片式、列表式、瀑布流
   Choose labels that instantly communicate what makes each variant distinct.

   Structure:
   <body>
     <div id="variation-a" data-label="极简留白"> ALL of Variation A content here </div>
     <div id="variation-b" data-label="暗夜沉浸"> ALL of Variation B content here </div>
   </body>
   - Do NOT nest variations inside any other wrapper element.
   - Each variation div must be fully self-contained (complete UI, no shared DOM between variations).
   - Shared CSS/JS in \`<head>\` is fine — it will be inherited by each split view.

4. **No filler content** — every element must earn its place. Never pad with placeholder stats, dummy icons, or lorem ipsum sections. Less is more.

## Design quality bar

**Colors**: Use \`oklch()\` to define harmonious palettes instead of raw hex. Match any brand context given. No aggressive gradients.

**Typography**: Commit to a clear type scale. Never use Inter, Roboto, or Arial — pick something with character (e.g. DM Sans, Geist, Epilogue, Instrument Serif, Sora). Load from Google Fonts.

**Spacing**: Generous. Cards: 24px+ padding. Pages: 40–64px margins. Use CSS grid — it is your friend.

**Details**: \`text-wrap: pretty\`, subtle \`box-shadow\` layering, smooth \`transition\` (150–200ms ease), focus rings, hover states. These separate great from mediocre.

**Avoid AI design slop**:
- ❌ Rounded corners + left-border accent color containers
- ❌ Emoji as decoration (only if the brand explicitly uses them)
- ❌ SVG-drawn illustrations (use geometric shapes or placeholders instead)
- ❌ Aggressive gradient backgrounds
- ❌ Overused font families (Inter, Roboto, Arial, Fraunces)
- ❌ Unnecessary icons, stats, or filler numbers that add no meaning

## Tweaks (Edit mode) — REQUIRED in every output

Every HTML file you produce **must** include a self-contained Tweaks system. Follow this protocol exactly.

### 1 — Define tweakable defaults with EDITMODE markers

Inside your inline \`<script>\`, declare a \`TWEAK_DEFAULTS\` object wrapped in special comment markers. The block between the markers must be **valid JSON** (double-quoted keys and string values). Choose 4–8 meaningful, design-relevant keys for the specific design — colors, font sizes, spacing, copy variants, feature flags, layout options, etc.

\`\`\`js
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"primaryColor":"#D97757","headingSize":48,"bodySize":16,"dark":false,"ctaText":"Get Started","radius":12}/*EDITMODE-END*/;
\`\`\`

There must be **exactly one** such block in the entire file, inside an inline \`<script>\` tag (not an external file).

### 2 — Register the postMessage listener BEFORE announcing availability

This order is mandatory — if you post \`__edit_mode_available\` before the listener is registered, the host's activation message can arrive before your handler exists.

\`\`\`js
// FIRST: register handler
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === '__activate_edit_mode')   showTweaksPanel();
  if (e.data && e.data.type === '__deactivate_edit_mode') hideTweaksPanel();
  if (e.data && e.data.type === '__set_tweak_keys') applyTweaks(e.data.edits);
});

// SECOND: announce readiness
window.parent.postMessage({ type: '__edit_mode_available' }, '*');
\`\`\`

### 3 — Build the Tweaks panel UI

The panel lives **inside the iframe**. Make it a floating card in the bottom-right corner, hidden by default, shown only when \`__activate_edit_mode\` is received.

- For color keys: render a color swatch/picker
- For numeric keys: render a slider or stepper
- For boolean keys: render a toggle
- For string/copy keys: render a text input or chip group

When a value changes:
1. Apply it **live to the DOM** immediately (e.g. update a CSS variable, swap a class, rewrite a text node)
2. Persist by calling \`window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { key: newValue } }, '*')\`

### 4 — Apply defaults via CSS variables

Wire every TWEAK_DEFAULT into a CSS variable on \`:root\` at startup, then reference those variables throughout your styles. This makes live updates a single line: \`document.documentElement.style.setProperty('--primary', newColor)\`.

\`\`\`js
function applyTweaks(edits) {
  const t = Object.assign({}, TWEAK_DEFAULTS, edits);
  const r = document.documentElement;
  r.style.setProperty('--primary', t.primaryColor);
  r.style.setProperty('--heading-size', t.headingSize + 'px');
  // ... etc
}
applyTweaks({}); // apply defaults on load
\`\`\`

## Context from user's session

The user's prompt will include their clarifying answers (output type, fidelity, style direction, reference context). Use those answers to shape which medium you pick, how polished you go, and what aesthetic direction to take.
If the prompt includes "CURRENT DESIGN HTML", treat that HTML as the source of truth for the visible canvas. Prior chat history is background only; never override explicit current HTML with assumptions from older turns.

## Iteration mode

If the user's prompt contains "CURRENT DESIGN HTML (iterate on this", you are in **iteration mode**:

- Read the existing HTML **carefully** before touching anything. Preserve IDs, scripts, postMessage hooks, tweak keys, comments, data attributes, and unrelated copy unless the user explicitly asks to change them.
- Apply the user's follow-up instruction precisely. Change only what is asked; preserve everything else (colors, fonts, spacing, overall structure, content).
- **Do NOT regenerate from scratch.** The existing design is the baseline — iterate on it.
- If the instruction is a targeted tweak (e.g. "change button color", "add a footer"), output **one refined version** — no A/B/C labels needed.
- If the instruction is broad or exploratory (e.g. "make it bolder", "try a dark theme"), output **2 variations** as usual, each iterating from the existing base in a different direction.
- Either way, output a complete, self-contained HTML file.

## Output format

Default direct-output mode:
- If the user prompt does NOT include "DESIGN ARTIFACT FILE", respond with ONLY the raw HTML. No explanation, no markdown fences, no preamble.
- Your response must start with: <!DOCTYPE html>
- Your response must end with: </html>

Artifact-file mode:
- If the user prompt includes "DESIGN ARTIFACT FILE", create or update that exact file path with the complete standalone HTML artifact using write_file or edit_file.
- In artifact-file mode, the final assistant response must be only a brief summary of what changed. Do NOT include the full HTML in the final response. The host application will read the HTML from the artifact file.
`

// ─────────────────────────────────────────────────────────
// System Prompt — Screenshot / Image reference generation
// ─────────────────────────────────────────────────────────

const IMAGE_DESIGN_SYSTEM_PROMPT = `You are an expert frontend engineer specializing in UI cloning. The user has uploaded a screenshot of a UI. Your ONLY job is to reproduce that UI as a pixel-accurate, self-contained HTML page.

## PRIME DIRECTIVE — CLONE, do NOT redesign

Study every pixel of the screenshot and reconstruct what you see:

- **Layout structure**: Identify the exact column layout, fixed sidebars, sticky headers, panel widths. Match them precisely using CSS Grid or Flexbox.
- **Colors**: Copy the exact colors from the screenshot — background colors, text colors, border colors, button colors, highlight/accent colors. Do NOT substitute with oklch() or "nicer" alternatives.
- **Typography**: Match font sizes, font weights, letter-spacing, and text alignment visible in the screenshot. Reproduce all visible text content character-for-character.
- **Spacing**: Match padding, gaps, and margins as closely as possible.
- **Components**: Reproduce every UI component you see — navigation tabs, breadcrumbs, form inputs, dropdowns, cards, tables, buttons, badges, tags, icons, avatars, tooltips, accordions, modals.
- **State**: Reproduce the visual state shown (e.g. which tab is active, which row is selected, what text is in inputs).
- **Icons**: Use Unicode symbols, emoji, or inline SVG to approximate icons. Do NOT skip icons visible in the UI.
- **Chinese text**: Copy all Chinese text exactly as shown. Do not translate or paraphrase.

You are NOT improving the design. You are NOT simplifying it. You are NOT adding your own style. You are CLONING it.

## Implementation strategy

1. Start by identifying the top-level layout (e.g. fixed sidebar + main content, or header + two-column body)
2. Sample the exact color values from the screenshot for backgrounds, borders, and text
3. Reproduce the header / navigation first, then work left-to-right, top-to-bottom through each panel
4. Use CSS classes that mirror the component semantics (e.g. .tab-bar, .sidebar, .card, .form-row)
5. Inline all CSS — no external stylesheets except Google Fonts if a specific font is visible
6. The final output must fill a standard browser viewport (min-height: 100vh) without scrolling if the screenshot shows a full-page layout

## Output rules

1. **Complete HTML file** — start with \`<!DOCTYPE html>\`, end with \`</html>\`
2. **Self-contained** — all CSS in \`<style>\`, all JS in \`<script>\`. Google Fonts CDN is allowed.
3. **No A/B/C variations** — one single page, exactly as shown in the screenshot
4. **Real content** — every label, value, and placeholder text must match the screenshot. No lorem ipsum.

## Tweaks (Edit mode) — REQUIRED

Include the Tweaks protocol so the host app can enable live editing. Extract real values from the screenshot:

\`\`\`js
// Example — replace with actual values sampled from the screenshot:
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"primaryColor":"#4F6EF7","bodyBg":"#F5F7FA","fontSize":14,"radius":6,"sidebarWidth":240}/*EDITMODE-END*/;

function applyTweaks(edits) {
  var t = Object.assign({}, TWEAK_DEFAULTS, edits);
  var r = document.documentElement;
  r.style.setProperty('--primary', t.primaryColor);
  r.style.setProperty('--body-bg', t.bodyBg);
  r.style.setProperty('--font-size', t.fontSize + 'px');
  r.style.setProperty('--radius', t.radius + 'px');
  r.style.setProperty('--sidebar-width', t.sidebarWidth + 'px');
}

// IMPORTANT: register handler FIRST, then announce readiness
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === '__set_tweak_keys') applyTweaks(e.data.edits);
  if (e.data && e.data.type === '__activate_edit_mode')   { /* optional: show panel */ }
  if (e.data && e.data.type === '__deactivate_edit_mode') { /* optional: hide panel */ }
});
window.parent.postMessage({ type: '__edit_mode_available' }, '*');
applyTweaks({});
\`\`\`

## Output format

Respond with ONLY the raw HTML. Zero explanation, zero markdown fences, zero preamble.
First character of your response: <
Last character of your response: >
Your response must start with: <!DOCTYPE html>
Your response must end with: </html>
`

// ─────────────────────────────────────────────────────────
// Model factory (same pattern as optimizer.ts)
// ─────────────────────────────────────────────────────────

function getModel(modelId?: string, retryHooks?: ModelRetryHooks): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  const config = modelId
    ? (configs.find((c) => c.id === modelId) ?? configs[0])
    : configs[0]
  if (!config || !config.apiKey) return null
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseUrl,
      fetch: retryHooks ? createRetryingFetch(retryHooks, 6) : undefined,
    },
    maxRetries: 0,
    maxTokens: 8192,
    temperature: 0.7,
    streaming: true,
  })
}

// ─────────────────────────────────────────────────────────
// Active sessions for cancellation
// ─────────────────────────────────────────────────────────

const activeSessions = new Map<string, AbortController>()

// ─────────────────────────────────────────────────────────
// HTML store — keeps the latest generated HTML per tab so
// iteration prompts can reference the full document without
// having to send it over IPC on every round trip.
// ─────────────────────────────────────────────────────────

                                                                                                                                                                                     const htmlStore = new Map<string, string>()  // artifact id → latest HTML
let htmlStoreBytes = 0
const MAX_HTML_STORE_ENTRIES = 32
const MAX_HTML_STORE_BYTES = 24 * 1024 * 1024
const MAX_SAVED_VARIANTS = 80

function htmlSize(html: string): number {
  return Buffer.byteLength(html, "utf-8")
}

function trimHtmlStore(): void {
  while (
    htmlStore.size > MAX_HTML_STORE_ENTRIES ||
    htmlStoreBytes > MAX_HTML_STORE_BYTES
  ) {
    const oldestKey = htmlStore.keys().next().value as string | undefined
    if (!oldestKey) break
    const oldestHtml = htmlStore.get(oldestKey)
    if (oldestHtml) htmlStoreBytes -= htmlSize(oldestHtml)
    htmlStore.delete(oldestKey)
  }
}

function storeDesignHtml(key: string | undefined, html: string | undefined): void {
  if (!key || !html) return
  const existing = htmlStore.get(key)
  if (existing) {
    htmlStoreBytes -= htmlSize(existing)
    htmlStore.delete(key)
  }
  htmlStore.set(key, html)
  htmlStoreBytes += htmlSize(html)
  trimHtmlStore()
}

function getStoredDesignHtml(key: string | undefined): string | undefined {
  if (!key) return undefined
  const html = htmlStore.get(key)
  if (!html) return undefined
  htmlStore.delete(key)
  htmlStore.set(key, html)
  return html
}

function cleanupSavedVariants(dir: string): void {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^variant-.+\.html$/i.test(entry.name))
      .map((entry) => {
        const filePath = path.join(dir, entry.name)
        const stat = fs.statSync(filePath)
        return { filePath, mtimeMs: stat.mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    files.slice(MAX_SAVED_VARIANTS).forEach((entry) => {
      try {
        fs.unlinkSync(entry.filePath)
      } catch {
        // Best-effort cleanup only.
      }
    })
  } catch {
    // Best-effort cleanup only.
  }
}

// Max turns kept in history to avoid blowing up context.
// Each "turn" = one user message + one assistant message = 2 entries.
const MAX_HISTORY_ENTRIES = 16  // 8 turns

// ─────────────────────────────────────────────────────────
// Active agent sessions for cancellation (design:agent-generate)
// ─────────────────────────────────────────────────────────
const activeDesignAgents = new Map<string, AbortController>()

// Persistent store for reading workspace path (same key used by main settings)
const designAgentStore = new Store({ name: "settings", cwd: getOpenworkDir() })

function makeDesignAgentThreadId(designSessionId: string | undefined, tabId: string): string {
  const safeSessionId = String(designSessionId || "session")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "session"
  const safeTabId = String(tabId || "tab")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "tab"
  return `design_${safeSessionId}_${safeTabId}`.slice(0, 120)
}

function serializeStreamData(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data))
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""

      const item = block as { text?: unknown; content?: unknown }
      if (typeof item.text === "string") return item.text
      if (typeof item.content === "string") return item.content
      return ""
    })
    .join("")
}

type DesignExecutionStatus = "running" | "success" | "error"

interface DesignExecutionEvent {
  kind: "tool_call" | "tool_result" | "used_skill"
  id?: string
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  content?: string
  isError?: boolean
  status?: DesignExecutionStatus
  timestamp: number
}

interface DesignSkillReference {
  name?: string
  path?: string
}

interface DesignArtifactSaveParams {
  tabId: string
  html: string
  workspacePath?: string
}

interface DesignArtifactReadParams {
  tabId: string
  workspacePath?: string
}

interface DesignArtifactFileSaveParams {
  filePath: string
  html: string
  workspacePath?: string
}

interface DesignArtifactFileReadParams {
  filePath: string
  workspacePath?: string
}

interface DesignArtifactFileReadResult {
  success: boolean
  filePath?: string
  html?: string
  error?: string
}

interface DesignImportUrlParams {
  url: string
}

interface DesignContextFileSyncItem {
  filename: string
  sourcePath?: string
  content?: string
}

interface DesignContextFilesSyncParams {
  workspacePath?: string
  designSessionId?: string
  kind: "attachments" | "code"
  files: DesignContextFileSyncItem[]
}

const DESIGN_ARTIFACTS_DIR = ".cmb-design"

function makeSafeDesignId(tabId: string): string {
  const safeId = String(tabId || "tab")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
  return (safeId || "tab").slice(0, 120)
}

function resolveDesignArtifactPath(tabId: string, workspacePath?: string): { filePath?: string; error?: string } {
  const workspace = typeof workspacePath === "string" && workspacePath.trim()
    ? workspacePath.trim()
    : app.getPath("userData")

  try {
    const workspaceRoot = path.resolve(workspace)
    if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
      return { error: `Design workspace is not available: ${workspaceRoot}` }
    }

    const artifactDir = path.join(workspaceRoot, DESIGN_ARTIFACTS_DIR, makeSafeDesignId(tabId))
    const artifactPath = path.join(artifactDir, "index.html")
    const resolvedArtifact = path.resolve(artifactPath)
    const normalizedRoot = workspaceRoot.toLowerCase()
    const normalizedArtifact = resolvedArtifact.toLowerCase()
    if (normalizedArtifact !== normalizedRoot && !normalizedArtifact.startsWith(normalizedRoot + path.sep)) {
      return { error: `Design artifact path escaped workspace: ${resolvedArtifact}` }
    }
    return { filePath: resolvedArtifact }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function saveDesignArtifact(tabId: string, html: string, workspacePath?: string): { success: boolean; filePath?: string; error?: string } {
  const resolved = resolveDesignArtifactPath(tabId, workspacePath)
  if (!resolved.filePath) return { success: false, error: resolved.error ?? "Failed to resolve design artifact path" }

  try {
    fs.mkdirSync(path.dirname(resolved.filePath), { recursive: true })
    fs.writeFileSync(resolved.filePath, html, "utf-8")
    return { success: true, filePath: resolved.filePath }
  } catch (err) {
    return { success: false, filePath: resolved.filePath, error: err instanceof Error ? err.message : String(err) }
  }
}

function resolveDesignArtifactFilePath(filePath: string, workspacePath?: string): { filePath?: string; error?: string } {
  const workspace = typeof workspacePath === "string" && workspacePath.trim()
    ? workspacePath.trim()
    : app.getPath("userData")

  try {
    const workspaceRoot = path.resolve(workspace)
    if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
      return { error: `Design workspace is not available: ${workspaceRoot}` }
    }
    const artifactsRoot = path.resolve(workspaceRoot, DESIGN_ARTIFACTS_DIR)
    const resolvedFile = path.resolve(filePath)
    const normalizedArtifactsRoot = artifactsRoot.toLowerCase()
    const normalizedFile = resolvedFile.toLowerCase()
    if (normalizedFile !== normalizedArtifactsRoot && !normalizedFile.startsWith(normalizedArtifactsRoot + path.sep)) {
      return { error: `Design artifact file escaped artifact directory: ${resolvedFile}` }
    }
    return { filePath: resolvedFile }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function saveDesignArtifactFile(filePath: string, html: string, workspacePath?: string): { success: boolean; filePath?: string; error?: string } {
  const resolved = resolveDesignArtifactFilePath(filePath, workspacePath)
  if (!resolved.filePath) return { success: false, error: resolved.error ?? "Failed to resolve design artifact file" }

  try {
    fs.mkdirSync(path.dirname(resolved.filePath), { recursive: true })
    fs.writeFileSync(resolved.filePath, html, "utf-8")
    return { success: true, filePath: resolved.filePath }
  } catch (err) {
    return { success: false, filePath: resolved.filePath, error: err instanceof Error ? err.message : String(err) }
  }
}

function readDesignArtifact(tabId: string, workspacePath?: string): { success: boolean; filePath?: string; html?: string; error?: string } {
  const resolved = resolveDesignArtifactPath(tabId, workspacePath)
  if (!resolved.filePath) return { success: false, error: resolved.error ?? "Failed to resolve design artifact path" }

  try {
    if (!fs.existsSync(resolved.filePath)) {
      return { success: false, filePath: resolved.filePath, error: `Design artifact not found: ${resolved.filePath}` }
    }
    return { success: true, filePath: resolved.filePath, html: fs.readFileSync(resolved.filePath, "utf-8") }
  } catch (err) {
    return { success: false, filePath: resolved.filePath, error: err instanceof Error ? err.message : String(err) }
  }
}

function readSavedDesignArtifactFile(filePath: string | undefined, workspacePath?: string): DesignArtifactFileReadResult {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { success: false, error: "Design artifact path is empty" }
  }
  const resolved = resolveDesignArtifactFilePath(filePath, workspacePath)
  if (!resolved.filePath) return { success: false, error: resolved.error ?? "Failed to resolve design artifact file" }

  try {
    if (!fs.existsSync(resolved.filePath) || !fs.statSync(resolved.filePath).isFile()) {
      return { success: false, filePath: resolved.filePath, error: `Design artifact not found: ${resolved.filePath}` }
    }
    return { success: true, filePath: resolved.filePath, html: fs.readFileSync(resolved.filePath, "utf-8") }
  } catch (err) {
    return { success: false, filePath: resolved.filePath, error: err instanceof Error ? err.message : String(err) }
  }
}

function readDesignArtifactFile(filePath: string | undefined, workspacePath: string): DesignArtifactFileReadResult {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { success: false, error: "Design source artifact path is empty" }
  }

  try {
    const workspaceRoot = path.resolve(workspacePath)
    const resolvedFile = path.resolve(filePath.trim())
    const normalizedRoot = workspaceRoot.toLowerCase()
    const normalizedFile = resolvedFile.toLowerCase()
    if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(normalizedRoot + path.sep)) {
      return { success: false, filePath: resolvedFile, error: `Design source artifact path escaped workspace: ${resolvedFile}` }
    }
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
      return { success: false, filePath: resolvedFile, error: `Design source artifact not found: ${resolvedFile}` }
    }
    return { success: true, filePath: resolvedFile, html: fs.readFileSync(resolvedFile, "utf-8") }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function prepareDesignArtifact(tabId: string, workspacePath?: string): { filePath?: string; error?: string } {
  const resolved = resolveDesignArtifactPath(tabId, workspacePath)
  if (!resolved.filePath) return { error: resolved.error ?? "Failed to resolve design artifact path" }

  try {
    fs.mkdirSync(path.dirname(resolved.filePath), { recursive: true })
    return { filePath: resolved.filePath }
  } catch (err) {
    return { filePath: resolved.filePath, error: err instanceof Error ? err.message : String(err) }
  }
}

function sanitizeDesignContextName(name: string): string {
  const trimmed = String(name || "").trim()
  const normalized = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
  return (normalized || "file").slice(0, 120)
}

function resolveDesignContextDir(
  workspacePath: string | undefined,
  designSessionId: string | undefined,
  kind: "attachments" | "code"
): { dirPath?: string; error?: string } {
  const workspace = typeof workspacePath === "string" && workspacePath.trim()
    ? workspacePath.trim()
    : app.getPath("userData")
  const safeSessionId = makeSafeDesignId(designSessionId || "session")

  try {
    const workspaceRoot = path.resolve(workspace)
    if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
      return { error: `Design workspace is not available: ${workspaceRoot}` }
    }

    const contextDir = path.resolve(workspaceRoot, DESIGN_ARTIFACTS_DIR, safeSessionId, "context", kind)
    const normalizedRoot = workspaceRoot.toLowerCase()
    const normalizedContext = contextDir.toLowerCase()
    if (normalizedContext !== normalizedRoot && !normalizedContext.startsWith(normalizedRoot + path.sep)) {
      return { error: `Design context path escaped workspace: ${contextDir}` }
    }
    return { dirPath: contextDir }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function syncDesignContextFiles(params: DesignContextFilesSyncParams): {
  success: boolean
  dirPath?: string
  files?: Array<{ sourcePath: string; targetPath: string; filename: string }>
  error?: string
} {
  const resolvedDir = resolveDesignContextDir(params.workspacePath, params.designSessionId, params.kind)
  if (!resolvedDir.dirPath) {
    return { success: false, error: resolvedDir.error ?? "Failed to resolve design context directory" }
  }

  try {
    fs.mkdirSync(resolvedDir.dirPath, { recursive: true })
    const copied: Array<{ sourcePath: string; targetPath: string; filename: string }> = []
    const usedNames = new Set<string>()

    for (const item of params.files) {
      const rawName = typeof item.filename === "string" ? item.filename.trim() : ""
      const sourcePath = typeof item.sourcePath === "string" ? item.sourcePath.trim() : ""
      const content = typeof item.content === "string" ? item.content : null
      if (!rawName) continue

      const parsed = path.parse(sanitizeDesignContextName(rawName))
      const baseName = parsed.name || "file"
      const ext = parsed.ext || path.extname(sourcePath || rawName)
      let candidate = `${baseName}${ext}`
      let suffix = 1
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${baseName}_${suffix}${ext}`
        suffix += 1
      }
      usedNames.add(candidate.toLowerCase())

      const targetPath = path.join(resolvedDir.dirPath, candidate)
      if (content !== null) {
        fs.writeFileSync(targetPath, content, "utf-8")
        copied.push({ sourcePath: sourcePath || candidate, targetPath, filename: candidate })
        continue
      }

      if (!sourcePath) continue
      const resolvedSource = path.resolve(sourcePath)
      if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) continue
      fs.copyFileSync(resolvedSource, targetPath)
      copied.push({ sourcePath: resolvedSource, targetPath, filename: candidate })
    }

    return { success: true, dirPath: resolvedDir.dirPath, files: copied }
  } catch (err) {
    return { success: false, dirPath: resolvedDir.dirPath, error: err instanceof Error ? err.message : String(err) }
  }
}

function stripContentSecurityPolicyMeta(html: string): string {
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi,
    ""
  )
}

function ensureImportedHtmlDocument(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) return ""
  if (/<html[\s>]/i.test(trimmed)) return trimmed
  if (/<head[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)) {
    return `<!DOCTYPE html>\n<html>\n${trimmed}\n</html>`
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
${trimmed}
</body>
</html>`
}

function injectBaseHref(html: string, baseHref: string): string {
  if (!baseHref.trim()) return html
  if (/<base\b/i.test(html)) return html
  const safeHref = baseHref.replace(/"/g, "&quot;")
  const baseTag = `<base href="${safeHref}">`

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`)
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(
      /<html([^>]*)>/i,
      `<html$1>\n<head>\n${baseTag}\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n</head>`
    )
  }
  return `<!DOCTYPE html>
<html>
<head>
${baseTag}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
${html}
</body>
</html>`
}

function prepareImportedRemoteHtml(html: string, finalUrl: string): string {
  const normalized = ensureImportedHtmlDocument(stripContentSecurityPolicyMeta(html))
  return injectBaseHref(normalized, finalUrl)
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const rawTitle = match?.[1]
    ?.replace(/\s+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim()
  return rawTitle || undefined
}

function buildDesignArtifactInstruction(filePath: string, exists: boolean, sourceFilePath?: string): string {
  return `\n\n---\nDESIGN ARTIFACT FILE\n` +
    (sourceFilePath
      ? `Read the current design source artifact first:\n${sourceFilePath}\n\n`
      : "") +
    `Write the new complete standalone HTML artifact to this exact absolute output file path:\n${filePath}\n\n` +
    `${exists ? "The output artifact already exists. Read it with read_file before editing." : "The output artifact does not exist yet. Create it with write_file."}\n` +
    `If a source artifact path is provided, use it only as input/reference and write the updated complete HTML to the output file path above. ` +
    `Use write_file for a new output artifact, or edit_file only if the output file already exists. ` +
    `Do not paste the full HTML into the final chat response. After the file is updated, respond with only a brief summary of what changed. ` +
    `The host application will read and render the HTML from this file.`
}

function getSerializedClassName(msg: Record<string, unknown>): string {
  const classId: string[] = Array.isArray(msg.id) ? (msg.id as string[]) : []
  return classId[classId.length - 1] ?? ""
}

function normalizeToolCalls(raw: unknown): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return []
  const normalized: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> = []
  for (const toolCall of raw) {
    if (!toolCall || typeof toolCall !== "object") continue
    const item = toolCall as { id?: unknown; name?: unknown; args?: unknown }
    normalized.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      args: item.args && typeof item.args === "object" && !Array.isArray(item.args)
        ? item.args as Record<string, unknown>
        : {},
    })
  }
  return normalized
}

function getReadFilePath(args: Record<string, unknown> | undefined): string {
  if (!args) return ""
  return (
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    ""
  )
}

const DESIGN_CHECKPOINT_RESET_STATUS_CODES = new Set([432, 433, 485])
const HTTP_STATUS_IN_MESSAGE_RE = /\b(4\d{2}|5\d{2})\b/

function getModelHttpStatusCode(error: unknown): number | null {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (typeof status === "number") return status

    const response = (error as { response?: unknown }).response
    if (response && typeof response === "object") {
      const responseStatus = (response as { status?: unknown }).status
      if (typeof responseStatus === "number") return responseStatus
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? "")
  const match = HTTP_STATUS_IN_MESSAGE_RE.exec(message)
  return match ? Number.parseInt(match[1], 10) : null
}

function shouldResetDesignCheckpointForRetry(error: unknown): boolean {
  const status = getModelHttpStatusCode(error)
  return status !== null && DESIGN_CHECKPOINT_RESET_STATUS_CODES.has(status)
}

function isToolMessageError(kwargs: Record<string, unknown>): boolean {
  return (
    kwargs.status === "error" ||
    kwargs.is_error === true ||
    (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.is_error === true
  )
}

function normalizeDesignSkillReference(raw: unknown): { name: string; path: string } | null {
  if (!raw || typeof raw !== "object") return null
  const skill = raw as DesignSkillReference
  const name = typeof skill.name === "string" ? skill.name.trim() : ""
  const skillPath = typeof skill.path === "string" ? skill.path.trim() : ""
  if (!name || !skillPath) return null
  return { name, path: skillPath }
}

function readDesignSkillContent(skillPath: string): { content?: string; error?: string } {
  try {
    const resolvedPath = path.resolve(skillPath)
    if (!fs.existsSync(resolvedPath)) return { error: `Skill file not found: ${skillPath}` }
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) return { error: `Skill path is not a file: ${skillPath}` }
    if (path.basename(resolvedPath) !== "SKILL.md") return { error: `Skill path must point to SKILL.md: ${skillPath}` }
    return { content: fs.readFileSync(resolvedPath, "utf-8") }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function buildDesignModelRetryHooks(send: (data: object) => void): ModelRetryHooks {
  return {
    onRetry: (info) => {
      send({
        type: "model_retry",
        attempt: info.attempt,
        maxRetries: info.maxRetries,
        reason: info.reason,
        delayMs: info.delayMs
      })
    },
    onRetrySuccess: () => {
      send({ type: "model_retry_clear" })
    }
  }
}

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDesignHandlers(): void {
  ipcMain.handle(
    "design:import-url",
    async (_event, { url }: DesignImportUrlParams): Promise<{
      success: boolean
      html?: string
      finalUrl?: string
      title?: string
      error?: string
    }> => {
      const rawUrl = typeof url === "string" ? url.trim() : ""
      if (!rawUrl) {
        return { success: false, error: "URL 不能为空" }
      }

      let parsedUrl: URL
      try {
        parsedUrl = new URL(rawUrl)
      } catch {
        return { success: false, error: "URL 格式无效" }
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return { success: false, error: "仅支持 http:// 或 https:// 链接" }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)

      try {
        const response = await net.fetch(parsedUrl.toString(), {
          signal: controller.signal,
          headers: {
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
          }
        })

        if (!response.ok) {
          return { success: false, error: `抓取页面失败：HTTP ${response.status}` }
        }

        const contentLength = response.headers.get("content-length")
        const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : NaN
        if (Number.isFinite(parsedLength) && parsedLength > 5 * 1024 * 1024) {
          return { success: false, error: "页面内容超过 5MB 限制" }
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
        if (contentType && !contentType.includes("html") && !contentType.includes("xml") && !contentType.startsWith("text/")) {
          return { success: false, error: `链接返回的不是可导入的 HTML 页面：${contentType}` }
        }

        const rawHtml = await response.text()
        if (Buffer.byteLength(rawHtml, "utf-8") > 5 * 1024 * 1024) {
          return { success: false, error: "页面内容超过 5MB 限制" }
        }
        if (!rawHtml.trim()) {
          return { success: false, error: "页面内容为空" }
        }

        const finalUrl = response.url || parsedUrl.toString()
        return {
          success: true,
          html: prepareImportedRemoteHtml(rawHtml, finalUrl),
          finalUrl,
          title: extractHtmlTitle(rawHtml),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message || "抓取页面失败" }
      } finally {
        clearTimeout(timeout)
      }
    }
  )

  ipcMain.handle(
    "design:sync-context-files",
    async (_event, params: DesignContextFilesSyncParams): Promise<{
      success: boolean
      dirPath?: string
      files?: Array<{ sourcePath: string; targetPath: string; filename: string }>
      error?: string
    }> => {
      if (!params || !Array.isArray(params.files) || params.files.length === 0) {
        return { success: false, error: "No files to sync" }
      }
      if (params.kind !== "attachments" && params.kind !== "code") {
        return { success: false, error: `Unsupported context kind: ${String((params as { kind?: unknown }).kind)}` }
      }
      return syncDesignContextFiles(params)
    }
  )

  // design:ask-questions — stream questions JSON from model
  ipcMain.on(
    "design:ask-questions",
    async (event, { sessionId, prompt, modelId }: { sessionId: string; prompt: string; modelId?: string }) => {
      const channel = `design:questions:${sessionId}`
      const window = BrowserWindow.fromWebContents(event.sender)

      const send = (data: object) => {
        if (window && !window.isDestroyed()) {
          event.sender.send(channel, data)
        }
      }

      const existing = activeSessions.get(sessionId)
      if (existing) existing.abort()

      const controller = new AbortController()
      activeSessions.set(sessionId, controller)

      const model = getModel(modelId, buildDesignModelRetryHooks(send))
      if (!model) {
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }

      let fullText = ""

      try {
        send({ type: "start" })

        const stream = await model.stream(
          [new SystemMessage(QUESTIONS_SYSTEM_PROMPT), new HumanMessage(prompt)],
          { signal: controller.signal }
        )

        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          const token = typeof chunk.content === "string" ? chunk.content : ""
          if (token) fullText += token
        }

        // Parse JSON questions from model output
        const questions = parseQuestionsJson(fullText)
        send({ type: "done", questions })
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          console.error("[Design] Questions generation error:", message)
          send({ type: "error", error: message })
        }
      } finally {
        activeSessions.delete(sessionId)
      }
    }
  )

  // design:generate — streaming, same pattern as agent:invoke
  ipcMain.on(
    "design:generate",
    async (event, {
      sessionId, prompt, modelId, history, tabId,
    }: {
      sessionId: string
      prompt: string
      modelId?: string
      /** Prior conversation turns to include for multi-turn context */
      history?: Array<{ role: "user" | "assistant"; content: string }>
      /** Tab ID used to look up the latest stored HTML for iteration */
      tabId?: string
    }) => {
      const channel = `design:stream:${sessionId}`
      const window = BrowserWindow.fromWebContents(event.sender)

      const send = (data: object) => {
        if (window && !window.isDestroyed()) {
          event.sender.send(channel, data)
        }
      }

      // Cancel any existing session with the same id
      const existing = activeSessions.get(sessionId)
      if (existing) existing.abort()

      const controller = new AbortController()
      activeSessions.set(sessionId, controller)

      const model = getModel(modelId, buildDesignModelRetryHooks(send))
      if (!model) {
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }

      let fullText = ""

      // ── Build the message array ───────────────────────────
      // If we have prior history + a stored HTML for this tab,
      // build a multi-turn conversation so the model sees previous
      // instructions and the full current design without truncation.
      const storedHtml = getStoredDesignHtml(tabId)
      const trimmedHistory = history && history.length > 0
        ? history.slice(-MAX_HISTORY_ENTRIES)
        : undefined

      type LangChainMessage = SystemMessage | HumanMessage | AIMessage
      let messages: LangChainMessage[]

      if (trimmedHistory && trimmedHistory.length > 0 && storedHtml) {
        // Multi-turn iteration: inject full stored HTML into the final user message
        const finalUserContent =
          `${prompt}\n\n---\nCURRENT DESIGN HTML (iterate on this — do NOT ignore it):\n${storedHtml}`
        messages = [
          new SystemMessage(DESIGN_SYSTEM_PROMPT),
          ...trimmedHistory.map((m): LangChainMessage =>
            m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
          ),
          new HumanMessage(finalUserContent),
        ]
        console.log(
          `[Design] Multi-turn generation — ${trimmedHistory.length} history entries, ` +
          `HTML=${storedHtml.length} chars, tabId=${tabId}`
        )
      } else {
        // First generation (no history) or fallback — send prompt as-is
        messages = [new SystemMessage(DESIGN_SYSTEM_PROMPT), new HumanMessage(prompt)]
        if (history && history.length > 0) {
          console.log(`[Design] History provided but no storedHtml for tabId=${tabId} — falling back to single-turn`)
        }
      }

      try {
        send({ type: "start" })

        const stream = await model.stream(messages, { signal: controller.signal })

        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          const token = typeof chunk.content === "string" ? chunk.content : ""
          if (token) {
            fullText += token
            send({ type: "token", token })
          }
        }

        const html = extractHtml(fullText)
        send({ type: "done", html })
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          console.error("[Design] Generation error:", message)
          send({ type: "error", error: message })
        }
      } finally {
        activeSessions.delete(sessionId)
      }
    }
  )

  // design:generate-from-image — multimodal: image + optional prompt → single HTML (no variations)
  ipcMain.on(
    "design:generate-from-image",
    async (
      event,
      { sessionId, prompt, imageData, mimeType, modelId }: {
        sessionId: string
        prompt: string
        imageData: string
        mimeType: string
        modelId?: string
      }
    ) => {
      const channel = `design:image-stream:${sessionId}`
      const window = BrowserWindow.fromWebContents(event.sender)

      const send = (data: object) => {
        if (window && !window.isDestroyed()) {
          event.sender.send(channel, data)
        }
      }

      const existing = activeSessions.get(sessionId)
      if (existing) existing.abort()

      const controller = new AbortController()
      activeSessions.set(sessionId, controller)

      console.log(`[Design:Image] Handler fired — sessionId=${sessionId} mimeType=${mimeType} imageDataLen=${imageData?.length ?? 0} prompt="${prompt?.slice(0, 80)}"`)

      const model = getModel(modelId, buildDesignModelRetryHooks(send))
      if (!model) {
        console.error("[Design:Image] No model configured")
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }
      // Log which model is being used
      const configs = getCustomModelConfigs()
      const usedConfig = modelId ? configs.find((c) => c.id === modelId) : configs[0]
      console.log(`[Design:Image] Using model="${usedConfig?.model}" baseURL="${usedConfig?.baseUrl}" — NOTE: model must support vision/multimodal input`)
      console.log("[Design:Image] Model obtained, preparing to stream…")

      let fullText = ""
      let tokenCount = 0

      try {
        send({ type: "start" })

        const userPrompt = prompt?.trim() || "请完整还原截图中的页面，包括布局、配色、所有文字内容和组件。"
        console.log(`[Design:Image] Sending to model — prompt="${userPrompt.slice(0, 80)}"`)

        const stream = await model.stream(
          [
            new SystemMessage(IMAGE_DESIGN_SYSTEM_PROMPT),
            new HumanMessage({
              content: [
                {
                  type: "image_url",
                  // detail:"high" asks the model to use the full image resolution for analysis
                  image_url: { url: `data:${mimeType};base64,${imageData}`, detail: "high" },
                },
                { type: "text", text: userPrompt },
              ],
            }),
          ],
          { signal: controller.signal }
        )
        console.log("[Design:Image] Stream opened, receiving tokens…")

        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          const token = typeof chunk.content === "string" ? chunk.content : ""
          if (token) {
            fullText += token
            tokenCount++
            if (tokenCount === 1) console.log("[Design:Image] First token received ✓")
            if (tokenCount % 1000 === 0) console.log(`[Design:Image] ${tokenCount} tokens so far (${fullText.length} chars)`)
            send({ type: "token", token })
          }
        }

        console.log(`[Design:Image] Stream complete — ${tokenCount} tokens, ${fullText.length} chars total`)
        // Print full raw output so we can diagnose whether the image was seen
        console.log(`[Design:Image] ===== RAW MODEL OUTPUT START =====`)
        console.log(fullText.slice(0, 800))
        console.log(`[Design:Image] ===== RAW MODEL OUTPUT END =====`)

        const html = extractHtml(fullText)

        // Detect if the model responded with text instead of HTML.
        // Two failure modes:
        //   1. Not HTML at all — model said "I can't see the image" etc.
        //   2. HTML too short (< 2000 chars) — model generated a stub, not a real clone
        const looksLikeHtml = html.trimStart().startsWith("<!DOCTYPE") || html.trimStart().startsWith("<html")
        if (!looksLikeHtml) {
          console.error("[Design:Image] ❌ Model did not produce HTML — vision likely unsupported")
          send({
            type: "error",
            error: `当前模型（${configs[0]?.model}）不支持图片输入。\n\n请切换到支持 Vision 的模型，如：\n• gpt-4o\n• claude-3-5-sonnet-20241022\n• gemini-1.5-pro\n\n模型实际回复：\n${fullText.slice(0, 200)}`,
          })
          return
        }

        if (html.length < 2000) {
          console.warn(`[Design:Image] ⚠️ HTML too short (${html.length} chars) — model likely did not process the image`)
          send({
            type: "error",
            error: `模型（${configs[0]?.model}）可能无法处理图片，生成的页面过于简单（${html.length} 字符）。\n\n请确认该模型支持 Vision 多模态输入，或切换到 gpt-4o / claude-3-5-sonnet 等模型。\n\n模型实际回复：\n${fullText.slice(0, 200)}`,
          })
          return
        }

        console.log(`[Design:Image] HTML extracted — ${html.length} chars, sending done ✓`)
        send({ type: "done", html })
      } catch (err) {
        if (controller.signal.aborted) {
          console.log("[Design:Image] Cancelled by user")
          send({ type: "cancelled" })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          console.error("[Design:Image] ❌ Error:", message)
          if (stack) console.error("[Design:Image] Stack:", stack)
          send({ type: "error", error: message })
        }
      } finally {
        activeSessions.delete(sessionId)
        console.log("[Design:Image] Session cleaned up")
      }
    }
  )

  // design:store-html — renderer calls this after each generation so the main
  // process has the latest full HTML for the tab, used by multi-turn iteration.
  ipcMain.handle("design:store-html", (_event, tabId: string, html: string) => {
    if (tabId && html) {
      storeDesignHtml(tabId, html)
      console.log(`[Design] Stored HTML for tabId=${tabId} (${html.length} chars)`)
    }
    return { ok: true }
  })

  ipcMain.handle(
    "design:save-artifact",
    (_event, { tabId, html, workspacePath }: DesignArtifactSaveParams) => {
      if (!tabId || !html) {
        return { success: false, error: "tabId and html are required" }
      }
      const result = saveDesignArtifact(tabId, html, workspacePath)
      if (result.success && result.filePath) {
        storeDesignHtml(tabId, html)
        console.log(`[Design] Saved artifact for tabId=${tabId} -> ${result.filePath}`)
      }
      return result
    }
  )

  ipcMain.handle(
    "design:save-artifact-file",
    (_event, { filePath, html, workspacePath }: DesignArtifactFileSaveParams) => {
      if (!filePath || !html) {
        return { success: false, error: "filePath and html are required" }
      }
      const result = saveDesignArtifactFile(filePath, html, workspacePath)
      if (result.success && result.filePath) {
        storeDesignHtml(result.filePath, html)
        console.log(`[Design] Saved artifact file -> ${result.filePath}`)
      }
      return result
    }
  )

  ipcMain.handle(
    "design:read-artifact",
    (_event, { tabId, workspacePath }: DesignArtifactReadParams) =>
      readDesignArtifact(tabId, workspacePath)
  )

  ipcMain.handle(
    "design:read-artifact-file",
    (_event, { filePath, workspacePath }: DesignArtifactFileReadParams) =>
      readSavedDesignArtifactFile(filePath, workspacePath)
  )

  // ─────────────────────────────────────────────────────────
  // design:agent-generate — routes through the full Agent Runtime so Design
  // naturally inherits Skills, MCP tools, Hooks, Approvals and context
  // summarization. Uses tabId as the LangGraph thread ID for native multi-turn.
  // ─────────────────────────────────────────────────────────
  ipcMain.on(
    "design:agent-generate",
    async (event, {
      sessionId, prompt, modelId, tabId, imageData, mimeType, currentHtml, skill, workspacePath: requestedWorkspacePath, artifactId, sourceArtifactPath, designSessionId,
    }: {
      sessionId: string
      prompt: string
      modelId?: string
      tabId: string
      imageData?: string
      mimeType?: string
      currentHtml?: string
      skill?: DesignSkillReference
      workspacePath?: string
      artifactId?: string
      sourceArtifactPath?: string
      designSessionId?: string
    }) => {
      const channel = `design:stream:${sessionId}`
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (data: object) => {
        if (win && !win.isDestroyed()) event.sender.send(channel, data)
      }

      // Cancel any existing agent session for this sessionId
      const existingCtrl = activeDesignAgents.get(sessionId)
      if (existingCtrl) existingCtrl.abort()

      const controller = new AbortController()
      activeDesignAgents.set(sessionId, controller)

      // workspacePath: required by agent runtime for hooks & tools.
      // Prefer the Design renderer's explicit selection, then fall back to the
      // same global setting used by the Chat workspace picker.
      const storedWorkspace = designAgentStore.get("workspacePath", null)
      const explicitWorkspace =
        typeof requestedWorkspacePath === "string" && requestedWorkspacePath.trim()
          ? requestedWorkspacePath.trim()
          : null
      const storedWorkspacePath =
        typeof storedWorkspace === "string" && storedWorkspace.trim()
          ? storedWorkspace.trim()
          : null
      const workspacePath = explicitWorkspace ?? storedWorkspacePath ?? app.getPath("userData")
      try {
        if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
          send({ type: "error", error: `Design workspace is not available: ${workspacePath}` })
          activeDesignAgents.delete(sessionId)
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        send({ type: "error", error: `Design workspace is not accessible: ${workspacePath}\n${message}` })
        activeDesignAgents.delete(sessionId)
        return
      }

      // Each design session gets its own LangGraph thread so imported/new designs
      // keep isolated model context while still preserving follow-up edits.
      // Checkpoint paths only allow [a-zA-Z0-9_-], so keep this in sync with renderer approval listeners.
      const threadId = makeDesignAgentThreadId(designSessionId, tabId)

      try {
        send({ type: "start" })

        const selectedSkill = normalizeDesignSkillReference(skill)
        let skillContext = ""
        if (selectedSkill) {
          const skillEventId = `selected-skill:${selectedSkill.name}:${Date.now()}`
          send({
            type: "execution",
            event: {
              kind: "used_skill",
              id: skillEventId,
              toolCallId: skillEventId,
              name: selectedSkill.name,
              status: "running",
              timestamp: Date.now(),
            } satisfies DesignExecutionEvent,
          })

          const result = readDesignSkillContent(selectedSkill.path)
          if (result.content) {
            skillContext =
              `\n\n---\n[Selected Design Skill: ${selectedSkill.name}]\n` +
              `The user explicitly selected this skill for the current design request. ` +
              `Follow the skill instructions below as authoritative guidance for this turn, while still obeying the Design system prompt's requirement to output complete standalone HTML.\n\n` +
              `${result.content}`
            send({
              type: "execution",
              event: {
                kind: "used_skill",
                id: `${skillEventId}:result`,
                toolCallId: skillEventId,
                name: selectedSkill.name,
                status: "success",
                timestamp: Date.now(),
              } satisfies DesignExecutionEvent,
            })
          } else {
            send({
              type: "execution",
              event: {
                kind: "used_skill",
                id: `${skillEventId}:result`,
                toolCallId: skillEventId,
                name: selectedSkill.name,
                status: "error",
                isError: true,
                content: result.error,
                timestamp: Date.now(),
              } satisfies DesignExecutionEvent,
            })
            send({ type: "error", error: result.error ?? `Failed to load selected skill: ${selectedSkill.name}` })
            return
          }
        }

        const resolvedArtifactId = artifactId || tabId
        const htmlStoreKey = resolvedArtifactId
        const preparedArtifact = tabId ? prepareDesignArtifact(resolvedArtifactId, workspacePath) : null
        if (preparedArtifact?.error || !preparedArtifact?.filePath) {
          send({
            type: "error",
            error: preparedArtifact?.error ?? "Failed to prepare design artifact file"
          })
          return
        }
        const existingOutputArtifact = readDesignArtifact(resolvedArtifactId, workspacePath)
        const sourceArtifact = readDesignArtifactFile(sourceArtifactPath, workspacePath)
        const hasExistingArtifactHtml = Boolean(
          existingOutputArtifact.success && existingOutputArtifact.html?.trim()
        ) || Boolean(
          sourceArtifact.success && sourceArtifact.html?.trim()
        )
        const artifactInstruction = buildDesignArtifactInstruction(
          preparedArtifact.filePath,
          Boolean(existingOutputArtifact.success && existingOutputArtifact.html?.trim()),
          sourceArtifact.success ? sourceArtifact.filePath : undefined
        )

        const createDesignAgentRuntime = () => createAgentRuntime({
          threadId,
          workspacePath,
          modelId,
          systemPromptOverride: DESIGN_SYSTEM_PROMPT,
          noSchedulerTool: true,
          noSkillEvolutionTool: true,
          enableAgentsPrompt: false,   // skip AGENTS.md — design persona is self-contained
          abortSignal: controller.signal,
          retryHooks: buildDesignModelRetryHooks(send),
          maxRetryAttempts: 6,
        })

        let agent = await createDesignAgentRuntime()

        const streamConfig = {
          configurable: { thread_id: threadId },
          signal: controller.signal,
          streamMode: ["messages", "values"] as ("messages" | "values")[],
          recursionLimit: 200,
        }

        const shouldUseStoredHtmlFallback =
          !hasExistingArtifactHtml && (
            prompt.includes("CURRENT DESIGN HTML") ||
            prompt.includes("User follow-up instruction:") ||
            prompt.includes("用户通过 Comment 模式")
          )
        const storedHtml = shouldUseStoredHtmlFallback ? getStoredDesignHtml(htmlStoreKey) : undefined
        const htmlForIteration =
          !hasExistingArtifactHtml && typeof currentHtml === "string" && currentHtml.trim()
            ? currentHtml
            : storedHtml
        const promptWithCurrentHtml = htmlForIteration
          ? `${prompt}\n\n---\nCURRENT DESIGN HTML (iterate on this — do NOT ignore it):\n${htmlForIteration}`
          : prompt
        const promptWithSkill = skillContext ? `${promptWithCurrentHtml}${skillContext}` : promptWithCurrentHtml
        const promptWithArtifact = `${promptWithSkill}${artifactInstruction}`
        if (htmlForIteration) storeDesignHtml(htmlStoreKey, htmlForIteration)

        const humanMessage =
          imageData && mimeType
            ? new HumanMessage({
                content: [
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${imageData}`, detail: "high" },
                  },
                  { type: "text", text: promptWithArtifact },
                ],
              })
            : new HumanMessage(promptWithArtifact)

        let stream = await agent.stream(
          { messages: [humanMessage] },
          streamConfig
        )
        let midStreamRetriesLeft = 2

        let streamedText = ""
        let finalMessageText = ""
        const skillUsageDetector = new SkillUsageDetector()
        const skillToolCallIds = new Map<string, string>()
        const pendingSkillReadPathsByToolCallId = new Map<string, string>()
        const pendingSkillResultsByToolCallId = new Map<string, boolean>()
        const emittedSkillStartToolCallIds = new Set<string>()
        const emittedSkillResultToolCallIds = new Set<string>()
        const emittedToolCallIds = new Set<string>()
        const emittedToolResultIds = new Set<string>()

        const getSkillNameForReadPath = (rawPath: string): string => {
          return skillUsageDetector.getSkillNameForReadFilePath(rawPath)
        }

        const emitSkillStart = (toolCallId: string, skillName: string) => {
          if (emittedSkillStartToolCallIds.has(toolCallId)) return
          emittedSkillStartToolCallIds.add(toolCallId)
          skillToolCallIds.set(toolCallId, skillName)
          send({
            type: "execution",
            event: {
              kind: "used_skill",
              id: toolCallId,
              toolCallId,
              name: skillName,
              status: "running",
              timestamp: Date.now(),
            } satisfies DesignExecutionEvent,
          })
        }

        const emitSkillResult = (toolCallId: string, isError: boolean) => {
          if (emittedSkillResultToolCallIds.has(toolCallId)) return
          const skillName = skillToolCallIds.get(toolCallId)
          if (!skillName) return
          emittedSkillResultToolCallIds.add(toolCallId)
          send({
            type: "execution",
            event: {
              kind: "used_skill",
              id: `${toolCallId}:skill-result`,
              toolCallId,
              name: skillName,
              status: isError ? "error" : "success",
              isError,
              timestamp: Date.now(),
            } satisfies DesignExecutionEvent,
          })
        }

        const flushPendingSkillReads = () => {
          for (const [toolCallId, readPath] of pendingSkillReadPathsByToolCallId.entries()) {
            const skillName = getSkillNameForReadPath(readPath)
            if (!skillName) continue

            pendingSkillReadPathsByToolCallId.delete(toolCallId)
            emitSkillStart(toolCallId, skillName)

            const pendingResult = pendingSkillResultsByToolCallId.get(toolCallId)
            if (pendingResult !== undefined) {
              pendingSkillResultsByToolCallId.delete(toolCallId)
              emitSkillResult(toolCallId, pendingResult)
            }
          }
        }

        const rememberSkillMetadata = (skills: Array<{ name?: string; path?: string }>) => {
          skillUsageDetector.onSkillsMetadata(skills)
          flushPendingSkillReads()
        }

        const maybeEmitSkillStart = (toolCall: { id?: string; name?: string; args?: Record<string, unknown> }) => {
          if (toolCall.name !== "read_file" || !toolCall.id) return
          const readPath = getReadFilePath(toolCall.args)
          if (!readPath) return

          const skillName = getSkillNameForReadPath(readPath)
          if (!skillName) {
            pendingSkillReadPathsByToolCallId.set(toolCall.id, readPath)
            return
          }

          emitSkillStart(toolCall.id, skillName)
        }

        const maybeEmitSkillResult = (toolCallId: string, isError: boolean) => {
          if (!skillToolCallIds.has(toolCallId)) {
            if (pendingSkillReadPathsByToolCallId.has(toolCallId)) {
              pendingSkillResultsByToolCallId.set(toolCallId, isError)
              flushPendingSkillReads()
            }
            return
          }
          emitSkillResult(toolCallId, isError)
        }

        // Mid-stream retry loop — mirrors chat module (ipc/agent.ts) behavior so
        // that transient stream interruptions (e.g. `terminated` from a corporate
        // proxy idle timeout, or any error matched by isRetryableApiError) do not
        // surface as a hard error. On retry we rebuild the runtime, then resume
        // from the LangGraph checkpoint without re-sending the human message.
        // Provider "temporarily unavailable" statuses can leave a bad partial
        // checkpoint, so those restart the same request on a clean checkpoint.
        // eslint-disable-next-line no-constant-condition
        while (true) {
        try {
        for await (const rawChunk of stream) {
          if (controller.signal.aborted) break

          const [mode, data] = rawChunk as [string, unknown]

          // Serialize to get stable class path (same as forwardStreamChunk in agent.ts)
          const serialized = serializeStreamData(data)
          if (mode === "values") {
            const state = serialized as {
              skillsMetadata?: Array<{ name?: string; path?: string }>
              messages?: Array<Record<string, unknown>>
            }
            if (Array.isArray(state.skillsMetadata)) {
              rememberSkillMetadata(state.skillsMetadata)
            }
            if (Array.isArray(state.messages)) {
              let startIndex = 0
              for (let index = state.messages.length - 1; index >= 0; index--) {
                const msg = state.messages[index]
                if (getSerializedClassName(msg).includes("Human")) {
                  startIndex = index + 1
                  break
                }
              }

              for (const msg of state.messages.slice(startIndex)) {
                const kwargs = (msg.kwargs ?? {}) as Record<string, unknown>
                const className = getSerializedClassName(msg)
                if (className.includes("AI")) {
                  for (const toolCall of normalizeToolCalls(kwargs.tool_calls)) {
                    if (!toolCall.id) continue
                    maybeEmitSkillStart(toolCall)
                    if (emittedToolCallIds.has(toolCall.id)) continue
                    emittedToolCallIds.add(toolCall.id)
                    send({
                      type: "execution",
                      event: {
                        kind: "tool_call",
                        id: toolCall.id,
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        args: toolCall.args,
                        status: "running",
                        timestamp: Date.now(),
                      } satisfies DesignExecutionEvent,
                    })
                  }
                }
                if (className.includes("Tool")) {
                  const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
                  const resultKey = `${toolCallId || "tool"}:${String(kwargs.id || "")}`
                  if (!toolCallId || emittedToolResultIds.has(resultKey)) continue
                  emittedToolResultIds.add(resultKey)
                  const isError = isToolMessageError(kwargs)
                  send({
                    type: "execution",
                    event: {
                      kind: "tool_result",
                      id: resultKey,
                      toolCallId,
                      name: typeof kwargs.name === "string" ? kwargs.name : undefined,
                      content: extractTextContent(kwargs.content ?? msg.content),
                      isError,
                      status: isError ? "error" : "success",
                      timestamp: Date.now(),
                    } satisfies DesignExecutionEvent,
                  })
                  maybeEmitSkillResult(toolCallId, isError)
                }
              }
            }
            continue
          }

          if (mode !== "messages") continue

          const [msgChunk] = (serialized as unknown[]) as [Record<string, unknown>]
          if (!msgChunk) continue

          const kwargs = (msgChunk.kwargs ?? {}) as Record<string, unknown>
          const className = getSerializedClassName(msgChunk)

          if (className.includes("AI")) {
            for (const toolCall of normalizeToolCalls(kwargs.tool_calls)) {
              if (!toolCall.id) continue
              maybeEmitSkillStart(toolCall)
              if (emittedToolCallIds.has(toolCall.id)) continue
              emittedToolCallIds.add(toolCall.id)
              send({
                type: "execution",
                event: {
                  kind: "tool_call",
                  id: toolCall.id,
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  args: toolCall.args,
                  status: "running",
                  timestamp: Date.now(),
                } satisfies DesignExecutionEvent,
              })
            }
          }

          if (className.includes("Tool")) {
            const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
            const resultKey = `${toolCallId || "tool"}:${String(kwargs.id || "")}`
            if (toolCallId && !emittedToolResultIds.has(resultKey)) {
              emittedToolResultIds.add(resultKey)
              const isError = isToolMessageError(kwargs)
              send({
                type: "execution",
                event: {
                  kind: "tool_result",
                  id: resultKey,
                  toolCallId,
                  name: typeof kwargs.name === "string" ? kwargs.name : undefined,
                  content: extractTextContent(kwargs.content ?? msgChunk.content),
                  isError,
                  status: isError ? "error" : "success",
                  timestamp: Date.now(),
                } satisfies DesignExecutionEvent,
              })
              maybeEmitSkillResult(toolCallId, isError)
            }
            continue
          }

          // Only process AI messages (AIMessageChunk during streaming, AIMessage at end)
          if (!className.includes("AI")) continue

          // Extract text content — can be a plain string or an array of content blocks
          const token = extractTextContent(kwargs.content)
          if (!token) continue

          if (className.includes("Chunk")) {
            streamedText += token
            send({ type: "token", token })
          } else {
            finalMessageText = token
          }
        }
        break  // stream consumed successfully — exit retry loop
        } catch (midStreamErr) {
          if (controller.signal.aborted) throw midStreamErr
          if (!isRetryableApiError(midStreamErr) || midStreamRetriesLeft <= 0) {
            throw midStreamErr
          }
          midStreamRetriesLeft--
          const errMsg = midStreamErr instanceof Error ? midStreamErr.message : String(midStreamErr)
          const resetCheckpoint = shouldResetDesignCheckpointForRetry(midStreamErr)
          console.warn(
            `[Design:Agent] Mid-stream error "${errMsg}", ${resetCheckpoint ? "restarting with fresh checkpoint" : "resuming from checkpoint"} (${midStreamRetriesLeft} retries left)`
          )
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (resetCheckpoint) {
            await closeCheckpointer(threadId)
            deleteThreadCheckpoint(threadId)
            agent = await createDesignAgentRuntime()
            streamedText = ""
            finalMessageText = ""
            stream = await agent.stream({ messages: [humanMessage] }, streamConfig)
          } else {
            // null input = resume from LangGraph checkpoint, do not re-send the human message
            agent = await createDesignAgentRuntime()
            stream = await agent.stream(null, streamConfig)
          }
        }
        }  // end while

        if (controller.signal.aborted) {
          send({ type: "cancelled" })
          return
        }

        // Prefer the complete AIMessage captured from LangGraph values. During
        // mid-stream resume, streamedText may contain partial tokens from a
        // failed attempt plus tokens from the resumed attempt.
        const fullText = finalMessageText || streamedText
        const html = extractHtml(fullText)
        if (html && (html.includes("<!DOCTYPE") || html.includes("<html"))) {
          // Store for potential future reference (storeHtml protocol)
          storeDesignHtml(htmlStoreKey, html)
          const saved = tabId ? saveDesignArtifact(resolvedArtifactId, html, workspacePath) : null
          send({ type: "done", html, ...(saved?.filePath ? { artifactPath: saved.filePath } : {}) })
        } else {
          const artifact = tabId ? readDesignArtifact(resolvedArtifactId, workspacePath) : null
          if (artifact?.success && artifact.html && (artifact.html.includes("<!DOCTYPE") || artifact.html.includes("<html"))) {
            storeDesignHtml(htmlStoreKey, artifact.html)
            send({ type: "done", html: artifact.html, artifactPath: artifact.filePath })
            return
          }
          send({
            type: "error",
            error: fullText.trim()
              ? `模型返回了文本但未找到有效的 HTML。请检查模型配置或重试。\n\n模型输出片段：${fullText.slice(0, 300)}`
              : "生成未返回任何内容，请重试。",
          })
        }
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          console.error("[Design:Agent] Generation error:", msg)
          send({ type: "error", error: msg })
        }
      } finally {
        activeDesignAgents.delete(sessionId)
      }
    }
  )

  // design:cancel — abort an active session
  ipcMain.handle("design:cancel", (_event, sessionId: string) => {
    // Cancel direct-model sessions
    const controller = activeSessions.get(sessionId)
    if (controller) {
      controller.abort()
      activeSessions.delete(sessionId)
    }
    // Cancel agent-runtime sessions
    const agentCtrl = activeDesignAgents.get(sessionId)
    if (agentCtrl) {
      agentCtrl.abort()
      activeDesignAgents.delete(sessionId)
    }
  })

  // design:save-variant — persist a single variation HTML to disk
  ipcMain.handle(
    "design:save-variant",
    (_event, variantId: string, html: string): { filePath: string } => {
      const dir = path.join(app.getPath("userData"), "design-variants")
      fs.mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const filename = `variant-${variantId}-${ts}.html`
      const filePath = path.join(dir, filename)
      fs.writeFileSync(filePath, html, "utf-8")
      cleanupSavedVariants(dir)
      console.log(`[Design] Saved variant ${variantId} → ${filePath}`)
      return { filePath }
    }
  )
}

// ─────────────────────────────────────────────────────────
// HTML extraction helper
// ─────────────────────────────────────────────────────────

function extractHtml(text: string): string {
  // 1. 过滤 <think>...</think> 内容（支持多段、换行）
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()

  // 2. 去掉 ```html ... ``` 代码块标记
  const fenced = cleaned.match(/```html\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  // 3. 如果直接以 HTML 声明开头，直接返回
  if (cleaned.startsWith("<!DOCTYPE") || cleaned.startsWith("<html")) return cleaned

  // Agent Runtime may emit a short preamble before the final HTML after tool use.
  const doctypeIndex = cleaned.search(/<!DOCTYPE/i)
  if (doctypeIndex >= 0) return cleaned.slice(doctypeIndex).trim()

  const htmlIndex = cleaned.search(/<html[\s>]/i)
  if (htmlIndex >= 0) return cleaned.slice(htmlIndex).trim()

  return cleaned
}

function parseQuestionsJson(text: string): unknown[] {
  // Strip <think> blocks (some models emit reasoning inside these before the answer)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  // Strip markdown code fences
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) cleaned = fenced[1].trim()

  // Use bracket-balancing to find the JSON array — avoids the greedy regex problem
  // where /\[[\s\S]*\]/ can match from the first '[' to the LAST ']' in the document,
  // swallowing any trailing text (e.g. "See [these] examples.") and breaking JSON.parse.
  const start = cleaned.indexOf("[")
  if (start === -1) {
    console.error("[Design] parseQuestionsJson: no '[' found in model output:", cleaned.slice(0, 200))
    return []
  }

  let depth = 0
  let inString = false
  let escape = false
  let end = -1

  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (escape) { escape = false; continue }
    if (c === "\\" && inString) { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") {
      depth--
      if (depth === 0 && c === "]") { end = i; break }
    }
  }

  if (end === -1) {
    console.error("[Design] parseQuestionsJson: unmatched brackets in model output:", cleaned.slice(0, 200))
    return []
  }

  const jsonSlice = cleaned.slice(start, end + 1)

  // Attempt 1: parse as-is
  try {
    const parsed = JSON.parse(jsonSlice) as unknown[]
    if (Array.isArray(parsed)) {
      console.log(`[Design] parseQuestionsJson: parsed ${parsed.length} questions`)
      return parsed
    }
  } catch {
    // fall through to repair attempts
  }

  // Attempt 2: strip trailing commas — the most common model mistake
  // Matches a comma immediately before a closing ] or } (optionally with whitespace in between)
  const repaired = jsonSlice.replace(/,(\s*[}\]])/g, "$1")
  try {
    const parsed = JSON.parse(repaired) as unknown[]
    if (Array.isArray(parsed)) {
      console.log(`[Design] parseQuestionsJson: parsed ${parsed.length} questions (after trailing-comma repair)`)
      return parsed
    }
  } catch {
    // fall through
  }

  // Attempt 3: also escape unescaped literal newlines/tabs inside string values.
  // Walk the string character-by-character so we only escape inside JSON strings.
  let repaired2 = ""
  let inStr = false
  let esc = false
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i]
    if (esc) { repaired2 += ch; esc = false; continue }
    if (ch === "\\" && inStr) { repaired2 += ch; esc = true; continue }
    if (ch === '"') { inStr = !inStr; repaired2 += ch; continue }
    if (inStr && ch === "\n") { repaired2 += "\\n"; continue }
    if (inStr && ch === "\r") { repaired2 += "\\r"; continue }
    if (inStr && ch === "\t") { repaired2 += "\\t"; continue }
    repaired2 += ch
  }
  try {
    const parsed = JSON.parse(repaired2) as unknown[]
    if (Array.isArray(parsed)) {
      console.log(`[Design] parseQuestionsJson: parsed ${parsed.length} questions (after full repair)`)
      return parsed
    }
  } catch (err) {
    console.error("[Design] parseQuestionsJson: all parse attempts failed:", err, "\nSlice:", jsonSlice.slice(0, 500))
  }

  return []
}
