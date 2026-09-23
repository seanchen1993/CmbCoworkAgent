# Code 组件的桌面适配

参考官方 v2.1.278 `CodeProps`，状态为 **adapted**。代码 source 限制为 10,000 字符，
插件路径仅用于语言推断，不显示、不读取文件。显式语言优先，其次路径扩展名或首行 shebang；
未知语言显示纯文本。高亮复用应用现有 Shiki worker，支持已打包的 TypeScript/TSX、
JavaScript/JSX、Python、JSON、CSS、HTML、Markdown、YAML、Bash、SQL；插件自带 grammar
尚不支持。卸载和 source 变化取消旧高亮请求，迟到结果不能覆盖新内容。

`startLine` 提供源代码行号。`wrap` 支持折行及 `truncate-end`。`format: "diff"` 接受
带可选文件头的统一 diff hunks，验证两侧行数、标记及安全整数，跳过末行换行提示；畸形
diff 明确拒绝，不回退成“正常 source”。diff 按 hunk 显示原/新行号及增删颜色，忽略
`startLine`；目前 diff 内容不作语法着色。

所有纯文本通过 React 转义，只有宿主 Shiki 生成的 HTML 进入高亮容器；不接受插件 HTML。
`code.test.ts`、`function-code.test.ts` 和真实 `code-pane.test.ts` 覆盖格式拒绝、行号、
零长度一侧、多个 hunk、语言推断、HTML 转义与真实 JSX→guest→session→pane。
桌面 E2E 安装 `code-pane` 夹具，验证 worker 高亮、增删 gutter 和不读取 path；最终运行
结果记录到 `output/mods-v2-validation/`，测试夹具不代表业务验收。
