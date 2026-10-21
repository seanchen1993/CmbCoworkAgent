# 知识库云端配置与双目录客户端实施计划

**目标：** 在现有 APP 实现上接入服务端组织过滤，将知识库读取与沉淀拆为两个独立工作区，统一更新与状态展示。

**架构：** 复用现有 knowledge-base-state、knowledge-base-manager、Git 同步服务和预览 Worker。项目继续绑定 idKey；服务端返回最新配置，每个知识库使用 workspaces 数组分别记录 read/write 结果。普通会话读取 read，knowledge_config 会话使用 write。

**技术栈：** Electron、TypeScript、React、Vitest、Git CLI。

**执行依据：** [总体设计](../knowledge-cloud-config-api-design.md)、[服务端接口](../knowledge-cloud-config-server-api.md)。客户端代码已按当前方案完成对齐，110 个相关测试、主进程与渲染层类型检查通过；本次修改文件的 lint 无新增问题，原有告警保留。尚未完成企业内网服务端联调。服务端开发另见 [内网服务端计划](2026-10-21-knowledge-cloud-server.md)。

## 实施约束

- 仅修改知识库相关代码，不改插件内容，不调整无关时间字段、格式或 import 顺序。
- HarnessBoardView.tsx 只做必要接线，新增检查及目录解析优先放独立文件或现有服务。
- 不引入锁、队列、额外重试调度或临时验证页面；不使用浏览器自动化、截图或图像分析验证界面。
- 状态文件 schemaVersion 固定为 1，直接实现目标结构，不考虑旧格式兼容，不实现状态迁移、旧字段适配或版本升级逻辑；不自动搬迁或删除原有本地目录。
- 运行定向测试和受影响的类型检查；lint 只针对本次修改的源文件，不执行 lint --fix 或全项目格式化。

## 任务 1：状态类型与配置合并

涉及文件：

- `src/shared/knowledge-base-types.ts`
- `src/main/services/knowledge-base-state.ts`
- `src/main/services/knowledge-base-state.test.ts`

步骤：

1. schemaVersion 保持 1，增加目标 workspaces 数组结构，每库恰好一个 read、一个 write；用 role 查找，不依赖顺序，不增加旧格式兼容分支。
2. 知识库保存接口返回的 ownerId、ownerName，缺失时使用空字符串；每个知识库增加必填 type 字段，目前仅支持 public，服务端下发记录由客户端统一写入该值，失效记录保留类型，不修改服务端接口或数据库。visibility 统一为 visible/unavailable；目录状态为 not_downloaded/success/failed/blocked，每目录只保留 status 和 lastError，知识库级别增加可选 lastSuccessfulSyncAt（GMT+8 YYYY-MM-DD HH:mm:ss），移除 syncedSourceKey。
3. 云端类型移除 enableOrg，名称原值保留，不做 trim 或大小写转换；校验 ID、字段类型、Git 参数与快照完整性。
4. 合并配置只按 idKey，当前快照未返回的历史记录改为 unavailable。成功空快照与失败必须区别处理。
5. 仓库或分支变化时取消对应目录旧成功状态，写入最新配置；随后由同一轮同步更新结果。不创建旧来源字段或来源哈希。
6. 单目录结果更新只覆盖该 workspace，保留同库另一个结果和当前配置。沿用状态文件原子写入。

定向测试：服务端下发记录写入 type=public 且失效后保留、空快照、历史恢复、请求失败不改配置、两个 role 的顺序互换和唯一性、配置变化不会保留旧 success、单目录结果不覆盖另一个、名称不被隐式处理。

## 任务 2：双目录 Git 同步

涉及文件：

- `src/main/services/knowledge-repository.ts`
- `src/main/services/knowledge-repository.test.ts`
- `src/main/services/knowledge-repository-fallback.test.ts`

步骤：

1. 为现有同步入口增加明确的 read/write 角色，目标路径由框架计算为 knowledge/<idKey>/<role>，不接受任意调用方目录。
2. 保留远端检查、HTTPS 超时和 SSH 兜底、临时 clone 后替换以及替换失败恢复。
3. 按最新 repoUrl/gitRef 检查实际 Git 来源和分支；不因 idKey 相同就忽略来源变化。同提交也不能掩盖检出分支或仓库错误。
4. 本地未提交、未推送或冲突时保留目录并返回 blocked；失败结果属于该角色，不干扰另一个角色。
5. 提供未提交变更检查供沉淀前复用；提交会话前检查不复用会阻断未推送提交的完整同步策略。

