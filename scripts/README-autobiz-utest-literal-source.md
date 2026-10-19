# AutoBiz UTest Hook 字面量兼容来源 1.0.4

本修订只用于生成新的本地插件来源，不更新上游仓库、历史来源、已安装插件或旧 ZIP。

原 `hooks/augment_test_engineer_task_prompt.py` 在模块加载时调用模板
`.format(marker=APPEND_MARKER)`。模板内未转义的 `${PIPESTATUS[0]}` 被 Python
解释为格式字段，导致 `KeyError: 'PIPESTATUS'`，甚至非目标角色尚未过滤就失败。
新来源只把该模板字面量改成 `${{PIPESTATUS[0]}}`；实际追加给测试子代理的内容仍为
`${PIPESTATUS[0]}`。原 assignment 路由、校验、拒绝行为和重复追加保护保持不变。

- 新内核版本：`autobiz.python-kernel@1.0.4`。
- 新来源插件：`autobiz-utest-literal-compatible@1.0.4`。
- 原 Hook SHA256：`483be49a2ad837e1fb24797ffbbf8e53b47bdcbd017ffa6029d1cbfa926c2d3a`。
- 新 Hook SHA256：`c315b5d820427bdb2e30dea4e4929fdb648bf1d2ac049723465d8587b4b74824`。
- 原 workflow 字节保持：`7a49595b62bc1b8498ab3413be9304eed4de8ada37a8e43f906e43be51874667`。

该 Hook 属于完整受审内核文件闭包，原声明为提示约束追加 Hook；它不属于平台已有的
必需安全 Hook ID 列表。本修订没有扩大该列表，没有把原零退出码的无 `updatedInput`
拒绝结果改成新的阻断协议。新 profile 完整继承 1.0.3 的所有文件、模块定义及检查命令，
仅改变版本与这一项文件 SHA。未知版本、未知原字节和自行重算的篡改摘要继续拒绝。

生成方法（Node 22 与本仓库 tsx）：

```text
node --import tsx scripts/prepare-autobiz-utest-literal-source.ts <全新输出目录> <精确1.0.3来源目录>
```

脚本要求输出位于来源之外且不存在，同时核对完整原来源摘要；完成后核对每个新文件及
原来源摘要，写入独立 receipt。来源生成步骤本身不打包 ZIP，也不能代替实际应用端 Code 流程验收。

已受审来源的独立素材库使用 `package-autobiz-utest-literal-library.ts <全新输出目录>`
生成。它复用原组装器与准入检查，生成完整 AutoBiz 10 和数仓可验证产物生产者 12，
两者为新插件身份及版本 1.0.4；通用消费插件 13 直接保留原 ZIP 的全部字节。
数仓生产者仍独立止于质量阶段，不包含 Code 模块，因此不附加 Code workflow 资源。
进度 Mod 仅更改 kernelRef 与插件版本；知识 Mod 使用明确允许的 1.0.4 版本。
素材库 receipt 与逐文件 ZIP 回读只能证明打包、编译及准入，不代表实际业务流程通过。
