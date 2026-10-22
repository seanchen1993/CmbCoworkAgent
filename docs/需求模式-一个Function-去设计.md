# 需求单个功能跳转 Design 实现方案



## 目标

点击功能卡的“去设计”或“继续设计”后：

1. 跳转到 Design 模式。
2. 设置 Design 工作区。
3. 将提示词回填到输入框，不自动发送。
4. 第一次生成 `index.html` 后，将文件路径和设计会话 ID 回写到目标 function。
5. 关闭 App 后，仍可点击“继续设计”恢复原会话。

## 跳转参数

Requirement 向 Design 传四个字段：

```ts
type RequirementDesignEntry = {
  workspacePath: string
  requirementFilePath: string
  prompt: string
  htmlId: string
}
```

- `workspacePath`：需求工作区完整路径。
- `requirementFilePath`：当前需求 MD 的完整路径。
- `prompt`：回填到 Design 输入框的内容。
- `htmlId`：Design 会话 ID；首次“去设计”传空字符串，“继续设计”传 manifest 中已有的值。

## 去设计

1. Requirement 保存四个跳转参数，并通知 App 切换到 Design。
2. Design 设置 `workspacePath`。
3. `htmlId` 为空时创建新设计会话，并将 `prompt` 写入输入框。
4. 保存新会话 ID，供第一次生成成功后回写 manifest。
5. 不自动提交 prompt。

跳转数据可通过一次性 `localStorage` 传递，Design 消费后删除。

## 第一次生成成功后回写

Design 收到以下完成事件时执行回写：

```ts
event.type === "done" && event.html && event.artifactPath
```

调用更新函数：

```ts
await updateRequirementFunctionHtml({
  workspacePath,
  requirementFilePath,
  htmlFile: event.artifactPath,
  htmlId: currentSessionId
})
```

目标 function 更新为：

```json
{
  "file": "prd/需求3.0文件/fr1-doc.md",
  "htmlFile": "/完整路径/.cmb-design/design_xxx/index.html",
  "htmlId": "ds_abcd1234",
  "needDesign": "1"
}
```

- `htmlFile` 保存生成的 `index.html` 完整路径。
- `htmlId` 保存 Design 会话 ID，即 `currentSessionId`，不能保存 artifact ID。

更新函数需要同时更新：

1. 工作区内的 `prd/prd-manifest.json`。
2. requirements `index.json` 中对应需求的 `prdManifest` 和 `updatedAt`。

必须先成功保存 HTML，再更新两个 JSON。

## Function 匹配

更新 manifest 前：

1. 校验 `requirementFilePath` 位于 `workspacePath` 内。
2. 将完整路径转换成工作区相对路径，例如 `prd/需求3.0文件/fr1-doc.md`。
3. 标准化 `/`、`\\` 和开头斜杠后，与 `function.file` 精确匹配。
4. 为兼容旧数据，可以按文件名回退匹配，但必须保证结果唯一。
5. 无匹配或存在多个匹配时停止更新并报错。

## 继续设计

点击“继续设计”时，Requirement 将目标 function 的 `htmlId` 放入四字段入口。Design 按以下规则处理：

- `htmlId` 对应的本地会话存在：直接调用 `openSession(htmlId)`。
- 会话不存在：根据 `workspacePath` 和 `requirementFilePath` 读取 manifest 中的 `htmlFile`；文件存在时导入 HTML 创建新会话，并回写新的 `htmlId`。
- 会话和 HTML 都不存在：创建空白会话并回填 prompt。

后续设计继续覆盖已有 `htmlFile`。只有文件路径或会话 ID 改变时才重新回写 manifest。





## DesignView 代码改动方案～～～～

### 1. 增加入口类型和当前入口引用

```ts
type RequirementDesignEntry = {
  workspacePath: string
  requirementFilePath: string
  prompt: string
  htmlId: string
}

const requirementEntryRef = useRef<RequirementDesignEntry | null>(null)
```

`requirementEntryRef` 只用于当前 Design 页面生成完成后的回写，不参与模型提示词。

### 2. 消费跳转数据

