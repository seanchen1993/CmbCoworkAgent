---
name: autobiz-lean-solution
description: 设计与实施方案
---

先读工作区 Definition.json 与固定插件包根目录下的 contracts/solution.md，基于真实源码形成 Solution.json 的设计、设计锁和最小交付批次计划。从该包根定位tools/design-lock.py，以JSON标准输入{feature,lockedAt,design}派生designLock；将完整Solution JSON传入同包tools/solution-pipeline.py标准输入，所得对象写入plan.parallelBatchPipeline。运行命令为python -I -B -X utf8 <脚本绝对路径>，不手写哈希、执行或审批事实。全场景覆盖、来源/设计/任务引用与依赖必须一致。用户需要未支持的执行范围时保留需求并明确阻断。Host批准整个方案版本后才进入Code。

RequestBaseline.json仍是完整校验输入；不得因初始阅读从Definition开始而删掉其依赖。需要追溯需求决定时读取基线，引用DEC时保留实际决策正文及来源，不只留下编号。

仅完成本阶段。feature在全任务一致，输出UTF-8/LF。缺失事实要澄清，失败要修实际产物；不得删检查、改上游或自报批准。Python使用python -I -B -X utf8，stdin/stdout严格UTF-8。完整校验输入不受初始阅读清单影响。
