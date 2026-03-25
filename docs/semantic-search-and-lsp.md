# 语义检索与 LSP 代码智能

## 1. 概述

CmbCoworkAgent 提供两种互补的代码理解能力：

| 能力 | 语义检索（Semantic Search） | LSP 代码智能 |
|------|---------------------------|-------------|
| **核心问题** | "哪些代码跟 X 概念相关？" | "这个符号定义在哪？谁引用了它？" |
| **技术基础** | Embedding 向量 + FTS 全文检索 | Language Server Protocol |
| **匹配方式** | 模糊语义匹配（自然语言） | 精确符号匹配（结构化） |
| **典型场景** | "找到所有跟用户认证相关的代码" | "跳转到 `createAgent` 的定义" |
| **实现状态** | ✅ 已实现 | 📋 规划中 |

两者结合后，Agent 既能用自然语言探索代码库全貌，也能精确定位符号的定义、引用和类型信息。

---

## 2. 语义检索（已实现）

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────┐
│                  CodeIndexManager                    │
│                  (per-workspace 单例)                 │
├──────────┬──────────┬──────────┬────────┬────────────┤
│ Scanner  │  Parser  │ Embedder │ Store  │  Watcher   │
│ 目录扫描  │ AST 分块  │ 向量化   │ 存储    │ 增量监听   │
└──────────┴──────────┴──────────┴────────┴────────────┘
     ↓           ↓          ↓         ↓          ↓
  .gitignore  Tree-sitter  OpenAI   sql.js    fs.watch
  文件过滤    语义分块     /Ollama  FTS3+BLOB  实时更新
```

### 2.2 数据流

```
源代码文件
    │
    ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Scanner  │────▶│  Parser  │────▶│ Embedder │
│ 扫描文件  │     │ AST 分块  │     │ 生成向量  │
│ SHA256   │     │ 50-1000  │     │ 512 维   │
│ 增量检测  │     │ chars    │     │ Float32  │
└──────────┘     └──────────┘     └──────────┘
                                       │
                                       ▼
                                 ┌──────────┐
                                 │  Store   │
                                 │ sql.js   │
                                 │ chunks   │ ← BLOB (向量)
                                 │ FTS3     │ ← 全文索引
                                 │ hashes   │ ← 增量缓存
                                 └──────────┘
                                       │
                                       ▼
                              ┌────────────────┐
                              │ Hybrid Search  │
                              │ 70% 向量相似度   │
                              │ 30% FTS/BM25   │
                              └────────────────┘
```

### 2.3 核心模块

#### 2.3.1 代码分块（Parser）

采用 **Tree-sitter AST** 语义分块，将源代码按语法结构切分为独立单元：

- **函数/方法** → 一个 chunk
- **类/接口** → 如果 < 1000 chars，整体一个 chunk；否则拆分为子方法
- **不支持的语言** → 回退到按行分块（带重叠）

```
输入: TypeScript 文件
        │
        ▼
  Tree-sitter 解析 AST
        │
        ▼
  提取 function_declaration
       class_declaration
       method_definition
       interface_declaration
       type_alias_declaration
       ...
        │
        ▼
  过滤: < 50 chars 的碎片丢弃
        > 1150 chars 的递归拆分
        │
        ▼
  输出: CodeBlock[]
        { filePath, identifier, type,
          startLine, endLine, content,
          segmentHash }
