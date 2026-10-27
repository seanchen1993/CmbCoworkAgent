# Design 多框架架构 & Tweaks 协议设计

> 状态：草案 v1
> 范围：将 Design 模块从"HTML 单一产物"扩展为"HTML + React 单文件 + （未来）Vue / 项目骨架"的多 framework 前端 artifact 生成器，同时把现有的微调（Tweaks）能力从 HTML 实现细节提升为框架无关的运行时协议。

## 1. 背景与动机

Design 模块当前的能力边界：

- 只产出单文件 HTML artifact（带 `#variation-a` / `#variation-b` 双方案结构）。
- Tweaks（微调）能力强耦合在 HTML 上：通过注入 `<script>`，使用 `EDITMODE-BEGIN/END` 注释标记、`__activate_edit_mode` / `__set_tweak_keys` 等 postMessage 实现实时调整。
- 预览层直接 `BrowserWindow.loadFile()` + iframe `srcdoc`，无运行时编译。
- 批注（Comment）和绘制标记（Draw）作为预览层能力存在，agent 收到坐标 + 元素描述后整文件重写 HTML。

要扩展到 React/Vue 代码生成，**直接做不行的原因**：

1. React/Vue 不能用"改 DOM 后回写 HTML"作为持久化路径，源码会丢。
2. 现有 EDITMODE 协议假设 artifact 是 HTML 字符串，没有 framework 概念。
3. 预览层只支持加载静态 HTML，JSX/SFC 需要运行时编译。
4. 校验层（variation-a/b 结构、控制 token 等）只覆盖 HTML 形态。

**核心架构判断**：把 Tweaks 抽成与 framework 无关的运行时协议，每个 framework 提供自己的协议实现。这样后续加 framework 不需要重做用户交互，只需要写一份 runtime + 一段 framework overlay prompt。

## 2. 总体架构

四层分离：

```
┌────────────────────────────────────────────────────────────┐
│ Artifact 层                                                 │
│   framework: html | react | (vue)                          │
│   artifactKind: single-file | project                      │
│   previewType: 内部派生，不暴露给用户                       │
├────────────────────────────────────────────────────────────┤
│ Preview 层                                                  │
│   html              → iframe srcdoc                        │
│   react single-file → JSX sandbox iframe (Babel + 注入)    │
│   react project     → Phase 2a: export-only / 2b: vite     │
│   vue single-file   → @vue/compiler-sfc sandbox (Phase 3)  │
├────────────────────────────────────────────────────────────┤
│ Tweaks Protocol 层（framework-agnostic）                   │
│   postMessage 契约                                          │
│   TWEAK_DEFAULTS / TWEAK_SCHEMA 格式                       │
│   协议版本字段                                              │
├────────────────────────────────────────────────────────────┤
│ Source Adapter 层（per-framework）                         │
│   HTML adapter:  直接 patch HTML / inline style            │
│   React adapter: 通过 tweak state 驱动 rerender            │
│   持久化策略：artifact.json + 源码文件                     │
└────────────────────────────────────────────────────────────┘
```

数据流（用户操作 → 持久化）：

```
用户在预览中拖动 radius 滑块
  │
  ▼
Tweaks 面板发出 postMessage
  ├──→ v1: __set_tweak_keys
  └──→ v2: __design_set_tweak_keys
  │
  ├──→ HTML Runtime: 直接修改 DOM 样式，将变更写回 artifact.json.tweaks.current
  │
  └──→ React Runtime: useDesignTweaks 内部 state 变更，组件 rerender；
                      Source Adapter 把变更写回 artifact.json.tweaks.current
                      （源码不动，只动 tweaks 当前值）

下一次 agent 生成时
  │
  ▼
artifact.json.tweaks.current 拼进 prompt
agent 决定保留当前 tweaks / 更新 defaults / 协调冲突
```

## 3. artifact.json Schema

所有 framework 共用同一份 artifact.json 格式，差异通过 `framework` / `artifactKind` / `previewType` 三个字段表达。

### 3.1 完整 schema

