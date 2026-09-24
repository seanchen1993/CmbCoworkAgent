# 2026-09-24 guest 字符串代码生成限制

基线9dd039a3，codex/mods-v2。宿主修订v63，批准摘要包含契约变化。UAT、共享依赖未修改。

## 原因与代码检视

固定官方声明要求hooks和Client拒绝eval/new Function。此前constructor.constructor可执行字符串但无process，这不代表宿主逃逸，也不等同于已满足代码生成约束。独立guard在插件和注册代码之前由host评估，锁定global eval/Function及四种原生函数原型constructor，保持Function.prototype关系。getter-only应对已实际复现的QuickJS全局data descriptor替换行为。

不关闭QuickJS Eval intrinsic：只读实验表明会同时破坏host evalCode。guard保留原生async/generator语法，不经esbuild降级，以定位真实原型。host剩余evaluate调用仍为批准初始模块或固定/JSON编码表达式；未增加插件源码执行API。修改范围只在FunctionGuestRuntime，不改变主进程/renderer/V1。

## 失败先行与验证

- 新真实guest/Client4失败/1通过（red-2）；最初保留用例误用了禁止JSON键prototype，改名prototypeKept后重跑真实red，不修改生产JSON规则。实现后新6项加原guest-runtime11/async-scope16/publicJSX6，4文件39项通过。
- 原生async/async-generator测试直接在QuickJS中应用同一生产guard，避免经降级后误测普通构造器。真实属性替换/set/delete测试、注册前/真实host异步续接/隔离Client均覆盖。普通函数、generator、regex、SDK与无ambient API检查保留。
- 普通旧包Electron真实initial/later全部executed:2，未达到拒绝断言（84194 exit1），作为真实red保留。新普通包专项5检查通过（86185 exit0）：实际hooks注册前与SDK后拒绝、Client9路径均拒绝但按钮计数正常、renderer重载保留计数、持久化撤权及重新批准归零、global off移除插件命令/控件且原composer可用。截图已查看。完整Mods57含5 renderer为151文件1329项通过；实际utilityProcess42检查和完整Electron223检查通过（1391 exit0，已恢复普通out），结果副本保留为guest-codegen-full-electron-result.json。完整Electron使用真实应用/guest/IPC/原生工具和受控协议provider，不等同于外部商业模型业务验收。独占performance smoke完成（68315 exit0），artifact desktop-performance-2026-09-24T05-50-19-079Z-smoke-7efe62b5：TTFT p95 126.2→163.8ms（+37.6ms），吞吐比0.993970，约1秒idle差+1.916739单核百分点。stream预算子项passed=true，但每组仅2样本，整体qualified=false/passed=false；不构成正式性能通过或优化效果归因。
- helper类型闭包digest收窄及QuickJS测试结果联合类型的错误已修，使用unwrapResult管理句柄，Node/Web/helper types通过，diff ESLint9文件0error/修改行无诊断，旧root88 warnings保留。

正式性能、长稳和Actions门禁仍待完成；本能力不作为最终业务验收。

完整Electron内的关闭原生读取对照：baseline p95 3.0162ms、关闭2.9953ms（-0.6929%，各500样本/100预热）；单独no-op1000 p95 9.2688ms，pendingRequests=0。这些是该套件的单次对照，不能覆盖此前正式多轮ingress关闭失败，也不是长稳内存结论。
