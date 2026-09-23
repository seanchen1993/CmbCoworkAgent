# 消息展示和真实 Client 进程验证

基线：`6b39eb52`；仅 Mods v2 工作树，未更改 UAT。验证日：2026-09-23。

- 新能力先有不支持 site 的失败测试，再接入生产位置。追加真实编译示例和只读
  first-of-reply 回归：2失败/23通过；修复 invalidate 参数和事实固定后25全部通过。
- 代码检视发现默认 site 容器可能改变存量字号/布局；追加2失败的 SSR 对照，改为
  `display: contents`，保留原生 rich content。生产原始 transcript、复制和模型调用未改写。
- sites、message renderer、native fallback、lifetime 和原 message timing 共5文件41通过。
- Node/Web typecheck 和变更源码 ESLint quiet 通过。第一次 Node 检查发现测试联合类型
  隐含 undefined，改为显式 ModObject 后复验通过；不掩盖首次失败。
- focused Electron 第1轮因示例漏传 invalidate 事件失败；第2轮3检查通过；最终布局修正后
  第3轮3检查通过：实际发送两轮、真实 utility guest、多个消息 owner、HTTP请求原文、
  SQLite历史原文、重载恢复与全局关闭原生展示。为本地受控模型传输，不是业务验收。
- 真实 utility process 第11轮暴露旧 Client 测试假定同步投递；生产已在70750e10改为
  每帧合并。测试改为事先订阅真实状态写入事件、2秒截止等待、每次核对计数；第12轮exit0。
  120帧/20预热，100次 snapshot+press+guest message 的p95为32.4904ms，最大33.5669ms。
  此结果是隔离进程组件回检，不代替8插件/4面板整应用性能门槛。
- 此前综合 Electron11 的83项通过覆盖 v36；本次消息扩展使用独立 focused E2E，不混称
  最终全量已通过。全量Vitest的26项已执行隔离提交基线对照，仍需保留原有失败说明。

本地原始日志前缀：`2026-09-23-message-*`、`2026-09-23-electron-message-sites-*`、
`2026-09-23-function-process-12.log`。截图/记录归档：`2026-09-23-message-sites-artifacts/`。
新功能只影响呈现，不能伪造测试、业务验收或 checkpoint 结果。