```ts
interface DesignArtifact {
  // 协议版本（向后兼容用）
  protocol: 1 | 2

  // 框架与产物形态
  framework: "html" | "react" | "vue"
  artifactKind: "single-file" | "project"
  previewType: "html" | "jsx-sandbox" | "vue-sfc" | "vite-dev" | "export-only"

  // 入口文件（相对 artifact 目录）
  entry: string  // 例如 "index.html" / "index.jsx" / "App.vue" / "src/main.tsx"

  // 微调状态
  tweaks: {
    defaults: Record<string, TweakValue>   // 模型生成时的初始值
    current: Record<string, TweakValue>    // 用户当前实际微调值
    schema: Record<string, TweakSchemaEntry>  // 每个 key 的类型与展示规则
    history?: TweakSnapshot[]              // 最近 N 次手动微调快照（可选，做 undo）
  }

  // variation（仅 single-file 模式有效）
  variations?: {
    items: { id: "variation-a" | "variation-b"; label: string }[]
    tweakScope: "shared" | "per-variation"  // 第一版强制 shared
  }

  // 业务元数据（已有，不在本次重构范围）
  designSystem?: string
  scenario?: string
  createdAt: number
  updatedAt: number
}

type TweakValue = string | number | boolean

interface TweakSchemaEntry {
  type: "color" | "number" | "text" | "select" | "boolean"
  label: string
  description?: string
  // type 相关字段
  min?: number          // number
  max?: number          // number
  step?: number         // number
  maxLength?: number    // text
  options?: string[]    // select
}

interface TweakSnapshot {
  timestamp: number
  values: Record<string, TweakValue>
}
```

### 3.2 HTML 模式示例

```json
{
  "protocol": 2,
  "framework": "html",
  "artifactKind": "single-file",
  "previewType": "html",
  "entry": "index.html",
  "tweaks": {
    "defaults": { "primaryColor": "#111111", "radius": 16, "ctaText": "立即体验" },
    "current": { "primaryColor": "#0066ff", "radius": 16, "ctaText": "立即体验" },
    "schema": {
      "primaryColor": { "type": "color", "label": "主色" },
      "radius": { "type": "number", "label": "圆角", "min": 0, "max": 32, "step": 2 },
      "ctaText": { "type": "text", "label": "CTA 文案", "maxLength": 20 }
    }
  }
}
```

### 3.3 React 模式示例

```json
{
  "protocol": 2,
  "framework": "react",
  "artifactKind": "single-file",
  "previewType": "jsx-sandbox",
  "entry": "index.jsx",
  "tweaks": {
    "defaults": { "primaryColor": "#111111", "radius": 16, "ctaText": "立即体验" },
    "current": { "primaryColor": "#111111", "radius": 16, "ctaText": "立即体验" },
    "schema": {
      "primaryColor": { "type": "color", "label": "主色" },
      "radius": { "type": "number", "label": "圆角", "min": 0, "max": 32, "step": 2 },
      "ctaText": { "type": "text", "label": "CTA 文案", "maxLength": 20 }
    }
  }
}
```

## 4. Tweaks Protocol

### 4.1 postMessage 消息契约

所有消息以 `__design_*` 前缀避免冲突，并携带 `protocol` 字段。

**Sandbox → Host：**

| type | payload | 含义 |
|------|---------|------|
| `__design_runtime_ready` | `{ protocol, framework, tweakKeys: string[] }` | 运行时初始化完成 |
| `__design_tweaks_changed` | `{ key, value, source: "user" \| "code" }` | 用户在预览内直接改了某个 tweak |
| `__design_runtime_error` | `{ message, stack? }` | 运行时异常 |

**Host → Sandbox：**

| type | payload | 含义 |
|------|---------|------|
| `__design_activate_edit_mode` | `{}` | 激活编辑高亮、显示可调节点 |
| `__design_deactivate_edit_mode` | `{}` | 退出编辑模式 |
| `__design_set_tweak_keys` | `{ keys: Record<string, TweakValue> }` | 批量更新 tweaks，触发 rerender |
| `__design_update_source` | `{ patch: SourcePatch }` | 仅 HTML 模式：直接 patch DOM |

