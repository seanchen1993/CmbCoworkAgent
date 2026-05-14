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

const DESIGN_MODEL_MAX_RETRY_ATTEMPTS = 11 // 1 initial request + 10 retries
const DESIGN_BROWSER_VALIDATION_TIMEOUT_MS = 8000
const DESIGN_BROWSER_VALIDATION_SETTLE_MS = 800
const DESIGN_BROWSER_AUTO_FIX_ATTEMPTS = 1
const DESIGN_ARTIFACT_CONTINUATION_MAX_ATTEMPTS = 30
const DESIGN_ARTIFACT_CONTINUATION_STALL_ATTEMPTS = 2
const DESIGN_ARTIFACT_WRITE_RECOVERY_ATTEMPTS = 2
const DESIGN_CHINESE_RESPONSE_INSTRUCTION = `\n\n## Response language\n\n- 始终使用中文输出所有面向用户可见的文本，包括执行过程说明、技能使用说明、工具前后的简短说明、错误解释和最终摘要。\n- 即使读取到的 Skill、参考文件或系统上下文是英文，也要把面向用户展示的过程和总结翻译成中文。\n- 代码、HTML/CSS/JS 标识符、文件路径、工具名和必须保持原样的业务文案不需要翻译。`

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

## Reading and writing design files

Filesystem tool schema is mandatory:
- Use only these top-level argument names: \`read_file({ file_path, offset, limit })\`, \`write_file({ file_path, content })\`, and \`edit_file({ file_path, old_string, new_string, replace_all })\`.
- Every \`read_file\` call must include a non-empty string \`file_path\`. For HTML artifacts, uploaded HTML/context files, selected \`SKILL.md\` files, or files you must understand before editing, also include numeric \`offset\` and \`limit\`.
- Every \`write_file\` call must include non-empty string \`file_path\` and string \`content\`. Every \`edit_file\` call must include non-empty string \`file_path\`, \`old_string\`, and \`new_string\`; set \`replace_all\` explicitly when replacing more than one occurrence.
- Do not use \`path\`, \`filePath\`, \`targetPath\`, \`input\`, \`params\`, \`arguments\`, \`oldString\`, \`newString\`, \`oldText\`, \`newText\`, \`replace\`, or \`replacement\` as tool argument names. Do not wrap tool arguments inside another object.
- If a filesystem tool call fails with "Invalid tool arguments", retry the same filesystem operation using the exact schema above. Do not switch to execute/bash/shell/Python to write or verify the design artifact.

Use file reads deliberately for HTML and design source files:
- For Design HTML work, these rules override generic codebase-exploration guidance that suggests an initial 100-line scan.
- \`read_file\` defaults to 500 lines. For HTML artifacts, uploaded HTML/context files, selected \`SKILL.md\` files, or files you must understand before editing, do not rely on the default.
- Start with \`read_file\` using \`offset=0\` and \`limit=1000\`. If the tool result indicates there are more lines, continue from the returned offset until you understand the relevant structure.
- For very large HTML, use focused search and targeted reads to locate \`<!DOCTYPE\`, \`<head>\`, \`<style>\`, \`<body>\`, variation containers, \`EDITMODE-BEGIN\`/\`EDITMODE-END\`, scripts, postMessage handlers, and the exact sections the user asked about. Do not repeatedly reread only the first page.
- When iterating on an existing artifact, preserve IDs, variation wrappers, tweak keys, EDITMODE markers, scripts, postMessage listeners, data attributes, and unrelated content unless the user explicitly asks to change them.
- Read only the uploaded/context/resource files needed for the request. Do not copy unrelated assets or bulk-import resource folders.

When writing:
- Write exactly one complete standalone HTML artifact to the provided artifact path. Do not split the final deliverable into external support files.
- Keep the artifact compact and maintainable: avoid unnecessary generated bulk, duplicated CSS, huge embedded data, and copied assets that are not used.
- Use \`write_file\` for a new output artifact. If updating an existing artifact, use \`edit_file\` only when the replacement is small and reliable; otherwise write the complete final HTML artifact.
- Do not assume \`write_file\` has a content-size limit, and do not claim the file is being truncated unless the \`write_file\` tool result explicitly reports that exact error.
- Prefer writing the complete artifact in one \`write_file\` call when practical. If the artifact is too large to produce safely in one tool call, use a chunked file-writing strategy: first write a complete HTML skeleton containing unique insertion markers, then call \`edit_file\` repeatedly to replace one marker with an HTML chunk plus the next marker, then remove every temporary marker before finishing.
- After writing, verify the artifact with \`read_file({ file_path, offset: 0, limit: 1000 })\` and continue with later offsets if needed. Confirm the file contains one complete HTML document, required EditMode markers, and no leftover temporary insertion markers.
- After writing the file, respond only with a brief summary.

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
` + DESIGN_CHINESE_RESPONSE_INSTRUCTION

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
  const requestedModelId = modelId?.trim()
  const selectedModelId = requestedModelId?.startsWith("custom:")
    ? requestedModelId.slice("custom:".length)
    : requestedModelId
  const config = selectedModelId
    ? (configs.find((c) => c.id === selectedModelId) ?? configs[0])
    : configs[0]
  if (!config || !config.apiKey) return null
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseUrl,
      fetch: retryHooks ? createRetryingFetch(retryHooks, DESIGN_MODEL_MAX_RETRY_ATTEMPTS) : undefined,
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

function makeDesignAgentRepairThreadId(baseThreadId: string, attempt: number): string {
  const suffix = `_repair_${attempt}`
  return `${baseThreadId.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`
}

