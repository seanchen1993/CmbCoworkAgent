# 四方向统一迭代：体验与边界评审

工作区：`C:\ai\CmbCoworkAgent-mods-v2`，开发分支 `codex/mods-v2`。

## 方案结论

作为第二位评审者，审阅 `mods-integrated-iteration-contract-2026-10-01.md` 后通过。
通过前补充了两项约束：草稿 fill 必须使用 hook 链前取得的真实 composer lease，不能在
hook 等待用户输入之后重新抓取版本而覆盖用户草稿；关闭的项目规则不能以默认 scope
阻止合法的附加检查范围，启用规则才参与目标冲突判定。

## 本域实现

- 保存版本应用前展示能力、组件、参数字段、模型、Skill/MCP、流程和规则变化，不显示参数值。
  显式确认带配置 revision、绑定 revision 和 workspace，主进程再次检查，运行中仍不能切换。
- 升级只采用已批准的同来源包；保留组件范围及原参数。缺失组件、新依赖、不符合 schema 的
  字段展示为待处理问题。插件动作引用改变时先建立真实 Flow 新副本，不伪造旧摘要，不改活动副本。
  修复副本保存携带 expectedWorkspace，防止目录变化后保存到另一个项目。
- 模型编辑区默认、角色、固定型号互斥，说明实际优先级。旧双字段继续按固定型号执行。
- Claw 附加规则与项目底线分别展示，合并预览不授予额外写入或阶段推进权。
- 测试总结只统计当前代次、未失效、具有真实 evidenceIds 的 native-check 回执；文字声明、
  历史 PASS、跳过记录不作为当前测试通过依据。
- Autobiz 三个宿主预设接入流程库；插件汇报支持选择“本次执行结果”输入，动态字段之外的
  必填参数继续校验。可运行的已应用 Flow 不因模板列表暂空而显示“先保存”。
- prompt read/fill 注册当前可编辑 composer，原子检查文本 revision 与 UTF-16 cursor，
  不传附件或技能 chip，不自动发送。fill 前再次向主进程请求一次性有效授权，授权等待期间
  用户编辑、关闭 composer、切换 owner 后拒绝迟到写入。空 read 留下失效 lease，不能授权
  随后才出现的输入框。SDK readback 的 peek 不刷新 CAS lease。

## 已执行定向验证

- 六个单元/IPC 文件 75 项通过：`output/mods-integrated-ux-tests-final4.log`。
  包括升级、隐私预览、绑定和 workspace CAS、参数动态字段、真实测试证据以及 broker
  取消、撤权、owner 切换、空 read、prepare/peek 的竞态反例。
- 新交互五组：`tests/mods-integrated-ux-browser.spec.ts`，报告在
  `output/mods-integrated-ux-browser/report.json`。
- 草稿桥接六场景：`tests/mods-prompt-browser.spec.ts`，报告在
  `output/mods-prompt-browser/report.json`。UTF-16 插入、附件边界、用户修改、授权等待、
  弹窗及关闭 composer 均有真实 React/browser 操作。
- 原有组件浏览器四组和流程浏览器二十组通过。原断言保留；新增应用确认点击和模型模式选择。
  旧 Electron 脚本同步补真实确认操作，最终 Electron 运行由主协调者统一执行。
- 最后生命周期检视补充：detach 按原 sender/thread/owner 释放，不要求被删除或改为只读的
  线程仍有可写 scope。每个 WebContents 仅注册一次 destroyed listener，销毁时只清该 sender
  的 owner 和 pending，旧 read lease 保留为墓碑。新增 IPC 四项、broker 一项后，两文件
  十六项通过：`output/mods-prompt-lifecycle-tests.log`。这十六项与前述七十五项有重叠。
- FlowsPanel 和使用指南不再错误宣称 Harness 全部不支持，明确区分有效本地项目/Feature
  与自动控制器、远端、IM、定时及独立子线程。浏览器验收检查可用宿主目录仍能创建流程。

浏览器使用受控 IPC，用于检验交互与时序；不能替代 Electron 主进程权限验证。
截图使用现有生产 CSS，统一最终构建之后应再执行相同脚本生成交付截图。
类型检查、构建、最终 Electron、全量回归和性能结果，以统一交付报告为准。

## 交叉代码检视

已检视主协调者的完整 Skill 正文扩展、工具描述、模型 effort 与独立取消接线。
发现已捕获 Skill authority 的分页读取在 Mods 关闭时可能退回原文，已反馈并由主协调者
将 authority/abort 检查移到 fallback 前，增加禁用中途分页反例。
工具描述的第三方 provider 来源需使用宿主固定真实来源，主协调者已说明 session.tools
来源映射以及 MCP user 来源；最终验证须包括该映射。

effort 当前明确映射已有 DeepSeek low/high/max 传输，其余不支持值拒绝，不能宣传为全部
供应商的 effort 已支持。独立取消保留父取消和撤权优先，不将普通父取消伪装成成功结果。
本评审没有重新宣称完整 Claude API、所有 Harness 内核、远端执行或任意副作用回滚已对齐。