> **命名理由**：去掉了原协议的 `_html` 后缀，因为新协议是 framework-agnostic。旧 artifact 仍发 `__edit_html` / `__set_tweak_keys`（无前缀），由 `protocol === 1` 时的兼容 dispatch 路径处理。

### 4.2 协议版本化

协议分两代长期共存，不能在 Phase 0 破坏现有 HTML artifact。

| 版本 | 标识 | 文件内 tweak 块 | postMessage | 适用范围 |
|------|------|----------------|-------------|----------|
| v1 | artifact 无 `protocol` 或 `protocol: 1` | `/*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/`，块内必须是 JSON object | `__set_tweak_keys` / `__edit_html` / `__edit_mode_set_keys` | 存量 HTML |
| v2 | `protocol: 2` | `/*DESIGN_TWEAKS-BEGIN*/{ defaults, schema }/*DESIGN_TWEAKS-END*/` | `__design_*` | 新 HTML / React / 未来 Vue |

Host 端按版本分发：

```ts
function dispatchSandboxMessage(msg: SandboxMessage, artifactProtocol?: number): void {
  const protocol = msg.protocol ?? artifactProtocol ?? 1
  if (protocol === 1) return legacyHtmlDispatch(msg)
  if (protocol === 2) return unifiedDispatch(msg)
  console.warn("Unknown design runtime protocol", protocol)
}
```

存量 HTML artifact 不带 `protocol` 字段时按 v1 处理。Phase 0 只能以 additive 方式写入 artifact metadata，不自动改写 entry HTML 的 v1 marker。用户主动触发“升级 Tweaks 协议”或新生成的 v2 artifact 才写 `DESIGN_TWEAKS`。

### 4.3 TWEAK_DEFAULTS / TWEAK_SCHEMA 规范

v2 强制要求 defaults 和 schema 同时存在，但 v1 继续只要求 `EDITMODE-BEGIN` JSON object。

**HTML v1（存量兼容，保持现状）：**

```html
<script>
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"primaryColor":"#111111","radius":16,"ctaText":"立即体验"}/*EDITMODE-END*/;
</script>
```

**HTML v2（新协议）：**

```html
<script type="application/design-tweaks+json">
/*DESIGN_TWEAKS-BEGIN*/
{
  "defaults": {
    "primaryColor": "#111111",
    "radius": 16,
    "ctaText": "立即体验"
  },
  "schema": {
    "primaryColor": { "type": "color", "label": "主色" },
    "radius": { "type": "number", "label": "圆角", "min": 0, "max": 32, "step": 2 },
    "ctaText": { "type": "text", "label": "CTA 文案", "maxLength": 20 }
  }
}
/*DESIGN_TWEAKS-END*/
</script>
```

**React v2：**

```jsx
import { useDesignTweaks } from "@design/tweaks"

export const TWEAK_DEFAULTS = {
  primaryColor: "#111111",
  radius: 16,
  ctaText: "立即体验"
}

export const TWEAK_SCHEMA = {
  primaryColor: { type: "color", label: "主色" },
  radius: { type: "number", label: "圆角", min: 0, max: 32, step: 2 },
  ctaText: { type: "text", label: "CTA 文案", maxLength: 20 }
}

export default function App() {
  const tweaks = useDesignTweaks(TWEAK_DEFAULTS)
  return (
    <button style={{ borderRadius: tweaks.radius, background: tweaks.primaryColor }}>
      {tweaks.ctaText}
    </button>
  )
}
```

**校验规则：**

- v1 HTML：`EDITMODE-BEGIN/END` 内必须仍是 JSON object；缺 schema 时允许 fallback 推断控件类型。
- v2 HTML：`DESIGN_TWEAKS-BEGIN/END` 内必须是 JSON object，且包含 `defaults` 与 `schema`。
- React：`TWEAK_DEFAULTS` 和 `TWEAK_SCHEMA` 都必须存在且是对象字面量。
- v2：`defaults` 和 `schema` keys 必须完全一致。
- `TWEAK_SCHEMA` 每个 entry 必须有合法 `type`。
- React 模式：`useDesignTweaks(TWEAK_DEFAULTS)` 必须在组件函数体内被实际调用。
- React 模式：禁止 import 白名单之外的库（默认：react、react-dom、@design/tweaks）。