```

**支持的语言**：TypeScript, JavaScript, Python, Rust, Go, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Lua

**回退分块的语言**：Markdown, JSON, YAML, HTML, CSS, Shell, SQL, GraphQL, TOML

#### 2.3.2 向量化（Embedder）

支持两种 Embedding 提供者：

| 提供者 | 接口 | 默认模型 | 默认维度 |
|--------|------|---------|---------|
| OpenAI 兼容 | `POST /embeddings` | `text-embedding-3-small` | 512 |
| Ollama | `POST /api/embed` | `nomic-embed-text` | 768 |

**优化策略**：
- 批处理：32 texts/batch
- 指数退避重试（3 次，429 限流自动等待）
- 索引时在 content 前拼接文件路径 + 函数名，提升嵌入语义质量
- 支持 `dimensions` 参数降维（512 维 vs 1536 维，节省 ~70% 内存）

#### 2.3.3 存储（Store）

基于 **sql.js**（WASM SQLite），与项目现有数据库模式一致：

```sql
-- 代码块 + 向量
chunks (
  id, file_path, relative_path, identifier, type,
  start_line, end_line, content,
  file_hash, segment_hash UNIQUE,
  embedding BLOB,       -- Float32Array 原始字节
  created_at
)

-- 全文检索
chunks_fts USING fts3(content)   -- 关联 chunks by rowid

-- 增量检测
file_hashes (path PK, hash, chunk_version)

-- 元数据
meta (key PK, value)  -- embedding_model, dimensions, workspace_path
```

**存储路径**：`~/.cmbcoworkagent/code-index/{SHA256(workspacePath).slice(0,16)}.sqlite`

#### 2.3.4 混合搜索（Search）

双路召回 + 加权融合：

```
查询: "用户认证中间件"
         │
    ┌────┴────┐
    ▼         ▼
 FTS 路径    向量路径
    │         │
    ▼         ▼
 英文 →      Embed query
 FTS3 MATCH  → Float32Array[512]
 BM25 打分    │
    │         ▼
 中文 →      暴力 cosine 扫描
 LIKE 搜索   全部 chunks
 命中计数     取 > 0.1 的
    │         │
    ▼         ▼
  归一化      原始 cosine
  0~1         0~1
    │         │
    └────┬────┘
         ▼
  合并去重 (filePath:startLine)
  score = 0.7 × vectorScore + 0.3 × ftsScore
  排序 → 取 top-K
```

**性能**：10K chunks × 512 dims 暴力扫描约 10-50ms，桌面应用无感知延迟。

#### 2.3.5 索引生命周期

```
App 启动
    ↓
Agent 创建 (runtime.ts)
    ↓
CodeIndexManager.init()
    ├── 打开/创建 sqlite 数据库
    ├── 检查 embedding 模型/维度是否变更
    └── 变更则清空索引重建
    ↓
fullIndex() (后台异步)
    ├── Scanner 扫描 workspace
    │   ├── 跳过 .gitignore 匹配的文件
    │   ├── 跳过 node_modules/.git/dist 等
    │   ├── 跳过 > 1MB 的文件
    │   └── SHA256 比对，仅处理变更文件
    ├── Parser 解析每个文件 → CodeBlock[]
    ├── Embedder 批量生成向量
    ├── Store 写入 chunks + FTS + embeddings
    └── 清理已删除文件的残留 chunks
    ↓
startWatching()
    └── fs.watch (recursive, 1s 去抖)
        └── 文件变更 → incrementalUpdate()
            ├── 重新解析变更文件
            ├── 重新生成 embedding
            └── 更新 Store
