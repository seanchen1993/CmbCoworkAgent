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
import { ipcMain, BrowserWindow, app } from "electron"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages"
import { getCustomModelConfigs } from "../storage"

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

1. **Always output a complete HTML file** — start with \`<!DOCTYPE html>\`, end with \`</html>\`. No fragments, no partial snippets.
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

## Iteration mode

If the user's prompt contains "CURRENT DESIGN HTML (iterate on this", you are in **iteration mode**:

- Read the existing HTML **carefully** before touching anything.
- Apply the user's follow-up instruction precisely. Change only what is asked; preserve everything else (colors, fonts, spacing, overall structure, content).
- **Do NOT regenerate from scratch.** The existing design is the baseline — iterate on it.
- If the instruction is a targeted tweak (e.g. "change button color", "add a footer"), output **one refined version** — no A/B/C labels needed.
- If the instruction is broad or exploratory (e.g. "make it bolder", "try a dark theme"), output **2 variations** as usual, each iterating from the existing base in a different direction.
- Either way, output a complete, self-contained HTML file.

## Output format

Respond with ONLY the raw HTML. No explanation, no markdown fences, no preamble.
Your response must start with: <!DOCTYPE html>
Your response must end with: </html>
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

function getModel(modelId?: string): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  const config = modelId
    ? (configs.find((c) => c.id === modelId) ?? configs[0])
    : configs[0]
  if (!config || !config.apiKey) return null
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
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

const htmlStore = new Map<string, string>()  // tabId → latest HTML

// Max turns kept in history to avoid blowing up context.
// Each "turn" = one user message + one assistant message = 2 entries.
const MAX_HISTORY_ENTRIES = 16  // 8 turns

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDesignHandlers(): void {
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

      const model = getModel(modelId)
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

      const model = getModel(modelId)
      if (!model) {
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }

      let fullText = ""

      // ── Build the message array ───────────────────────────
      // If we have prior history + a stored HTML for this tab,
      // build a multi-turn conversation so the model sees previous
      // instructions and the full current design without truncation.
      const storedHtml = tabId ? htmlStore.get(tabId) : undefined
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

      const model = getModel(modelId)
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
      htmlStore.set(tabId, html)
      console.log(`[Design] Stored HTML for tabId=${tabId} (${html.length} chars)`)
    }
    return { ok: true }
  })

  // design:cancel — abort an active session
  ipcMain.handle("design:cancel", (_event, sessionId: string) => {
    const controller = activeSessions.get(sessionId)
    if (controller) {
      controller.abort()
      activeSessions.delete(sessionId)
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
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()

  // 2. 去掉 ```html ... ``` 代码块标记
  const fenced = cleaned.match(/```html\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  // 3. 如果直接以 HTML 声明开头，直接返回
  if (cleaned.startsWith("<!DOCTYPE") || cleaned.startsWith("<html")) return cleaned

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