在 `createSession`、`openSession` 定义之后增加一个 `useEffect`：

```ts
useEffect(() => {
  const raw = localStorage.getItem("pending-requirement-design")
  if (!raw) return

  localStorage.removeItem("pending-requirement-design")
  const entry = JSON.parse(raw) as RequirementDesignEntry
  requirementEntryRef.current = entry
  setWorkspacePath(entry.workspacePath)

  if (entry.htmlId && designSessionExists(entry.htmlId)) {
    openSession(entry.htmlId)
    return
  }

  createSession(
    { title: getFileName(entry.requirementFilePath) },
    { initialInputValue: entry.prompt }
  )
}, [createSession, openSession])
```

同时给 `createSession` 的 options 增加：

```ts
initialInputValue?: string
```

创建 session 时直接写入：

```ts
session.tabStates[SINGLE_DESIGN_TAB_ID].inputValue = options?.initialInputValue ?? ""
```

这样只回填输入框，不调用发送方法。

### 3. 第一次生成成功后回写

在现有 `event.type === "done" && event.html` 分支中，拿到 `event.artifactPath` 后增加：

```ts
const requirementEntry = requirementEntryRef.current

if (requirementEntry && !requirementEntry.htmlId && event.artifactPath) {
  const htmlId = currentSessionIdRef.current
  if (htmlId) {
    await window.api.requirements.updateFunctionHtml({
      workspacePath: requirementEntry.workspacePath,
      requirementFilePath: requirementEntry.requirementFilePath,
      htmlFile: event.artifactPath,
      htmlId
    })

    requirementEntryRef.current = {
      ...requirementEntry,
      htmlId
    }
  }
}
```

只在入口的 `htmlId` 为空时执行首次绑定，避免后续每次迭代重复更新 manifest。

### 4. 会话恢复失败的处理

如果入口带有 `htmlId`，但本地 session 不存在：

1. 调用 requirements 接口，根据 `workspacePath + requirementFilePath` 读取 `htmlFile`。
2. `htmlFile` 存在时使用现有导入 HTML 能力创建新 session。
3. 将新 session ID 回写成新的 `htmlId`。
4. `htmlFile` 不存在时创建空白 session，并回填 prompt。

第一版如果暂不做 HTML 导入降级，也应至少创建空白 session，不能停留在无响应状态。

### 5. 预计改动量

- 入口类型和 ref：约 10 行。
- 消费入口的 effect：约 20～30 行。
- `createSession` 支持初始 prompt：约 5～10 行。
- 首次生成后回写：约 15～20 行。

`DesignView.tsx` 第一版预计增加或修改约 50～70 行，不需要改动现有发送和生成主流程。





# 整体代码量预估：

| 模块                            |     预计新增/修改行数 |
| ----------------------------- | ------------: |
| Requirement 跳转入口              |       20～30 行 |
| App 模式切换                      |       10～15 行 |
| DesignView                    |       50～70 行 |
| Main requirements 更新接口        |       50～80 行 |
| Preload API 与类型               |       15～25 行 |
| manifest function 增加 `htmlId` |       10～20 行 |
| 测试                            |       40～70 行 |
| **合计**                        | **195～310 行** |

如果第一版暂不实现“本地会话丢失后从 `htmlFile` 导入恢复”，预计可减少约 30～50 行，MVP 总量约 **165～260 行**。





## 改动范围

- Requirement：构造四个跳转字段，触发模式切换。
- App：切换到 Design 模式。
- DesignView：设置工作区、创建或恢复会话、回填 prompt、首次生成后调用更新函数。
- Main/Preload：提供更新接口，同步更新 manifest 和 requirements index。
- 类型定义：为 function 增加 `htmlId: string`。





## 验收标准

1. “去设计”能进入 Design、设置工作区并回填 prompt。
2. 第一次生成后，目标 function 正确写入 `htmlFile` 和 `htmlId`。
3. manifest 与 requirements index 保持一致。
4. 重启 App 后，“继续设计”能恢复指定会话。
5. 不会误更新同名文件对应的其他 function。