```

### 2.4 Agent 工具

| 工具名 | 用途 | 参数 |
|--------|------|------|
| `codebase_search` | 语义 + 关键词搜索代码 | `query: string`, `max_results?: number` |
| `codebase_index_status` | 查看索引状态 | 无 |

**输出格式**：
```
[1] src/main/agent/runtime.ts#L579-L610 (function_declaration: createAgentRuntime)  score=0.847
​```typescript
export async function createAgentRuntime(options: CreateAgentRuntimeOptions): Promise<DeepAgent> {
  const { threadId, workspacePath, modelId, extraSystemPrompt } = options
  ...
}
​```
```

### 2.5 配置

存储于 `~/.cmbcoworkagent/code-index-settings.json`：

```json
{
  "enabled": false,
  "embeddingProvider": "openai-compatible",
  "embeddingBaseUrl": "",
  "embeddingApiKey": "",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDimensions": 512,
  "vectorWeight": 0.7,
  "ftsWeight": 0.3
}
```

- `embeddingBaseUrl` / `embeddingApiKey` 留空时，自动回退到用户已配置的模型接口
- `embeddingDimensions`: 推荐 512（平衡质量与内存占用）

---

## 3. LSP 代码智能（规划中）

### 3.1 目标

通过 Language Server Protocol，为 Agent 提供编译器级别的精确代码分析能力：

| 能力 | LSP 方法 | Agent 工具名（拟） | 示例 |
|------|---------|-------------------|------|
| 跳转定义 | `textDocument/definition` | `goto_definition` | "createAgent 定义在哪？" |
| 查找引用 | `textDocument/references` | `find_references` | "谁调用了 getMemoryStore？" |
| 悬停信息 | `textDocument/hover` | `symbol_info` | "getDb 的返回类型是什么？" |
| 符号搜索 | `workspace/symbol` | `workspace_symbol` | "找到所有叫 Handler 的类" |
| 诊断信息 | `textDocument/publishDiagnostics` | `get_diagnostics` | "这个文件有什么类型错误？" |
| 重命名 | `textDocument/rename` | `rename_symbol` | "把 getCwd 改名为 getCurrentDir" |
| 代码操作 | `textDocument/codeAction` | `code_actions` | "自动修复这个 import" |

### 3.2 架构方案

```
┌─────────────────────────────────────────────────┐
│                   Agent Runtime                  │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ codebase_    │  │ goto_definition          │ │
│  │ search       │  │ find_references          │ │
│  │ (语义检索)    │  │ symbol_info              │ │
│  │              │  │ workspace_symbol         │ │
│  │              │  │ get_diagnostics          │ │
│  └──────┬───────┘  └──────────┬───────────────┘ │
│         │                     │                  │
│    Code Index             LSP Client             │
│    Manager                Manager                │
└─────────┼─────────────────────┼──────────────────┘
          │                     │
          ▼                     ▼
    ┌──────────┐      ┌──────────────────┐
    │ sql.js   │      │ Language Servers  │
    │ + FTS3   │      │                  │
    │ + Vector │      │ TS: tsserver     │
    └──────────┘      │ Python: pyright  │
                      │ Go: gopls        │
                      │ Rust: rust-analyzer │
                      │ ...              │
                      └──────────────────┘
```

### 3.3 LSP Client Manager 设计

```typescript
class LspClientManager {
  // 按语言缓存 LSP 客户端
  private clients = new Map<string, LanguageClient>()

  /**
   * 根据文件扩展名自动启动对应的 Language Server。
   * 懒加载：首次请求某语言时才启动 server。
   */
  async getClient(filePath: string): Promise<LanguageClient | null>

  /**
   * 核心 LSP 操作
   */
  async gotoDefinition(filePath: string, line: number, character: number): Promise<Location[]>
  async findReferences(filePath: string, line: number, character: number): Promise<Location[]>
  async hover(filePath: string, line: number, character: number): Promise<HoverInfo>
  async workspaceSymbol(query: string): Promise<SymbolInfo[]>
  async getDiagnostics(filePath: string): Promise<Diagnostic[]>
  async rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit>

  /**
   * 生命周期
   */
  async closeAll(): Promise<void>
}
```

### 3.4 Language Server 选型

| 语言 | Server | 安装方式 | 备注 |
|------|--------|---------|------|
| TypeScript/JavaScript | `typescript-language-server` | npm 全局安装或内置 | 依赖 tsserver |
| Python | `pyright` 或 `pylsp` | pip/npm | pyright 更快 |
| Go | `gopls` | go install | 官方维护 |
| Rust | `rust-analyzer` | 独立二进制 | 最成熟的 LSP |
| Java | `jdtls` | Eclipse 维护 | 较重 |
| C/C++ | `clangd` | LLVM 内置 | 需要 compile_commands.json |

**策略**：
- 优先支持 TypeScript（项目最常用）
- 其他语言按需加载，未安装则降级到语义检索
- Server 进程随 workspace 生命周期管理，空闲超时自动关闭

### 3.5 与语义检索的协作

两者互补，不是替代关系：

```
用户: "帮我看看用户认证是怎么实现的"