定向测试：双目录隔离、write 脏而 read 可更新、同 ID 分支/地址改变、同 commit 不同分支、失败不覆盖旧目录、HTTPS/SSH 两种结果、本地改动保留。

## 任务 3：统一刷新与重试

涉及文件：

- `src/main/services/knowledge-base-manager.ts`
- `src/main/services/knowledge-base-manager.test.ts`
- `src/main/ipc/models.ts`
- `src/main/index.ts`（仅在生命周期接线需要调整时）

步骤：

1. 使用 getUserInfo() 构建 POST 请求，仅发送 sapId、pathName、originPathId，缺失值用空字符串；移除 APP 组织匹配。
2. 保留 5 秒查询超时。成功完整快照才更新配置；查询失败保留原配置并在有缓存时继续按原配置执行该轮 Git 更新。
3. 每轮依次处理所有 visible 库的两个目录，不按失败项另起任务。read 或 write 出错都继续后续目录和知识库。
4. 保留启动、身份就绪/变化、90 分钟定时、检查全部更新入口，统一调用相同流程，上一轮未完成则跳过重复刷新。
5. 单库“拉取更新”使用最近成功配置，一次尝试该库两个目录，不额外请求服务端；结果分别记录并合并为一条反馈文案，不新增分目录更新或重试入口。unavailable 不允许同步。
6. 内存记录当前同步的 ID 和 role，运行中的 write 沉淀只暂停 write；不暂停 read，不增加持久化占用字段。
7. Git 失败优先按明确错误码、再按固定错误信息转换为标准提示。多次尝试只采用第一个底层异常，不拼接 HTTPS/SSH 原因；脱敏原始信息只写日志。read/write 提示相同时合并卡片和手动反馈中的错误说明。每轮两个目录均成功后记录知识库级别 lastSuccessfulSyncAt，部分成功或失败保留原值，无记录时显示“暂无成功更新”。
8. 后台错误不 toast，保留可展示的配置查询错误和目录结果；无缓存时标明配置获取失败。

定向测试：POST 请求字段与无本地过滤、5 秒超时、失败不误标不可见、有缓存查询失败仍可更新 Git、单库失败隔离、仅一个正常定时器、单库重试范围、write 会话不影响 read 更新。

## 任务 4：项目绑定与插件读取路径

涉及文件：

- `src/main/harness-board/service.ts`
- `src/main/harness-board/catalog-reader.ts`
- `src/shared/harness-board-types.ts`（仅在模型需要调整时）
- `src/main/services/knowledge-base-manager.ts`
- 对应模块的定向测试

步骤：

1. 项目仍保存 knowledgeBaseIds，一期最多一个；无绑定旧项目按 []，不自动补绑。
2. 新选择仅接受 visible、read.status=success、read 有效。未修改字段时保留已有 ID，未配置时保持 []，下拉框不提供清空入口。
3. 普通会话路径解析要求对应记录存在、read.status=success、read 目录有效；已有绑定不额外要求 visibility=visible。已绑定但不可用时，支持新版注入的插件传入 [] 并显示 toast，不阻断会话；未绑定时不提示。普通会话运行期间允许 read 自动更新。
4. 模板有 ${knowledgePath} 时传入 [{name,path}]，path 仅指向 read，整个 JSON 为一个命令参数；无占位符不追加参数。
5. 读取失败返回 []，不回退插件旧目录、不返回 write 内容。

定向测试：成功目录、失败状态但残留目录、不可见库的已有绑定、丢失目录、无绑定、模板无占位符、名称带空格或特殊字符时仍为一个 JSON 参数、无关项目编辑不清空绑定。

## 任务 5：knowledge_config 沉淀路径与提示

涉及文件：

- `src/main/harness-board/service.ts`
- `src/main/services/knowledge-base-manager.ts`，必要时拆出小型沉淀检查模块
- `src/main/ipc/harness-board.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/main/ipc/agent.ts`
- `src/main/agent/standard-thread-turn.ts`
- `src/renderer/src/components/harness-board/HarnessBoardView.tsx`（最小接线）
- 对应服务、IPC 和会话入口测试

步骤：

