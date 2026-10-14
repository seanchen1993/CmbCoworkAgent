# 在制作会话里复用本包

先由用户通过原插件入口安装并授权此提供者。项目消费者不复制本包文件。

对助手说：“制作一个起草和确认的文档项目，在确认阶段复用已经安装的公开 format 动作，再把输出交给 format 处理一次。”

实际工具顺序：

1. `project_scaffold` 创建草稿，记录返回 revision。
2. `project_actions` 读取真实授权目录，找到此包的 format。以返回的 `pluginId`、`plugin`、`digest`、`actionId` 为 provider；本例不预填安装身份。
3. `project_bind_action`：stageId 为 review，localActionId 为 format-note，actionInput 为 `{"text":"需要整理的文字"}`，其余使用真实草稿 id、revision 和目录 provider。
4. 使用新 revision 再绑定 format-again，actionInput 为 `{}`，inputFrom 为 `{"kind":"action","actionId":"format-note","pointer":""}`。
5. 使用新 revision 执行 project_doctor、project_test、project_pack。

两次绑定只生成一个独立消费者包的动作锁。project_test 运行产物样例，不执行 format。用户安装消费者并在项目入口开始阶段后，才会走真实 Skill、公开动作、权限与检查链。此动作返回结构化 text；它本身不创建文档，也不证明文档质量。

若未列出提供者、摘要变化、服务未注册或输入不符合 schema，先处理诊断。不要手写假 UUID、自动批准权限或直接导入本包内部函数。