Agent 思考:
  1. codebase_search("用户认证 authentication")
     → 找到 auth-middleware.ts, login-handler.ts, user-model.ts

  2. read_file("src/auth/auth-middleware.ts")
     → 看到 verifyToken() 调用

  3. goto_definition("src/auth/auth-middleware.ts", line=15, char=10)
     → 跳转到 verifyToken 的定义位置

  4. find_references("src/auth/token.ts", line=5, char=20)
     → 找到所有调用 verifyToken 的地方

  5. 综合分析后回答用户
```

**分工原则**：
- **语义检索**：发现阶段 — "找到跟 X 相关的代码在哪里"
- **LSP**：分析阶段 — "精确理解代码间的调用关系和类型"

### 3.6 实现路径

#### Phase 1：TypeScript LSP 集成
1. 内置 `typescript-language-server`
2. 实现 `goto_definition` + `find_references` + `hover` 三个核心工具
3. 自动检测 `tsconfig.json` 启动 server

#### Phase 2：多语言支持
4. 添加 Python (pyright) + Go (gopls) 支持
5. Language Server 自动发现和安装提示
6. 统一的 `LspClientManager` 管理多个 server

#### Phase 3：高级功能
7. `workspace_symbol` 搜索（比 grep 更精确）
8. `get_diagnostics` 获取编译错误
9. `rename_symbol` 安全重命名
10. `code_actions` 自动修复

### 3.7 挑战与考量

| 挑战 | 应对策略 |
|------|---------|
| Language Server 启动慢 | 懒加载 + 保持长连接 + 空闲超时回收 |
| 内存占用（tsserver 可能 > 500MB） | 限制同时活跃的 server 数量 |
| Server 安装依赖 | 自动检测，未安装时降级到语义检索 |
| 大型 monorepo | 按子项目粒度启动 server，不全量分析 |
| 位置映射 | Agent 用 `codebase_search` 找到文件+行号后，传递给 LSP |

---

## 4. 工具矩阵总览

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 代码理解工具集                    │
├─────────────────┬───────────────────┬───────────────────┤
│  文件级操作       │  语义检索           │  LSP 代码智能      │
├─────────────────┼───────────────────┼───────────────────┤
│  read_file      │  codebase_search  │  goto_definition  │
│  glob           │  codebase_index_  │  find_references  │
│  grep           │  status           │  symbol_info      │
│  edit_file      │                   │  workspace_symbol │
│  write_file     │                   │  get_diagnostics  │
│                 │                   │  rename_symbol    │
├─────────────────┼───────────────────┼───────────────────┤
│  精确文件操作     │  模糊语义发现       │  精确符号分析      │
│  ✅ 已实现       │  ✅ 已实现          │  📋 规划中        │
└─────────────────┴───────────────────┴───────────────────┘
```

---

## 5. 参考实现

| 项目 | 语义检索方案 | LSP 集成 |
|------|------------|---------|
| **Roo-Code** | Tree-sitter + Qdrant + 多 Embedder | 无 |
| **Moltbot** | sqlite-vec + FTS5 + 混合搜索 | 无 |
| **Kilocode** | Tree-sitter + Qdrant + WarpGrep | 无 |
| **Cursor** | 自研向量索引 | 内置 LSP（基于 VS Code） |
| **Continue.dev** | Chunk + Embedding + LanceDB | 复用 VS Code LSP |
| **CmbCoworkAgent** | Tree-sitter + sql.js + 混合搜索 | 规划中 |