## 5. Framework Runtime 契约

每个 framework 提供一份 runtime 实现，负责：

1. 接收 `__design_set_tweak_keys`，更新内部状态，触发重渲染。
2. 上报 `__design_runtime_ready` 及 `__design_runtime_error`。
3. 在用户直接通过预览内 UI 控件改 tweak 时发 `__design_tweaks_changed`。

### 5.1 HTML Runtime

HTML runtime 分两条路径：

- **v1 legacy path**：保留现有 `EDITMODE-BEGIN/END`、`__set_tweak_keys`、`__edit_html`、`__edit_mode_set_keys` 行为。它继续服务存量 artifact 和 Phase 0 期间的新 HTML，直到 v2 稳定。
- **v2 unified path**：解析 `DESIGN_TWEAKS-BEGIN/END`，上报 `__design_runtime_ready`，接收 `__design_set_tweak_keys`，只把用户当前值写入 `artifact.json.tweaks.current`。

Phase 0 不强制所有 HTML artifact 立即升级 v2。只有满足以下条件之一才走 v2：

1. artifact.json 明确 `protocol: 2` 且 entry 文件包含 `DESIGN_TWEAKS` 块。
2. 用户主动触发“升级 Tweaks 协议”。
3. React / 未来 Vue artifact 天然走 v2。

实现位置建议：不要把 runtime 注入塞进 `injectDesignBrowserValidationProbe`。新增独立函数：

```ts
injectDesignRuntime(artifact: DesignArtifact, source: string): string
injectDesignValidationProbe(source: string): string
```

校验 probe 只负责错误捕获；runtime 只负责交互协议。

### 5.2 React Runtime

Sandbox 加载流程：

1. iframe HTML 模板（host 端常量）：
   ```html
   <!DOCTYPE html>
   <html>
     <head>
       <script src="cdn://react.production.min.js"></script>
       <script src="cdn://react-dom.production.min.js"></script>
       <script src="cdn://@babel/standalone"></script>
       <script>/* injected: useDesignTweaks runtime + postMessage bridge */</script>
     </head>
     <body><div id="root"></div></body>
   </html>
   ```
2. iframe 启动后，host 把生成的 `index.jsx` 内容发进去。
3. iframe 里 Babel 即时编译 JSX → JS，挂到 `#root`。
4. `useDesignTweaks` 是 sandbox 注入的全局 hook，但**源码里仍写 `import { useDesignTweaks } from "@design/tweaks"`**，Babel 编译前 sandbox 把这个 import 重写成 `const { useDesignTweaks } = window.__designSandbox`。

`useDesignTweaks` 实现（约 30 行）：

```js
// 在 sandbox 启动脚本里，挂到 window.__designSandbox
const tweakSubscribers = new Set()
let currentTweaks = {}

window.addEventListener("message", (event) => {
  if (event.data?.type === "__design_set_tweak_keys") {
    currentTweaks = { ...currentTweaks, ...event.data.keys }
    tweakSubscribers.forEach(fn => fn(currentTweaks))
  }
})

window.__designSandbox = {
  useDesignTweaks(defaults) {
    const [tweaks, setTweaks] = React.useState({ ...defaults, ...currentTweaks })
    React.useEffect(() => {
      const sub = (next) => setTweaks({ ...defaults, ...next })
      tweakSubscribers.add(sub)
      return () => tweakSubscribers.delete(sub)
    }, [])
    return tweaks
  }
}
```

**导出策略**：用户从 UI 导出代码时，host 把 `import` 替换回真实路径，并附带一份独立的 `tweaks-runtime.js` 文件。用户能在自己项目里 `npm install` 后直接跑。

### 5.3 Vue Runtime（预留 Phase 3）

类似 React，但需要：

- `@vue/compiler-sfc` 浏览器版（ESM）做 SFC 编译。
- `provideDesignTweaks` / `useDesignTweaks` 组合函数（Composition API）。
- 协议消息不变。

## 6. Source Adapter 层

负责"用户操作 → 写回 artifact"的逻辑分发。

### 6.1 HTML Adapter

HTML adapter 同样区分 v1 / v2：

