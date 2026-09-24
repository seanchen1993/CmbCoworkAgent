# 2026-09-24 Client 主动焦点

基线971d1261，codex/mods-v2，宿主修订v62。只修改Mods工作树，UAT与共享依赖未触碰。

## 实现和检视

$.ui.focus此前只允许Pane原生控件，Client目标被直接过滤。现在按已发布绘制顺序解析同一插件在同一Pane中的原生/Client Button、Input、Select。Client绑定实例ID与当前控件handle；每次probe/apply/ACK从FunctionClients私有实例表复核，不能只依赖可能落后的Pane快照。ACK同时复核初始与Hook改写后的目标。renderer真实DOM同时匹配owner/key/Client实例/handle，沿用窗口可见性、原键盘归属和人意图epoch检查。

原dispatcher完成后才请求实际DOM聚焦，after-next空deny不会先移动。ACK继续走原独立IPC，不在父ui.message等待中再向同Client队列等待focus回调。原自动聚焦、Client根focus观察、忙碌事件守卫、Agent/原生工具/审批/完成循环均不改。v62扩大目标范围后需重新批准摘要。不是跨进程DOM与撤权的原子事务；最后ACK复核不承诺回滚已经发生的DOM动作。AbovePrompt、非桌面和完整嵌套focus/blur观察仍未支持，矩阵保持partial/bounded。

代码检视覆盖发布快照与私有表独立改绘、同key删除后重用、改写目标的ACK核验、native兼容、关闭/撤权及队列等待。新状态仅请求生命周期内多一个handle，无独立长期缓存或正向授权缓存。

## 失败先行与验证

- 新真实QuickJS/FunctionSession 14项先全部失败（client-focus-red.log）：原Client目标无法进入probe。实现后补原signal取消，15项通过；包含post→parent→SDK→双ACK后队列仍可用、独立改绘/删除重用、无关文字更新仍有效、双向改写、晚空deny、伪造handle、重写目标过期、unmount/revoke/close。
- 原focus18+pane-focus12+新15+renderer选择2，窄测47通过。renderer选择单测为最小DOM数据夹具；真实DOM另由Electron证明，不将夹具当实际桌面验证。
- 普通旧v61包的新Electron专项真实返回Element is not drawn by this plugin（client-focus-electron-red.log/artifacts），而不是成功；普通v62构建后新专项9检查通过（green.log/artifacts）。实际activeElement、Client ID与DOM handle验证成功；含空deny、Client/native互换、composer归属、人意图竞争、renderer重载、持久化revoke needs-approval、重新批准后另启pending再global off。无额外model请求。成功截图已查看。
- Node/Web/helper类型通过；最终diff ESLint12文件0error/修改行无诊断，仅旧root E2E88条warning保留。类型检查期间发现并补齐递归辅助函数显式undefined返回；一次局部格式修正产生的语法残片已修正，最终构建/测试通过。
- 完整Mods53四worker含额外renderer：144文件1298项通过；真实utilityProcess41检查通过（76814 exit0）。未放宽原测试超时。
- 普通v62原生imperative-focus专项9检查、ui-invalidate专项6检查通过；随后独占performance smoke，exec50615 exit0。artifact `desktop-performance-2026-09-24T04-30-54-105Z-smoke-381328bc`：TTFT126.5→178.3ms（+51.8ms），吞吐比0.992566，约1秒idle差+2.165961单核百分点。每组只有2个stream样本，qualified=false/passed=false；不是正式性能通过，也不能据波动归因本次改动。

本次完整Mods回归包含存量功能；Electron采用真实新能力及相关存量专项。前一v61完整204检查不能描述为本次v62完整Electron通过。正式长稳6407事件失败、正式TTFT+67.7ms失败、ingress关闭对照和Actions安装门禁继续保留；本地不打NSIS、不触发发布。
