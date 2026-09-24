# 2026-09-24 公开 JSX factory 与 Client 安装扫描

基线10337a4d，codex/mods-v2，宿主修订v62。仅Mods工作树，UAT与共享依赖未修改。

## 实现与代码检视

真实hooks与隔离Client使用同一h/Fragment实现，与原私有编译别名函数身份相同。getter-only不可配置绑定阻止赋值、删除、Object.defineProperty替换。实际QuickJS全局只读data descriptor仍允许改value，故不能用检查属性描述符代替行为验证；没有升级或修改共享VM依赖。

Fragment明确column Box，修正原私有Fragment默认横排；应用React Fragment未修改。constructor-only、子节点省略/数字规范化、显式children优先、24层/1000节点限制及callback owner/generation保留。string tags拒绝。JSX为类型元数据，不伪造运行时对象，也不宣称完整upstream namespace类型检查。静态Client模块发现支持直接h(Client,literalProps)、解构重命名和原编译factory；任意factory别名/globalThis.h未声明支持。

## 失败先行与验证

- 新真实guest/session/Client 6测试先全部失败；实现中只读全局测试仍失败，getter修正及增强真实redefine/set/delete/alias identity后6通过。
- 普通旧包Electron首先因h/Fragment undefined失败。新包暴露真实安装链缺口：h(Client,...)未被静态扫描，面板空白；先将原loader测试参数化，12项中h用例失败（client模块为空），再补识别。原路径限制与摘要复检保留。loader/guest/matrix窄测3文件20项通过。
- 新普通包Electron5检查通过（91567 exit0）：真实hooks/Client公开factory、原编译Fragment实际列布局、真实控件回调及父重绘保留Client计数、renderer重载、持久化撤权、新session重新批准后计数归零、关闭移除命令/控件且composer可用。截图已查看。此前失败输出保留为red和green首轮记录，不覆盖。
- 完整Mods55暴露旧独立Surface重复定义readonly globals的3项失败；新增共享factory断言也先失败，再移除SURFACE_BOOTSTRAP重复定义，保留旧状态/回调/timer，3文件22项窄测通过。原失败结果保留，待完整重跑。
- 最终Node/Web/helper types通过，diff ESLint8文件0error/修改行无诊断，旧root E2E88 warnings保留。完整Mods56含5 renderer为150文件1323项通过，真实utilityProcess41检查通过（31524 exit0）；过程失败没有被抹去。最终普通构建再次通过公开JSX5、通知范围4、Client焦点9检查，含真实撤权/等待中关闭/输入框对照；独占performance smoke（77934 exit0）完成，artifact desktop-performance-2026-09-24T05-18-48-487Z-smoke-362d2291：TTFT p95 112.8→178.2ms（+65.4ms），吞吐比0.993766，约1秒idle差+2.033015单核百分点，qualified=false/passed=false。每组2个stream样本，不能声称正式性能通过或归因优化效果。

正式性能TTFT、ingress关闭、两小时长稳及Actions安装门禁仍待完成。本报告不作为最终业务验收，不以短测替代正式门禁。
