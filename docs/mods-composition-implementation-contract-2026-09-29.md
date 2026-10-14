# 本轮组合能力实现契约

承接 `mods-composition-gap-and-sidebar-plan-2026-09-29.md`，实现前供两位独立评审复核。

1. 不更换运行时，不解除同项目 Flow 执行互斥。对话配置隔离不等于允许同目录并行修改。传统 Plugin/Harness/后台会话不应用本次 Claw 绑定。
2. 新 Claw 绑定按 canonical workspace + 可信根 thread + incarnation 保存；旧项目 active 仅作未绑定对话的兼容默认。绑定保存完整 Profile 副本，模板编辑不修改已应用副本。运行中不可切换本会话绑定；切换只关闭该会话运行资源，不使其他会话 authority 失效。内部 Flow child 经可信父链校验后继承父绑定。
3. Profile 扩展可选 `models`（default 模型引用及 roles 映射）、可选已保存 Flow 副本。普通对话使用绑定默认模型，显式流程使用节点显式模型 > Claw 角色模型 > 原角色配置 > Claw 默认 > 宿主默认。模型不自动静默降级；配置变化在运行边界被拒绝，不把 ref 称作完整版本快照。
4. 显式动作采用插件 manifest 的 `claw.actions` 声明，绑定既有 command；声明与模块源共同进入审批摘要。动作身份包含插件 ID/name/digest/actionId；注册 command owner 必须相符。没有声明的插件整体启用，不伪造可任意拆分的节点。
5. 动作输入为有界 JSON envelope（version、config/input、task、run/node），返回有界 `{text?, output?}`，通过新宿主动作入口保留结构化 output，复用既有命令会话、版本、grant 和权限检查。Flow 新增 plugin-action，绑定前一步 output 时只允许明确引用有效已完成前置结果，不能 eval 表达式或选择过期 retry 输出。实际 owner、模型、摘要进入执行记录。
6. Flow 启动前冻结所选插件版本及模型非密钥配置指纹，缺依赖/命令归属不符/输入不符均拒绝；撤权仍即时有效。旧流程继续可用。绑定 Flow 与原模板后续修改隔离；用户可显式重新保存并应用。
7. 输入区仅一个文本输入，显式选择“聊天 / 执行流程”；选择流程不能偷偷改变聊天发送意图。控制器留在稳定会话作用域，右侧是唯一详情视图；关闭不取消，切线程不串状态。保留底部紧凑审批/错误入口。沿用现有右侧容器且不影响 Harness。
8. 本轮统一目录优先暴露可真实执行的 Function Mods 动作、模型、Agent、内置检查。Skill/MCP 只在完成真实宿主适配和选择隔离后可宣称支持，不用目录卡片冒充可组合能力；未接入项明确标注。不承诺任意 hook 自动拆分或替换沙箱/存储。
9. 验收至少两个独立插件真实动作联调及输入输出传递，模型 A/B 真实适配器请求归属（受控服务），线程绑定隔离、配置修改、撤权、失败、取消；右侧交互和存量 Plugin/Harness 回归。报告严格区分受控 E2E 与线上模型业务质量。