- **v1**：保持当前行为。`__edit_mode_set_keys` 继续 merge 到 `EDITMODE-BEGIN` JSON 中，`__edit_html` 继续保存完整 HTML。这是兼容路径。
- **v2**：`__design_tweaks_changed` 只写 `artifact.json.tweaks.current`，不改写 entry 文件里的 `defaults`。defaults 表示模型生成时的初始值，current 表示用户手动状态。

导出策略：

- “导出源码”：保留 entry defaults + artifact.json current。
- “导出可直接打开 HTML”：可以选择 bake current 到导出文件，但这是 export transform，不是编辑源文件。
- `__design_update_source` / DOM-level patch 仅 HTML v1/v2 支持，React v1 不支持。

### 6.2 React Adapter

- `__design_tweaks_changed`：**只**写 `artifact.json.tweaks.current`，源码不改。
  - 理由：JSX 源码里的 `TWEAK_DEFAULTS` 是模型决定的初始值，用户的微调是运行时状态。用户下次重新打开 artifact 时，从 json 读 current 再发给 sandbox 即可恢复。
- 不支持 DOM-level patch（v1 不承诺 JSX 节点反写）。

### 6.3 跨次生成的 tweaks 合并策略

用户调整过 tweaks 后又触发 agent 重新生成：

```
artifact.json.tweaks.current  →  拼入 prompt 作为 hint
                                  ↓
            agent 生成新 artifact 时，可以：
            a) 保留 current 不变，仅改其他视觉
            b) 把 current 提升为新 defaults，旧 defaults 丢弃
            c) 因新需求与 current 冲突而显式覆盖 current
```

由 agent 自行判断。Prompt 模板里加一段：

```
The user has manually tweaked the previous artifact:
  - primaryColor: #FF0000 (was #111111)
  - radius: 24 (was 16)

If your new design is compatible with these tweaks, set TWEAK_DEFAULTS to the
current tweak values. If the new direction conflicts (e.g. user asks for cooler
palette and previous tweak was warm red), choose new defaults and explain in
your assistant message.
```

## 7. 校验层扩展

复用现有 `validateDesignArtifactInHiddenBrowser` 框架，按 framework 分发不同校验项。

### 7.1 公共校验

- 控制 token 检测（已有，建议本次扩展正则覆盖面，见 `docs/` 中之前的代码评审记录）。
- artifact.json 字段完整性。

### 7.2 HTML 特有

- `#variation-a` / `#variation-b` 结构（已有）。
- v1: `EDITMODE-BEGIN` JSON 块可解析；v2: `DESIGN_TWEAKS` 块存在且 `defaults` / `schema` keys 对齐。

### 7.3 React 特有（新增）

通过 `@babel/parser` 解析 entry 文件，断言：

- `TWEAK_DEFAULTS` 和 `TWEAK_SCHEMA` 都是 ExportNamedDeclaration + ObjectExpression。
- 两者 keys 集合完全相等。
- 存在一个 `useDesignTweaks(TWEAK_DEFAULTS)` 的 CallExpression。
- 默认导出存在且是函数组件。
- import 仅引用白名单库（默认：react, react-dom, @design/tweaks）。
- 文件无控制 token。

校验失败的错误消息按现有 repair 循环喂回模型。

## 8. UI 交互差异

| 能力 | HTML 模式 | React 单文件 | React 项目 |
|------|-----------|--------------|------------|
| Tweaks 面板 | 支持 | 支持 | 支持 |
| Comment 批注 | 支持 | 支持 | Phase 2 不支持精准定位 |
| Draw 绘制标记 | 支持 | 支持 | Phase 2 不支持 |
| Edit 面板（DOM-level） | 支持 | 不支持 | 不支持 |
| Variation A/B | 支持 | 支持（双 export） | 不支持 |
| 实时预览 | 支持 | 支持（JSX sandbox） | Phase 2a 仅导出 / 2b vite |
| 导出源码 | 单 .html | .jsx + tweaks-runtime.js | ZIP 项目 |

### 8.1 Comment / Draw 在 React 下的语义

用户在 rendered DOM 上画线/批注后，host 把元素描述、坐标、批注文本拼成 prompt：