1. 项目详情的沉淀 knowledgePath 解析为 write 目录，不能使用普通会话的 read 解析结果代替。
2. 未配置时禁用沉淀并提示“请先在项目设置中配置知识库”；实际入口再次校验，不能传 null、项目目录或插件旧目录创建替代会话。
3. 每次新建沉淀会话前，通过主进程重新确认项目绑定和 write 目录，并检查实际 Git 未提交变更；避免仅使用弹窗打开时的旧详情快照。
4. 脏工作区先 toast，再用同一 write 目录创建会话；不弹确认、不阻断、不清理。blocked 或新来源尚未切换成功本身不阻断有效旧 write 工作区。
5. 同步 failed 时，如果仍有此前完成克隆的有效 write 工作区，也按实际工作区规则继续；首次下载失败无有效目录则阻断。Git 检查异常应返回具体错误，不默认为干净。
6. 不以 read 是否成功作为沉淀前置条件。沉淀使用 write，普通读取使用 read，分别判断。
7. 复用 Thread 运行状态和现有忙碌校验，只保护 write 更新与实际执行，不增加锁或等待队列。不增加沉淀会话之间的互斥、恢复旧会话的工作区检查或分支不一致提示；不自动重定向历史线程目录，不扩展 Git 提交、push、凭据或旧插件内部行为验证。

定向测试：未绑定、write 未下载、read/write 路径不同、脏工作区 toast 后仍创建、未推送但干净不误报未提交、冲突提示后继续、有效 write 的 blocked/failed 状态、write 同步中拒绝、运行会话只暂停 write 更新。

## 任务 6：Tab、选择控件与预览

涉及文件：

- `src/renderer/src/components/harness-board/KnowledgeBaseSyncPanel.tsx`
- `src/renderer/src/components/harness-board/KnowledgeBaseSelector.tsx`
- `src/renderer/src/components/harness-board/useKnowledgeBases.ts`
- `src/renderer/src/components/harness-board/KnowledgePreviewPanel.tsx`（仅在接线必要时）
- `src/main/harness-board/knowledge-preview-client.ts` 及相关读取模块（仅调整路径来源）
- `src/main/ipc/harness-board.ts`、preload 类型（按实际契约同步）

步骤：

1. Tab 显示全部本地知识库，名称右侧用小 tag 单行展示分支、汇总状态和最近成功更新时间，正常时合并为一个“已下载”；具体错误保留在下方，相同原因只显示一次。移除知识库数量，标题右侧复用通用提示图标及 Tooltip，说明自动更新和组织管理可见范围。维护人有值时增加“维护人：姓名/编号”tag；不可用 tag 为“已不在可用”，使用通用 Tooltip 提示“该知识库对您所在组织不再可用”。
2. 每张知识库卡片只提供一个“拉取更新”按钮，一次尝试 read/write 更新。用一条文案反馈结果，包括“读取内容更新成功，沉淀工作区更新失败：<原因>”等部分成功场景；不增加分目录更新或重试按钮。unavailable 禁止触发。
3. 默认预览 read，只提供打开 read 目录的入口；移除预览刷新按钮，每次展开重新读取，单库、全部和定时同步后自动刷新展开的预览。主进程以运行中的 previewRevision 通知读取目录处理完成，不持久化；预览加载和选择状态拆入 useKnowledgePreviews.ts，避免继续扩大 HarnessBoardView.tsx。write 本地变更由用户在沉淀会话现有 Git 面板处理。不得将 write 未提交内容混入默认预览。
4. 选择控件只展示当前可选库，不提供“不使用知识库”或清空选项；不可用历史绑定不加入选项，不在弹窗展示状态明细。样式与同一区域插件下拉一致，打开时不自动高亮首项，鼠标与键盘导航保持同一焦点；无可用项时显示空状态文案。
5. 编辑表单记录是否主动修改知识库选择，原绑定不在选项中也不能在保存其他字段时被自动清空。
6. 沿用页面打开期间本地 3 秒轮询与卸载清理，不触发网络或 Git。区分配置未就绪、获取失败和成功无可用库；后台不反复弹窗。

验证使用定向逻辑/组件测试及静态检查，不新建临时页面，不使用浏览器自动化或截图验证。

## 任务 7：收尾与联调

1. 内网接口使用 [服务端契约](../knowledge-cloud-config-server-api.md)，验证成功、空快照和错误三类结果。
2. 运行本次实际修改涉及的测试，例如：

```bash
npx vitest run src/main/services/knowledge-base-state.test.ts src/main/services/knowledge-base-manager.test.ts src/main/services/knowledge-repository.test.ts src/main/services/knowledge-repository-fallback.test.ts
npm run typecheck:node
npm run typecheck:web
```

3. 增补实际改动涉及的会话、IPC、预览测试文件，不运行无关全量测试。ESLint 明确列出本次修改的源文件，不使用 npm run lint 或 --fix。
4. 检查限定范围 diff、JSON 示例、文档路径，确认没有无关格式修改和对插件旧目录的回退。
5. 报告修改内容、测试结果及仍需负责人确认的数据库数据调整事项；状态文件兼容与迁移不在实施范围内。