function makeDesignAgentArtifactRecoveryThreadId(baseThreadId: string, attempt: number): string {
  const suffix = `_artifact_recovery_${attempt}`
  return `${baseThreadId.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`
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
  kind: "tool_call" | "tool_result" | "used_skill" | "assistant_text" | "validation"
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

interface DesignBrowserValidationIssue {
  type: "console" | "load" | "crash" | "timeout"
  message: string
  source?: string
  line?: number
}

interface DesignBrowserValidationResult {
  ok: boolean
  issues: DesignBrowserValidationIssue[]
}

const DESIGN_BROWSER_RUNTIME_ERROR_RE =
  /^\[DesignValidation(?:Error|UnhandledRejection)\]\s*(.*)$/i

function formatDesignBrowserValidation(result: DesignBrowserValidationResult): string {
  if (result.issues.length === 0) return "浏览器运行校验通过"
  return result.issues
    .slice(0, 8)
    .map((issue, index) => {
      const location = issue.source
        ? ` (${issue.source}${typeof issue.line === "number" ? `:${issue.line}` : ""})`
        : ""
      return `${index + 1}. [${issue.type}] ${issue.message}${location}`
    })
    .join("\n")
}

function injectDesignBrowserValidationProbe(html: string): string {
  const probe = `<script>
window.addEventListener('error', function(event) {
  var message = event && event.message ? event.message : 'Unknown runtime error';
  var source = event && event.filename ? event.filename : '';
  var line = event && event.lineno ? ':' + event.lineno : '';
  console.error('[DesignValidationError] ' + message + (source ? ' @ ' + source + line : ''));
});
window.addEventListener('unhandledrejection', function(event) {
  var reason = event && event.reason;
  var message = reason && reason.stack ? reason.stack : reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection');
  console.error('[DesignValidationUnhandledRejection] ' + message);
});
</script>`

  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n${probe}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${probe}\n</head>`)
  return `${probe}\n${html}`
}

function waitForDesignBrowserValidation(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createDesignAbortError())
      return
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(createDesignAbortError())
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function validateDesignArtifactInHiddenBrowser(
  filePath: string,
  signal: AbortSignal
): Promise<DesignBrowserValidationResult> {
  const issues: DesignBrowserValidationIssue[] = []
  let validationWindow: BrowserWindow | null = null

  try {
    validationWindow = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const webContents = validationWindow.webContents
    webContents.on("console-message", (details, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
      const eventDetails = details as unknown as {
        level?: unknown
        message?: unknown
        lineNumber?: unknown
        sourceId?: unknown
      }
      const level = typeof eventDetails.level === "string" ? eventDetails.level : legacyLevel === 3 ? "error" : ""
      if (level !== "error") return
      const message = typeof eventDetails.message === "string" ? eventDetails.message : legacyMessage
      if (!message) return
      const runtimeError = message.match(DESIGN_BROWSER_RUNTIME_ERROR_RE)
      if (!runtimeError) return
      issues.push({
        type: "console",
        message: runtimeError[1]?.trim() || message,
        source: typeof eventDetails.sourceId === "string" ? eventDetails.sourceId : legacySourceId,
        line: typeof eventDetails.lineNumber === "number" ? eventDetails.lineNumber : legacyLine,
      })
    })
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return
      if (errorCode === -3) return
      issues.push({
        type: "load",
        message: `${errorDescription || "页面加载失败"} (${errorCode})`,
        source: validatedURL,
      })
    })
    webContents.on("render-process-gone", (_event, details) => {
      issues.push({
        type: "crash",
        message: `渲染进程退出：${details.reason}${details.exitCode !== undefined ? ` (${details.exitCode})` : ""}`,
      })
    })

    const loadPromise = validationWindow.loadFile(filePath)
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Browser validation timed out"))
      }, DESIGN_BROWSER_VALIDATION_TIMEOUT_MS)
      loadPromise.finally(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout))
    })

    try {
      await Promise.race([loadPromise, timeoutPromise])
      await waitForDesignBrowserValidation(DESIGN_BROWSER_VALIDATION_SETTLE_MS, signal)
    } catch (err) {
      if (signal.aborted) throw err
      issues.push({
        type: err instanceof Error && err.message === "Browser validation timed out" ? "timeout" : "load",
        message: err instanceof Error ? err.message : String(err),
      })
    }

    return { ok: issues.length === 0, issues }
  } finally {
    if (validationWindow && !validationWindow.isDestroyed()) {
      validationWindow.destroy()
    }
  }
}

function sameResolvedFilePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function writeDesignArtifactSourceSnapshot(outputFilePath: string, html: string): DesignArtifactFileReadResult {
  try {
    if (!html.trim()) return { success: false, error: "Design source snapshot content is empty" }
    const dir = path.dirname(outputFilePath)
    fs.mkdirSync(dir, { recursive: true })
    const snapshotPath = path.join(dir, `.source-${Date.now()}.html`)
    fs.writeFileSync(snapshotPath, html, "utf-8")
    return { success: true, filePath: snapshotPath, html }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function makeDesignArtifactDraftPath(outputFilePath: string): string {
  const dir = path.dirname(outputFilePath)
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return path.join(dir, `.draft-${unique}.html`)
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
      ? `Read the current design source artifact first with read_file using offset=0 and limit=1000. If more lines are available, continue from the returned offset until the relevant HTML structure is understood:\n${sourceFilePath}\n\n`
      : "") +
    `Write the new complete standalone HTML artifact to this exact absolute output file path:\n${filePath}\n\n` +
    `${exists ? "The output artifact already exists. Before editing it, read it with read_file using offset=0 and limit=1000. If more lines are available, continue from the returned offset until the relevant HTML structure is understood." : "The output artifact does not exist yet. Create it with write_file."}\n` +
    `If a source artifact path is provided, use it only as input/reference and write the updated complete HTML to the output file path above. ` +
    `Use write_file for a new output artifact, or edit_file only if the output file already exists. ` +
    `When calling filesystem tools, use the exact argument names required by the tools: ` +
    `read_file({ file_path, offset, limit }), write_file({ file_path, content }), and edit_file({ file_path, old_string, new_string, replace_all }). ` +
    `Every read_file call MUST include a non-empty string file_path. For HTML artifacts, uploaded HTML/context files, selected SKILL.md files, or any file you must understand before editing, read_file MUST also include numeric offset and limit. ` +
    `If you do not have an exact file path, skip that optional read; never call read_file with an omitted, undefined, empty, placeholder, or guessed file_path. ` +
    `Never use placeholder paths such as TD_PATH, TBD_PATH, OUTPUT_PATH, FILE_PATH, <path>, or [path]. Use only the exact absolute paths printed in this instruction or paths returned by tools. ` +
    `Do not use path, filePath, targetPath, input, params, arguments, oldString, newString, oldText, newText, replace, or replacement as tool argument names. ` +
    `Do not wrap tool arguments inside another object. The top-level tool arguments must exactly match the tool schema. ` +
    `Do not assume write_file has a content-size limit, and do not claim the file is being truncated unless the write_file tool result explicitly reports that exact error. ` +
    `A read_file result like "[Lines 1-145 of 300. Use offset=145 to read more.]" means pagination, not truncation. Continue with the instructed offset when more context is needed; do not delete or rebuild a file just because read_file returned a page of lines. ` +
    `Use write_file only for the first creation of a non-existent output artifact. After any successful write_file to the output path, all later changes to that same path must use edit_file. If write_file reports that the file already exists, do not retry write_file and do not claim the file was deleted; read_file the existing output path, then use edit_file to replace the current content or temporary markers. ` +
    `Prefer writing the complete artifact in one write_file call when practical. If the artifact is too large to produce safely in one tool call, use a chunked file-writing strategy: first call write_file with BOTH required fields exactly as write_file({ file_path: "${filePath}", content: "<!DOCTYPE html>...unique insertion markers...</html>" }), then call edit_file repeatedly with ALL required fields exactly as edit_file({ file_path: "${filePath}", old_string: "UNIQUE_MARKER", new_string: "HTML chunk plus next marker", replace_all: false }), then remove every temporary marker before finishing. ` +
    `Every write_file call MUST include a non-empty string file_path and content. Every edit_file call MUST include non-empty string file_path, old_string, and new_string. ` +
    `To verify the artifact after writing, use read_file({ file_path: "${filePath}", offset: 0, limit: 1000 }) and continue with later offsets if needed; do not use shell commands for verification. ` +
    `If a tool call fails with "Invalid tool arguments", retry the same filesystem operation using the exact schema above; do not switch to execute/bash/shell/Python. ` +
    `You may use subagents only for reading or analyzing reference materials. Do not delegate final artifact writing, chunk insertion, artifact verification, or filesystem recovery to a subagent; the main Design agent must perform those steps directly with read_file/write_file/edit_file. ` +
    `Do not use execute/bash/shell/Python commands to create, overwrite, append, encode, decode, redirect, copy, or move the final design artifact. ` +
    `Do not paste the full HTML into the final chat response. After the file is updated, respond with only a brief summary of what changed. ` +
    `The host application will read and render the HTML from this file.`
}

function getSerializedClassName(msg: Record<string, unknown>): string {
  const classId: string[] = Array.isArray(msg.id) ? (msg.id as string[]) : []
  return classId[classId.length - 1] ?? ""
}

interface AccumulatedDesignToolCall {
  id: string
  name: string
  argsText: string
}

type NormalizedDesignToolCall = { id?: string; name?: string; args?: Record<string, unknown> }

const DESIGN_PLACEHOLDER_FILE_PATH_RE =
  /^(?:TD_PATH|TBD_PATH|TODO_PATH|OUTPUT_PATH|ARTIFACT_PATH|FILE_PATH|PATH|<[^>]+>|\[[^\]]+\])$/i
const DESIGN_PROGRESS_ONLY_TEXT_RE =
  /^(?:我(?:先|来)?|让我|现在|接下来).{0,80}(?:读取|分析|查看|理解|检查|构建|生成|还原|开始)/u
const DESIGN_TOOL_MESSAGE_ERROR_RE =
  /(?:^|\n)\s*(?:Error\b|Cannot\b|Failed\b|Invalid\b|String not found\b|Multiple occurrences found\b|\[Hook blocked\])/i

function truncateDesignToolString(value: string, limit = 500): string {
  return value.length > limit ? `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]` : value
}

function isPlaceholderDesignFilePath(rawPath: string): boolean {
  return DESIGN_PLACEHOLDER_FILE_PATH_RE.test(rawPath.trim())
}

function isLikelyDesignProgressOnlyText(rawText: string): boolean {
  const text = rawText.trim()
  if (!text) return false
  if (text.includes("<!DOCTYPE") || /<html[\s>]/i.test(text)) return false
  return text.length <= 500 && DESIGN_PROGRESS_ONLY_TEXT_RE.test(text)
}

function sanitizeDesignToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const isLargeTextArg = key === "content" || key === "old_string" || key === "new_string"
      sanitized[key] = isLargeTextArg
        ? `[${value.length} chars]`
        : truncateDesignToolString(value)
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}

function parseDesignToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return sanitizeDesignToolArgs(raw as Record<string, unknown>)
  }
  if (typeof raw !== "string" || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return sanitizeDesignToolArgs(parsed as Record<string, unknown>)
    }
  } catch {
    // Streaming tool-call args are often incomplete JSON until the final chunk.
  }
  return {}
}

function normalizeToolCalls(raw: unknown): NormalizedDesignToolCall[] {
  if (!Array.isArray(raw)) return []
  const normalized: NormalizedDesignToolCall[] = []
  for (const toolCall of raw) {
    if (!toolCall || typeof toolCall !== "object") continue
    const item = toolCall as {
      id?: unknown
      name?: unknown
      args?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }
    const rawArgs = item.args ?? item.function?.arguments
    normalized.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string"
        ? item.name
        : typeof item.function?.name === "string"
          ? item.function.name
          : undefined,
      args: parseDesignToolArgs(rawArgs),
    })
  }
  return normalized
}

function normalizeToolCallChunks(
  raw: unknown,
  accumulatedById: Map<string, AccumulatedDesignToolCall>,
  scope = "stream"
): NormalizedDesignToolCall[] {
  if (!Array.isArray(raw)) return []
  const normalized: NormalizedDesignToolCall[] = []

  for (let index = 0; index < raw.length; index++) {
    const chunk = raw[index]
    if (!chunk || typeof chunk !== "object") continue
    const item = chunk as { id?: unknown; name?: unknown; args?: unknown; index?: unknown }
    const toolCallId = typeof item.id === "string" && item.id
      ? item.id
      : `streaming-tool-call:${scope}:${typeof item.index === "number" ? item.index : index}`

    let accumulated = accumulatedById.get(toolCallId)
    if (!accumulated) {
      accumulated = { id: toolCallId, name: "", argsText: "" }
      accumulatedById.set(toolCallId, accumulated)
    }

    if (typeof item.name === "string" && item.name) {
      accumulated.name = item.name
    }
    if (typeof item.args === "string") {
      accumulated.argsText += item.args
    } else if (item.args && typeof item.args === "object" && !Array.isArray(item.args)) {
      accumulated.argsText = JSON.stringify(item.args)
    }

    if (!accumulated.name) continue
    normalized.push({
      id: accumulated.id,
      name: accumulated.name,
      args: parseDesignToolArgs(accumulated.argsText)
    })
  }

  return normalized
}

function getAdditionalKwargsToolCalls(kwargs: Record<string, unknown>): unknown {
  const additionalKwargs = kwargs.additional_kwargs
  if (!additionalKwargs || typeof additionalKwargs !== "object" || Array.isArray(additionalKwargs)) return undefined
  return (additionalKwargs as Record<string, unknown>).tool_calls
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
  const content = extractTextContent(kwargs.content)
  return (
    kwargs.status === "error" ||
    kwargs.is_error === true ||
    (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.is_error === true ||
    DESIGN_TOOL_MESSAGE_ERROR_RE.test(content)
  )
}

function isPlaceholderDesignFileToolCall(toolCall: { name?: string; args?: Record<string, unknown> }): boolean {
  if (toolCall.name !== "read_file" && toolCall.name !== "write_file" && toolCall.name !== "edit_file") return false
  const rawPath = toolCall.args?.file_path ?? toolCall.args?.path
  return typeof rawPath === "string" && isPlaceholderDesignFilePath(rawPath)
}

function normalizeDesignSkillReference(raw: unknown): { name: string; path: string } | null {
  if (!raw || typeof raw !== "object") return null
  const skill = raw as DesignSkillReference
  const name = typeof skill.name === "string" ? skill.name.trim() : ""
  const skillPath = typeof skill.path === "string" ? skill.path.trim() : ""
  if (!name || !skillPath) return null
  return { name, path: skillPath }
}

function validateDesignSkillFile(skillPath: string): { resolvedPath?: string; sizeBytes?: number; error?: string } {
  try {
    const resolvedPath = path.resolve(skillPath)
    if (!fs.existsSync(resolvedPath)) return { error: `Skill file not found: ${skillPath}` }
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) return { error: `Skill path is not a file: ${skillPath}` }
    if (path.basename(resolvedPath) !== "SKILL.md") return { error: `Skill path must point to SKILL.md: ${skillPath}` }
    return { resolvedPath, sizeBytes: stat.size }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function buildSelectedDesignSkillContext(skillName: string, skillPath: string): string {
  return `\n\n---\n[Selected Design Skill: ${skillName}]\n` +
    `The user explicitly selected this skill for the current design request. ` +
    `Before doing any design or file-writing work, you MUST first read this SKILL.md with read_file using offset=0 and limit=1000, then follow its instructions.\n` +
    `Selected skill path: ${skillPath}\n` +
    `If the SKILL.md references supporting files, read only the files needed for this request. Still obey the Design artifact rules above.\n` +
    `Any user-visible progress notes or summaries you emit while using this skill must be written in Chinese.`
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

function createDesignAbortError(): Error {
  const error = new Error("Aborted")
  error.name = "AbortError"
  return error
}

function sleepDesignRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createDesignAbortError())
      return
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(createDesignAbortError())
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
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

      const abortAgentSession = () => {
        if (!controller.signal.aborted) {
          controller.abort()
        }
      }

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

          const result = validateDesignSkillFile(selectedSkill.path)
          if (result.resolvedPath) {
            skillContext = buildSelectedDesignSkillContext(selectedSkill.name, result.resolvedPath)
            console.log("[Design:Skill] Selected skill referenced without inline content:", {
              name: selectedSkill.name,
              path: result.resolvedPath,
              sizeBytes: result.sizeBytes ?? 0
            })
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
        const currentHtmlSource = typeof currentHtml === "string" && currentHtml.trim()
          ? currentHtml
          : ""
        const outputArtifactPath = preparedArtifact.filePath
        const draftArtifactPath = makeDesignArtifactDraftPath(outputArtifactPath)
        const sourcePathIsOutput = sameResolvedFilePath(sourceArtifact.filePath, outputArtifactPath)
        let sourceFilePathForPrompt: string | undefined

        if (currentHtmlSource) {
          const snapshot = writeDesignArtifactSourceSnapshot(outputArtifactPath, currentHtmlSource)
          if (!snapshot.success || !snapshot.filePath) {
            send({ type: "error", error: snapshot.error ?? "Failed to snapshot current design HTML" })
            return
          }
          sourceFilePathForPrompt = snapshot.filePath
        } else if (sourceArtifact.success && sourceArtifact.filePath && !sourcePathIsOutput) {
          sourceFilePathForPrompt = sourceArtifact.filePath
        } else if (sourceArtifact.success && sourcePathIsOutput && sourceArtifact.html?.trim()) {
          const snapshot = writeDesignArtifactSourceSnapshot(outputArtifactPath, sourceArtifact.html)
          if (!snapshot.success || !snapshot.filePath) {
            send({ type: "error", error: snapshot.error ?? "Failed to snapshot source design artifact" })
            return
          }
          sourceFilePathForPrompt = snapshot.filePath
        } else if (sourceArtifactPath && existingOutputArtifact.success && existingOutputArtifact.html?.trim()) {
          const snapshot = writeDesignArtifactSourceSnapshot(outputArtifactPath, existingOutputArtifact.html)
          if (!snapshot.success || !snapshot.filePath) {
            send({ type: "error", error: snapshot.error ?? "Failed to snapshot existing design artifact" })
            return
          }
          sourceFilePathForPrompt = snapshot.filePath
        }

        const hasExistingArtifactHtml = Boolean(
          currentHtmlSource
        ) || Boolean(
          sourceFilePathForPrompt
        ) || Boolean(
          sourceArtifact.success && sourceArtifact.html?.trim() && !sourcePathIsOutput
        ) || Boolean(
          existingOutputArtifact.success && existingOutputArtifact.html?.trim() && sourceArtifactPath
        )
        const artifactInstruction = buildDesignArtifactInstruction(
          draftArtifactPath,
          false,
          sourceFilePathForPrompt
        )

        const makeStreamConfig = (runtimeThreadId: string) => ({
          configurable: { thread_id: runtimeThreadId },
          signal: controller.signal,
          streamMode: ["messages", "values"] as ("messages" | "values")[],
          recursionLimit: 200,
        })

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

        let candidateDraftPath = draftArtifactPath
        let wroteCandidateDraft = false
        const shouldResetInitialCheckpoint = !hasExistingArtifactHtml && !htmlForIteration

        const makeHumanMessage = (messageText: string) =>
          imageData && mimeType
            ? new HumanMessage({
                content: [
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${imageData}`, detail: "high" },
                  },
                  { type: "text", text: messageText },
                ],
              })
            : new HumanMessage(messageText)

        const createDesignAgentRuntimeForThread = (runtimeThreadId: string) => createAgentRuntime({
          threadId: runtimeThreadId,
          workspacePath,
          modelId,
          systemPromptOverride: DESIGN_SYSTEM_PROMPT,
          noSchedulerTool: true,
          noSkillEvolutionTool: true,
          enableAgentsPrompt: false,
          abortSignal: controller.signal,
          retryHooks: buildDesignModelRetryHooks(send),
          maxRetryAttempts: DESIGN_MODEL_MAX_RETRY_ATTEMPTS,
          onFileMutation: (filePath) => {
            if (sameResolvedFilePath(filePath, candidateDraftPath)) {
              wroteCandidateDraft = true
            }
          },
        })

        const skillUsageDetector = new SkillUsageDetector()
        const skillToolCallIds = new Map<string, string>()
        const pendingSkillReadPathsByToolCallId = new Map<string, string>()
        const pendingSkillResultsByToolCallId = new Map<string, boolean>()
        const emittedSkillStartToolCallIds = new Set<string>()
        const emittedSkillResultToolCallIds = new Set<string>()
        const emittedToolCallIds = new Set<string>()
        const emittedToolResultIds = new Set<string>()
        const emittedAssistantTextIds = new Set<string>()
        const accumulatedToolCallChunks = new Map<string, AccumulatedDesignToolCall>()

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

        const emitAssistantText = (id: string, content: string) => {
          if (!content.trim() || emittedAssistantTextIds.has(id)) return
          emittedAssistantTextIds.add(id)
          send({
            type: "execution",
            event: {
              kind: "assistant_text",
              id,
              content,
              status: "running",
              timestamp: Date.now(),
            } satisfies DesignExecutionEvent,
          })
        }

        const createInitialDesignStream = async (
          runtimeThreadId: string,
          runtimeAgent: Awaited<ReturnType<typeof createDesignAgentRuntimeForThread>>,
          humanMessage: HumanMessage
        ): Promise<AsyncIterable<unknown>> => {
          let initialStreamRetriesLeft = 2
          let currentAgent = runtimeAgent
          const runtimeStreamConfig = makeStreamConfig(runtimeThreadId)
          // eslint-disable-next-line no-constant-condition
          while (true) {
            try {
              return await currentAgent.stream({ messages: [humanMessage] }, runtimeStreamConfig)
            } catch (initialStreamErr) {
              if (controller.signal.aborted) throw initialStreamErr
              if (!isRetryableApiError(initialStreamErr) || initialStreamRetriesLeft <= 0) {
                throw initialStreamErr
              }
              initialStreamRetriesLeft--
              const errMsg = initialStreamErr instanceof Error ? initialStreamErr.message : String(initialStreamErr)
              const resetCheckpoint = shouldResetDesignCheckpointForRetry(initialStreamErr)
              console.warn(
                `[Design:Agent] Initial stream error "${errMsg}", ${resetCheckpoint ? "restarting with fresh checkpoint" : "retrying initial stream"} (${initialStreamRetriesLeft} retries left)`
              )
              await sleepDesignRetryDelay(500, controller.signal)
              if (resetCheckpoint) {
                await closeCheckpointer(runtimeThreadId)
                deleteThreadCheckpoint(runtimeThreadId)
              }
              currentAgent = await createDesignAgentRuntimeForThread(runtimeThreadId)
            }
          }
        }

        const runDesignAgentOnce = async (
          messageText: string,
          runtimeThreadId: string
        ): Promise<{ html?: string; fullText: string }> => {
          let runtimeAgent = await createDesignAgentRuntimeForThread(runtimeThreadId)
          const humanMessage = makeHumanMessage(messageText)
          let stream = await createInitialDesignStream(runtimeThreadId, runtimeAgent, humanMessage)
          const runtimeStreamConfig = makeStreamConfig(runtimeThreadId)
          let midStreamRetriesLeft = 2
          let streamedText = ""
          let finalMessageText = ""

          // Mid-stream retry loop mirrors chat module (ipc/agent.ts). Retryable
          // stream interruptions rebuild the runtime and resume from checkpoint;
          // provider unavailable statuses restart from a clean checkpoint.
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
                        const emitToolCall = (toolCall: NormalizedDesignToolCall) => {
                          if (!toolCall.id) return
                          emittedToolCallIds.add(toolCall.id)
                          maybeEmitSkillStart(toolCall)
                          const placeholderPath = isPlaceholderDesignFileToolCall(toolCall)
                          send({
                            type: "execution",
                            event: {
                              kind: "tool_call",
                              id: toolCall.id,
                              toolCallId: toolCall.id,
                              name: toolCall.name,
                              args: toolCall.args,
                              status: placeholderPath ? "error" : "running",
                              isError: placeholderPath,
                              content: placeholderPath
                                ? "文件工具调用使用了占位符路径，请改用指令里的绝对路径。"
                                : undefined,
                              timestamp: Date.now(),
                            } satisfies DesignExecutionEvent,
                          })
                        }

                        const assistantText = extractTextContent(kwargs.content ?? msg.content)
                        if (assistantText && !className.includes("Chunk")) {
                          emitAssistantText(`assistant:${String(kwargs.id || msg.id || Date.now())}`, assistantText)
                        }
                        const scope = String(kwargs.id || msg.id || "values")
                        for (const toolCall of normalizeToolCallChunks(kwargs.tool_call_chunks, accumulatedToolCallChunks, scope)) {
                          emitToolCall(toolCall)
                        }
                        for (const toolCall of normalizeToolCalls(kwargs.tool_calls)) {
                          emitToolCall(toolCall)
                        }
                        for (const toolCall of normalizeToolCalls(getAdditionalKwargsToolCalls(kwargs))) {
                          emitToolCall(toolCall)
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
                  const emitToolCall = (toolCall: NormalizedDesignToolCall) => {
                    if (!toolCall.id) return
                    emittedToolCallIds.add(toolCall.id)
                    maybeEmitSkillStart(toolCall)
                    const placeholderPath = isPlaceholderDesignFileToolCall(toolCall)
                    send({
                      type: "execution",
                      event: {
                        kind: "tool_call",
                        id: toolCall.id,
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        args: toolCall.args,
                        status: placeholderPath ? "error" : "running",
                        isError: placeholderPath,
                        content: placeholderPath
                          ? "文件工具调用使用了占位符路径，请改用指令里的绝对路径。"
                          : undefined,
                        timestamp: Date.now(),
                      } satisfies DesignExecutionEvent,
                    })
                  }

                  const scope = String(kwargs.id || "messages")
                  for (const toolCall of normalizeToolCallChunks(kwargs.tool_call_chunks, accumulatedToolCallChunks, scope)) {
                    emitToolCall(toolCall)
                  }
                  for (const toolCall of normalizeToolCalls(kwargs.tool_calls)) {
                    emitToolCall(toolCall)
                  }
                  for (const toolCall of normalizeToolCalls(getAdditionalKwargsToolCalls(kwargs))) {
                    emitToolCall(toolCall)
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

                // Extract text content, which can be a plain string or content blocks.
                const token = extractTextContent(kwargs.content)
                if (!token) continue

                if (className.includes("Chunk")) {
                  streamedText += token
                  send({ type: "token", token })
                } else {
                  finalMessageText = token
                }
              }
              break
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
              await sleepDesignRetryDelay(500, controller.signal)
              if (resetCheckpoint) {
                await closeCheckpointer(runtimeThreadId)
                deleteThreadCheckpoint(runtimeThreadId)
                runtimeAgent = await createDesignAgentRuntimeForThread(runtimeThreadId)
                streamedText = ""
                finalMessageText = ""
                stream = await runtimeAgent.stream({ messages: [humanMessage] }, runtimeStreamConfig)
              } else {
                // null input = resume from LangGraph checkpoint, do not re-send the human message
                runtimeAgent = await createDesignAgentRuntimeForThread(runtimeThreadId)
                stream = await runtimeAgent.stream(null, runtimeStreamConfig)
              }
            }
          }

          if (controller.signal.aborted) {
            throw createDesignAbortError()
          }

          // Prefer the complete AIMessage captured from LangGraph values. During
          // mid-stream resume, streamedText may contain partial tokens from a
          // failed attempt plus tokens from the resumed attempt.
          const fullText = finalMessageText || streamedText
          const html = extractHtml(fullText)
          return { html: html && isCompleteHtmlDocument(html) ? html : undefined, fullText }
        }

        if (shouldResetInitialCheckpoint) {
          await closeCheckpointer(threadId)
          deleteThreadCheckpoint(threadId)
        }

        const initialResult = await runDesignAgentOnce(promptWithArtifact, threadId)
        let html = initialResult.html
        let fullText = initialResult.fullText
        const firstFailureText = initialResult.fullText
        const sendValidationEvent = (
          status: DesignExecutionStatus,
          content: string,
          isError = status === "error"
        ) => {
          send({
            type: "execution",
            event: {
              kind: "validation",
              id: `artifact-validation:${Date.now()}`,
              name: "artifact-validation",
              content,
              status,
              isError,
              timestamp: Date.now(),
            } satisfies DesignExecutionEvent,
          })
        }
        let lastValidationFailureMessage = ""
        const sendValidatedArtifact = async (
          artifactHtml: string,
          showFailureResult: boolean
        ): Promise<{ ok: true } | { ok: false; repairable: boolean; message: string }> => {
          const validationDraftPath = makeDesignArtifactDraftPath(outputArtifactPath)
          const draftSave = saveDesignArtifactFile(
            validationDraftPath,
            injectDesignBrowserValidationProbe(artifactHtml),
            workspacePath
          )
          if (!draftSave.success || !draftSave.filePath) {
            sendValidationEvent(
              "error",
              `浏览器运行校验前写入临时文件失败：${draftSave.error ?? "未知错误"}`,
              true
            )
            lastValidationFailureMessage = `浏览器运行校验前写入临时文件失败：${draftSave.error ?? "未知错误"}`
            return { ok: false, repairable: false, message: lastValidationFailureMessage }
          }

          sendValidationEvent("running", "浏览器校验中...")
          const browserValidation = await validateDesignArtifactInHiddenBrowser(draftSave.filePath, controller.signal)
          const browserValidationMessage = formatDesignBrowserValidation(browserValidation)
          lastValidationFailureMessage = browserValidationMessage
          if (!browserValidation.ok) {
            if (showFailureResult) sendValidationEvent("error", browserValidationMessage, true)
            else sendValidationEvent("running", "浏览器校验未通过，正在自动修复...")
            return { ok: false, repairable: true, message: browserValidationMessage }
          }

          sendValidationEvent("success", browserValidationMessage, false)
          storeDesignHtml(htmlStoreKey, artifactHtml)
          const saved = tabId ? saveDesignArtifact(resolvedArtifactId, artifactHtml, workspacePath) : null
          send({ type: "done", html: artifactHtml, ...(saved?.filePath ? { artifactPath: saved.filePath } : {}) })
          return { ok: true }
        }

        if (!html || !isCompleteHtmlDocument(html)) {
          const draftArtifact = readDesignArtifactFile(candidateDraftPath, workspacePath)
          if (draftArtifact.success && draftArtifact.html && isCompleteHtmlDocument(draftArtifact.html)) {
            html = draftArtifact.html
          }
        }

        let continuationAttempt = 0
        let stalledContinuationAttempts = 0
        while (
          (!html || !isCompleteHtmlDocument(html)) &&
          continuationAttempt < DESIGN_ARTIFACT_CONTINUATION_MAX_ATTEMPTS &&
          stalledContinuationAttempts < DESIGN_ARTIFACT_CONTINUATION_STALL_ATTEMPTS
        ) {
          continuationAttempt++
          wroteCandidateDraft = false
          const continuationArtifactPath = candidateDraftPath
          const beforeToolCallCount = emittedToolCallIds.size
          const beforeToolResultCount = emittedToolResultIds.size
          const beforeAssistantTextCount = emittedAssistantTextIds.size
          const beforeFullText = fullText.trim()
          const continuationInstruction = buildDesignArtifactInstruction(
            continuationArtifactPath,
            fs.existsSync(continuationArtifactPath),
            sourceFilePathForPrompt
          )
          const continuationPrompt =
            `继续上一轮 Design 生成流程。上一轮还停留在读取、分析或计划阶段，尚未写出完整 HTML artifact；不要把这当成失败，也不要从头重做已完成的读取和分析。\n\n` +
            `你现在必须基于当前线程里已经读取/提取到的 PRD、技能和上下文继续执行。若还缺少必要信息，可以继续调用 read_file 等工具；但如果没有明确的绝对路径，跳过该读取，绝不能调用 file_path 为空或 undefined 的 read_file。\n\n` +
            `本轮结束前必须把完整、可独立运行的 HTML artifact 写入指定文件。不要只说明下一步计划。\n\n` +
            continuationInstruction
          sendValidationEvent("running", "继续生成 artifact...", false)
          const continuationResult = await runDesignAgentOnce(continuationPrompt, threadId)
          html = continuationResult.html
          if (continuationResult.fullText && !isLikelyDesignProgressOnlyText(continuationResult.fullText)) {
            fullText = continuationResult.fullText
          }
          if (!html || !isCompleteHtmlDocument(html) || wroteCandidateDraft) {
            const continuationDraftArtifact = readDesignArtifactFile(continuationArtifactPath, workspacePath)
            if (continuationDraftArtifact.success && continuationDraftArtifact.html && isCompleteHtmlDocument(continuationDraftArtifact.html)) {
              html = continuationDraftArtifact.html
            }
          }
          const hasCompleteArtifact = Boolean(html && isCompleteHtmlDocument(html))
          const madeProgress =
            hasCompleteArtifact ||
            wroteCandidateDraft ||
            emittedToolCallIds.size > beforeToolCallCount ||
            emittedToolResultIds.size > beforeToolResultCount ||
            emittedAssistantTextIds.size > beforeAssistantTextCount ||
            Boolean(continuationResult.fullText.trim() && continuationResult.fullText.trim() !== beforeFullText)
          stalledContinuationAttempts = madeProgress ? 0 : stalledContinuationAttempts + 1
        }

        for (let recoveryAttempt = 1; (!html || !isCompleteHtmlDocument(html)) && recoveryAttempt <= DESIGN_ARTIFACT_WRITE_RECOVERY_ATTEMPTS; recoveryAttempt++) {
          const recoveryArtifactPath = makeDesignArtifactDraftPath(outputArtifactPath)
          candidateDraftPath = recoveryArtifactPath
          wroteCandidateDraft = false
          const recoveryThreadId = makeDesignAgentArtifactRecoveryThreadId(threadId, recoveryAttempt)
          await closeCheckpointer(recoveryThreadId)
          deleteThreadCheckpoint(recoveryThreadId)
          const recoveryInstruction = buildDesignArtifactInstruction(
            recoveryArtifactPath,
            false,
            sourceFilePathForPrompt
          )
          const recoveryPrompt =
            `${promptWithSkill}\n\n---\n[Artifact write recovery]\n` +
            `上一轮结束时没有写出完整 HTML artifact。你可以继续按正常流程读取需要的技能/参考/上下文文件，` +
            `但本轮结束前必须写出完整、可独立运行的 HTML artifact。\n\n` +
            `严格要求：\n` +
            `1. 只能把最终 artifact 写到这个绝对路径：${recoveryArtifactPath}\n` +
            `2. 中间过程可以使用简短中文说明、read_file、write_file、edit_file；不要把中间过程当作最终结果。\n` +
            `3. 最终 artifact 文件内容必须从 <!DOCTYPE html> 开始，并以 </html> 结束。\n` +
            `4. 不要使用 TD_PATH、TBD_PATH、OUTPUT_PATH、FILE_PATH、<path> 或任何占位符路径。\n` +
            `5. read_file 的分页提示不是截断。若需要更多内容，按提示 offset 继续读取。\n` +
            `6. 如果没有明确的绝对 file_path，跳过该读取；绝不能调用 file_path 为空、undefined 或占位符的 read_file。\n` +
            `7. 不要只回复“我将继续/让我读取/现在生成”；本轮必须实际写入完整 artifact。\n\n` +
            recoveryInstruction
          const recoveryResult = await runDesignAgentOnce(recoveryPrompt, recoveryThreadId)
          html = recoveryResult.html
          if (recoveryResult.fullText && !isLikelyDesignProgressOnlyText(recoveryResult.fullText)) {
            fullText = recoveryResult.fullText
          }
          if (!html || !isCompleteHtmlDocument(html) || wroteCandidateDraft) {
            const recoveryDraftArtifact = readDesignArtifactFile(recoveryArtifactPath, workspacePath)
            if (recoveryDraftArtifact.success && recoveryDraftArtifact.html && isCompleteHtmlDocument(recoveryDraftArtifact.html)) {
              html = recoveryDraftArtifact.html
            }
          }
        }

        for (let repairAttempt = 0; repairAttempt <= DESIGN_BROWSER_AUTO_FIX_ATTEMPTS; repairAttempt++) {
          if (html && isCompleteHtmlDocument(html)) {
            const isFinalValidationAttempt = repairAttempt >= DESIGN_BROWSER_AUTO_FIX_ATTEMPTS
            const validationOutcome = await sendValidatedArtifact(html, isFinalValidationAttempt)
            if (validationOutcome.ok) return
            if (!validationOutcome.repairable || repairAttempt >= DESIGN_BROWSER_AUTO_FIX_ATTEMPTS) {
              send({
                type: "error",
                error: `生成的 HTML 未通过校验，已停止自动修复。\n${validationOutcome.message}`,
              })
              abortAgentSession()
              return
            }

            const repairThreadId = makeDesignAgentRepairThreadId(threadId, repairAttempt + 1)
            const repairArtifactPath = makeDesignArtifactDraftPath(outputArtifactPath)
            candidateDraftPath = repairArtifactPath
            await closeCheckpointer(repairThreadId)
            deleteThreadCheckpoint(repairThreadId)
            const failedSnapshot = writeDesignArtifactSourceSnapshot(outputArtifactPath, html)
            const repairSourcePath = failedSnapshot.success && failedSnapshot.filePath
              ? failedSnapshot.filePath
              : sourceFilePathForPrompt
            const repairArtifactInstruction = buildDesignArtifactInstruction(
              repairArtifactPath,
              false,
              repairSourcePath
            )
            const repairPrompt =
              `${promptWithSkill}\n\n---\n[Design validation failed]\n` +
              `生成的 HTML 没有通过宿主应用校验。请先读取失败的 HTML，再修复问题，并写出完整、可独立运行的 HTML artifact。\n\n` +
              `校验错误：\n${lastValidationFailureMessage || "隐藏浏览器运行校验失败。"}\n\n` +
              (repairSourcePath
                ? `修复前必须先用 read_file 读取这个失败的 HTML 文件：\n${repairSourcePath}\n\n`
                : `当前失败 HTML 片段：\n\`\`\`html\n${html.slice(0, 12000)}\n\`\`\`\n\n`) +
              repairArtifactInstruction
            const repairResult = await runDesignAgentOnce(repairPrompt, repairThreadId)
            html = repairResult.html
            if (repairResult.fullText && !isLikelyDesignProgressOnlyText(repairResult.fullText)) {
              fullText = repairResult.fullText
            }
            if (!html || !isCompleteHtmlDocument(html)) {
              const repairDraftArtifact = readDesignArtifactFile(repairArtifactPath, workspacePath)
              if (repairDraftArtifact.success && repairDraftArtifact.html && isCompleteHtmlDocument(repairDraftArtifact.html)) {
                html = repairDraftArtifact.html
              }
            }
            continue
          }

          const artifact = tabId ? readDesignArtifact(resolvedArtifactId, workspacePath) : null
          if (artifact?.success && artifact.html && isCompleteHtmlDocument(artifact.html)) {
            storeDesignHtml(htmlStoreKey, artifact.html)
            send({
              type: "error",
              error: "本次生成没有写出完整的新 HTML，已保留上一版设计。请重试或缩小页面规模。",
            })
            return
          }
          const errorText = !fullText.trim() || isLikelyDesignProgressOnlyText(fullText)
            ? firstFailureText
            : fullText
          send({
            type: "error",
            error: html && (html.includes("<!DOCTYPE") || /<html[\s>]/i.test(html))
              ? "模型本轮没有写出完整 HTML artifact。分块写入可能未完成，请重试或缩小页面规模。"
              : errorText.trim()
                ? "模型本轮没有写出完整 HTML artifact。已停止本次生成，请重试或缩小页面规模。"
                : "生成未返回任何内容，请重试。",
          })
          abortAgentSession()
          return
        }
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          console.error("[Design:Agent] Generation error:", msg)
          abortAgentSession()
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

function isCompleteHtmlDocument(html: string): boolean {
  return (
    (html.includes("<!DOCTYPE") || /<html[\s>]/i.test(html)) &&
    /<\/html>\s*$/i.test(html.trim())
  )
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