```
用户在预览中批注：
- 元素描述：CTA 按钮（rect: x=120, y=480, w=240, h=56）
- DOM selector: button.cta-primary
- 批注意图："改成更紧凑的圆角，颜色再深一些"

请基于当前 JSX 源码做相应修改，保持 TWEAK_DEFAULTS / TWEAK_SCHEMA 不变，
仅在源码必要处调整。
```

v1 整文件重写。v2（Phase 2.5）引入 surgical edit（`edit_file` 工具），按 AST 定位节点局部改。

### 8.2 Variation A/B 在 React 下的形态

```jsx
export const TWEAK_DEFAULTS = { /* shared */ }
export const TWEAK_SCHEMA = { /* shared */ }

export function VariationA() {
  const tweaks = useDesignTweaks(TWEAK_DEFAULTS)
  return <div>{/* ... */}</div>
}

export function VariationB() {
  const tweaks = useDesignTweaks(TWEAK_DEFAULTS)
  return <div>{/* ... */}</div>
}

export default VariationA  // 用于 mount root；preview 层会同时挂载 A 和 B
```

Sandbox 预览时把 `VariationA` 和 `VariationB` 各 mount 到 iframe 的两个 div 上，左右并排。

v1 强制 `tweakScope: "shared"`，两个 variation 共用同一份 TWEAK_DEFAULTS。

## 9. 阶段计划

### Phase 0：协议抽象（1–2 天，零用户可见变化）

**目标**：引入多 framework / Tweaks v2 的类型与持久化骨架，但不改变用户当前 HTML 生成、预览、微调体验。

任务清单：

1. 写 `docs/design-tweaks-protocol.md`（本文档第 4 节的稳定摘录）。
2. 在 IPC / metadata 类型里增加 `framework`、`artifactKind`、`previewType` 字段，默认值 `html / single-file / html`。`previewType` 是内部派生字段，不在 UI 暴露。
3. skill frontmatter 在 `od:` 命名空间下增加兼容性声明；parser 支持 inline list 与 block list，并保留根级字段 fallback 以兼容早期模板：
   ```yaml
   od:
     mode: prototype
     platform: web
     scenario: dashboard
     frameworks: [html, react]
     artifactKinds: [single-file]
   ```
4. artifact.json 写入 additive schema：`protocol`、`framework`、`artifactKind`、`previewType`、`entry`。读取时兼容 v1。
5. 拆分 prompt 组装：`base + framework overlay + skill/context`。HTML overlay 仍输出当前 HTML 规则。
6. 保留 `EDITMODE-BEGIN` v1 兼容路径；新增 v2 `DESIGN_TWEAKS` parser，但 Phase 0 不强制 HTML 输出 schema。
7. Edit 面板继续支持现有 DOM-level HTML 编辑；schema-driven Tweaks 面板只做内部数据结构准备，不替换现有 UI。
8. UI 不暴露 framework 选择器，所有现有路径走默认 `framework: "html"`。

验收：现有 HTML 生成、预览、微调、回滚、导出全部回归正常。artifact.json 含新增字段，但 entry HTML 仍可保持 v1 格式。

### Phase 1：React 单文件 + Tweaks Runtime（1–2 周）

**目标**：用户能选择 React，生成 .jsx 单文件 artifact，并保留 Tweaks / Comment / Draw 的核心体验。

任务清单：

1. 新建 `design-frameworks/react/SKILL.md` 和 `design-frameworks/react/template.jsx`，定义 React 单文件输出规则、TWEAK_DEFAULTS/SCHEMA 强制、variation 双 export 约定。
2. 实现 React Runtime：`useDesignTweaks`、postMessage bridge、错误捕获、ready 上报。
3. 实现 JSX Sandbox iframe：HTML 模板 + React UMD + ReactDOM UMD + Babel standalone + runtime 注入。
4. 实现 Babel 编译前 import/export 重写：
   - `import { useDesignTweaks } from "@design/tweaks"` → sandbox 注入引用。
   - 捕获 `default export`、`VariationA`、`VariationB`，供 preview renderer mount。
