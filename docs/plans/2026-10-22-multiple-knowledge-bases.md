# 项目多知识库实现计划

目标：底层支持多个知识库绑定，普通会话接收包含 id、name、path 的知识库数组；知识沉淀明确选择单个目标目录。创建、编辑项目的界面暂时仅允许单选，并保留清空选择。

沿用现有 knowledgeBaseIds 数组和 schemaVersion 1，不迁移已有数据。继续使用现有同步、目录有效性判断和项目表单样式，不增加锁、队列或后台任务。

1. 修改 knowledge-base-manager.ts：逐项校验选择，按绑定顺序解析所有有效 read 目录，返回 idKey 对应的 id；沉淀接受明确目标，并验证属于项目绑定。
2. 修改 service.ts、catalog-reader.ts：保留全部绑定，部分知识库不可用时仍提示；通过现有 IPC 和 preload 传递沉淀目标。
3. 修改 KnowledgeBaseSelector.tsx：选择后替换为单个知识库并关闭下拉框，保留清空选择，不自动清空已有多库绑定。现有 KnowledgeDialog 中复用单选组件选择沉淀目标，目标组件单独建文件，缩小 HarnessBoardView 改动。
4. 修改 autobiz_kanban/hooks/render_session_context.py：解析知识库数组，逐库加载，重复系统及单元编号按知识库区分，空数组仍使用本地和会话工作区文档。保留原有注入指令。
5. 补充多库顺序、部分不可用、清空、沉淀目标校验、插件重复编号及局部失败测试；运行相关测试、类型检查和修改文件 lint，不做浏览器验证。
6. 对齐知识库设计文档中的参数格式及项目选择规则。不提交或推送代码。
