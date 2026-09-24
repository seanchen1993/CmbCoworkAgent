# 2026-09-24 Client 刷新通知范围

基线faff7fa1，codex/mods-v2，宿主修订仍v62：此次没有扩大插件授权能力。仅Mods工作树，未触碰UAT和共享依赖。

## 问题和实现检视

独立Client更新原来沿panes.notify→session→manager→cards-changed通知所有站点。虽然相同props通常命中站点绘制缓存，每条历史输出仍需额外IPC、宿主授权与结果发布查询。现在仅Client通知附加panes范围，FunctionSite只忽略这个明确范围；其它订阅者和原通道继续工作。没有加入新的缓存或事件队列。

原合并timer在判断更早deadline之前合并范围，缺省全局优先，两个到达顺序都不丢失显式失效通知。ui.invalidate仍同时失效Pane/sites并发送全局，site动作/V1缺省/配置仍走原链。关闭清除timer。源码检视确认原site host-driven渲染不反向广播的保护保留，避免重新引入渲染风暴；Client独立绘制没有绕过assertLive或publication。

## 失败先行与验证

- 新main通知5项加renderer1项先红5失败/1通过。真实Client Session发出的原scope为空；生产FunctionSite订阅窄测20条Client事件使siteRender由1变3。该renderer测试调用实际组件及订阅代码，但使用最小React hook/bridge夹具测调用次数，不是完整React DOM或业务验收。
- 实现后合并时序/关闭/真实Session通知，以及原site content、lifetime、queue、invalidate，6文件30项窄测通过。另补未知scope仍走全局的回归，将由完整套件覆盖。测试初始挂载数受props初始失效影响，按实际初始数量+1验证配置重建，未修改生产生命周期来匹配错误常量。
- 普通旧v62包Electron红测收到三条缺少scope的真实IPC通知（ui-notification-electron-red.log/artifacts）。新普通构建专项4检查通过（green.log/artifacts，48806 exit0）：实际Client计数更新只发panes，PromptHint/CommandOutput保留；显式SDK全局重绘更新两站点且Client计数不清空；renderer重载和关闭恢复原提示/原命令结果/composer。监听只读公共onCardsChanged，未替换真实bridge。
- Node/Web/helper types通过。最终diff ESLint12文件0error/新增行无诊断；原IPC29/session2/preload声明9/preload22/rootE2E88条warning保留。
- 完整Mods54四worker含5个renderer文件：149文件1314项通过；实际utilityProcess41检查通过（13077 exit0）。普通新包client-focus专项9、ui-invalidate专项6、desktop-history专项4检查通过，后者包含50条真实保留命令/4个Client/200次确认与重载/off。随后独占performance smoke，exec20133 exit0。artifact `desktop-performance-2026-09-24T04-49-32-229Z-smoke-29ff9710`：TTFT p95 110.2→176.5ms（+66.3ms），吞吐比0.992658，约1秒idle差+0.582357单核百分点；qualified=false/passed=false，每组仅2个stream样本，不能推导正式性能通过或性能变化归因。

最终矩阵证据及renderer通知窄测3项通过，diff ESLint12文件0error/修改行无诊断；实际Electron新场景截图已查看。

减少无关查询不等于正式性能门禁通过；保留正式TTFT+67.7ms、ingress关闭预算和长稳6407事件失败。未本地打包或触发Actions发布。