5. 校验层加 React AST 检查（用 `@babel/parser`）。
6. Source Adapter 区分 HTML / React 分支：React 只写 `artifact.json.tweaks.current`，不做 DOM-level source patch。
7. UI 加 framework 选择器（HTML / React），并基于 skill supports 收缩可选项。
8. 导出器：React 模式导出 `.jsx` + `tweaks-runtime.js`；ZIP 导出保留 artifact.json。
9. Variation A/B 仅在 `artifactKind=single-file` 且探索流时启用；React 形态为 `VariationA` / `VariationB` named exports + shared tweaks。
10. Comment / Draw 复用现有坐标层；prompt 明确“基于当前 JSX 源码整文件重写”。
11. React v1 不支持 ElementPropsPanel 的 DOM-level 反写 JSX；进入 React preview 时隐藏或禁用该面板。

验收：

- 用户能选 React 框架，输入需求得到可预览 `.jsx`。
- Tweaks 滑块拖动实时生效（React rerender）。
- Comment / Draw 触发迭代后 agent 修改 JSX，预览刷新。
- 导出 `.jsx` 文件和 `tweaks-runtime.js`，用户能复制到 Vite/Cra 类项目跑通。

### Phase 2：React 项目骨架（按需启动）

**Phase 2a：export-only（1 周）**

- 新增 `artifactKind: "project"`。
- agent 生成多文件结构：`package.json` / `vite.config.ts` / `src/main.tsx` / `src/App.tsx` / `src/styles.css` / `tweaks-runtime.ts`。
- 预览层显示 "ZIP 导出"按钮，不做实时预览。
- 不支持 Comment / Draw（落点歧义）。

**Phase 2b：本地 vite dev 预览（1–2 周）**

- 主进程接到"运行"指令时把项目写到 `os.tmpdir()/design-preview-<hash>/`。
- `spawn("npm", ["install"])` → 完成后 `spawn("npx", ["vite", "--port=<random>"])`。
- iframe `loadURL("http://localhost:<port>")`。
- Tweaks postMessage 协议复用，由 entry 的 React 应用挂 runtime。
- 关闭 artifact 时 kill 进程、清临时目录。

**Phase 2c：surgical edit（1–2 周）**

- agent 工具集开启 `edit_file`，迭代时按 AST 定位节点修改而非整文件重写。
- prompt 引导："如果只动一个组件，用 edit_file；如果改设计骨架，用 write_file 重写。"

### Phase 3：Vue（按需）

只有真实用户需求时启动。技术路线：

- `@vue/compiler-sfc` ESM 在 sandbox 编译 .vue。
- `useDesignTweaks` 作为 Composable。
- 单文件 .vue + 项目骨架两种 artifactKind。

## 10. 决策记录与开放问题

### 10.1 已决策

1. **previewType 不给用户选**：由 `(framework, artifactKind)` 派生。
2. **v1 EDITMODE 长期兼容**：存量 HTML 不自动改写，至少保留一年。
3. **v2 使用 DESIGN_TWEAKS 块**：不把 `TWEAK_SCHEMA` 塞进 v1 `EDITMODE-BEGIN`，避免破坏现有 parser。
4. **React 第一版使用 UMD + Babel standalone**：优先跑通 happy path，不提前引入 esbuild/ESM。
5. **React 第一版不支持 ElementPropsPanel 反写 JSX**：只支持 Tweaks 参数、Comment/Draw prompt-based iteration、整文件重写。
6. **skill/framework 目录归 Design 模块**：使用 `design-frameworks/react/`，不放到全局 `skills/`，避免和主 Agent skill 生命周期混淆。

### 10.2 开放问题

1. **v1 artifact 何时升级 v2**：推荐“用户主动编辑 Tweaks 或重新生成时提示升级”，不做首次打开自动迁移。
2. **TWEAK_SCHEMA 缺失 fallback**：HTML v1 按值类型推断；React/v2 直接判失败并要求模型修复。
3. **Edit 面板控件类型**：第一版保持 5 种（color/number/text/select/boolean），未来再加 slider/range/date。
4. **tweaks.history 是否第一版实现**：建议 Phase 1.5 再做，Phase 0/1 只保留 schema 字段。
5. **React 安全检查白名单**：除 import 白名单外，是否禁止 fetch/eval/localStorage/window 顶层访问，需要在 Phase 1 开始前定。
6. **批注锚点稳定性**：是否由 sandbox 自动给 rendered DOM 注入 `data-design-id`，还是让模型在 JSX 中写。推荐 sandbox 注入，不污染源码。

