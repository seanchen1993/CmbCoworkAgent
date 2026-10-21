# AutoBiz 可执行状态扩展

本组件是现有 Function Mods SDK 上的业务扩展，不需要新增状态机 SDK 或平台专用 API。
它作为业务 catalog 的常驻扩展加入完整 AutoBiz 插件，原业务模块、依赖闭包、组合源码、
资源锁、知识配置及原 Hooks 保留。

`register.ts` 注册读取、预检、推进和只读对账工具及对应 slash 命令。`graph.ts` 在隔离
JavaScript 运行时选择允许的业务边；`adapter.py` 真正调用原 AutoBiz 业务校验，
`commit.py` 在准备结果后持有 Windows 本地 NTFS 双文件独占句柄，写入规范 state.json
及 STATE.md。`journal.py` 持久记录本次请求和物理回执。未知结果不自动重放。

辅助 Skill `autobiz-mod-state-control` 提供使用说明，参见 [SKILL.md](SKILL.md)。读取、
预检、执行和对账仍经过现有原生命令权限，安装或启用组件不会自动批准进程。

这一版本增加显式状态动作，**不会自动替代原业务 Skill 的直接 CLI 推进入口**。
原 Hooks 声明保留不等于其按旧 execute 命令匹配的每个分支都自动在新进程入口执行；
新入口的适用范围及原人工门禁衔接须以新包实际验证报告为准。

支持范围限于固定七主阶段；详细设计分支的开启仍须原兼容流程，新状态工具不能自行
选择启用。JavaScript 中声明的候选边仍必须通过原 Python transition/lifecycle、
产物及 postcheck 校验继续约束所有推进。初始化、新建 Feature、回退、任意插入节点
仍为原兼容能力，不是状态 Mod 已托管的功能。归档产物物理移动与 checkpoint 推进不
构成一个统一原子事务；没有统一宿主权威状态、自动可信阶段终态或绝对文件隔离的承诺。