## 11. 关键代码路径

供实施时参照（基于当前 `feature_design_lxy` 分支）：

| 位置 | 现有职责 | Phase 0/1 改造 |
|------|----------|----------------|
| `src/main/ipc/design.ts` | 生成、校验、tweak 应用主流程 | 加 framework dispatch；拆出 runtime 注入函数 |
| `src/main/ipc/design.ts: DESIGN_SYSTEM_PROMPT` | HTML 全套规则 | 拆成 base + framework overlay |
| `src/main/ipc/design.ts: injectDesignBrowserValidationProbe` | 校验探针 | 拆出 `injectDesignRuntime(framework, ...)` |
| `src/main/ipc/design.ts: validateDesignArtifactInHiddenBrowser` | 浏览器内校验 | 加 React AST 校验分支 |
| `src/renderer/src/components/design/DesignView.tsx` | 主 UI、消息流、Tweaks 面板 | 加 framework 选择器；Edit 面板读 schema |
| `src/renderer/src/components/design/DesignView.tsx: TabState` | 单 tab 状态 | 新增 `framework`、`tweakSchema` 字段 |
| `design-frameworks/react/SKILL.md` | 不存在 | React framework overlay 与 seed template |

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Babel-in-iframe 性能（大组件首次编译 1-3 秒） | React 模式预览体验差 | UMD 改 ESM + esbuild；或预编译在主进程 |
| 模型 React 输出不稳定（ESM import / CommonJS 混用） | 校验失败率高 | SKILL.md 强约束 + 静态校验做 fallback fix |
| Tweaks runtime 与用户 JSX 命名冲突 | 偶发崩溃 | runtime 全部命名空间挂 `__designSandbox` |
| 协议版本化破坏存量 artifact | 用户老项目打不开 | v1 dispatch 路径长期保留，至少一年 |
| TWEAK_SCHEMA 缺失导致 Tweaks 面板退化 | React/v2 体验断崖 | HTML v1 fallback 推断；React/v2 静态校验失败并自动修复 |
| 跨次生成 tweaks 合并冲突 | 用户感到不可预期 | prompt 显式告知 agent，让 agent 在 assistant 消息里说明决策 |

---

## 附录 A：术语表

- **Artifact**：一次生成产出的完整可预览/可导出实体，由 artifact.json + entry 文件（及多文件项目下的其他源文件）组成。
- **Tweak**：用户在预览中可实时调整的细粒度参数（颜色、圆角、文案等），不影响整体布局/逻辑。
- **TWEAK_DEFAULTS**：模型生成时写入 entry 文件的初始 tweak 值。
- **TWEAK_SCHEMA**：每个 tweak key 的类型与展示规则，用于驱动 Edit 面板控件渲染。
- **Sandbox**：预览 iframe 内的隔离运行环境，由 host 端注入 framework runtime。
- **Source Adapter**：把用户操作映射到 artifact.json + 源码持久化的 framework-specific 逻辑。
- **Variation**：同一设计需求下并排展示的多个候选方案（A / B），共享 prompt 上下文但风格不同。

## 附录 B：与 open-design 设计的对照

| 维度 | open-design | 本方案 |
|------|-------------|--------|
| Framework 抽象 | 折进 `preview.type`（html/jsx/pptx） | 独立字段 `framework`，与 `previewType` 解耦 |
| Skill 与 mode | mode 写在 SKILL.md frontmatter | skill 隐含 mode，UI 不暴露 mode 选择 |
| 多框架机制 | 每个 framework 一个独立 Skill 目录 | 同 |
| 微调机制 | 不存在 | 本方案核心：Tweaks Protocol |
| 预览渲染 | preview.type 路由到不同 iframe 渲染器 | 同，但加 vite shell-out 作为 project 模式可选实现 |
| 项目骨架 | 未实现 | Phase 2 实现 |
