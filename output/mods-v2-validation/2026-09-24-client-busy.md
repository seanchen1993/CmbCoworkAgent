# Client并发忙态修复 — 2026-09-24

基线bfbb7d45（应用仍v63）。本次唯一生产改动位于renderer FunctionClient.tsx：busy来自非change控制的待完成计数；每个press/submit/select只释放自己的计数，change完成不释放别的操作。保留实际Client key/id生命周期和mounted防迟到更新，不修改主进程队列、intent、权限、句柄、重试或timeout，不触碰主composer/V1。

## 有效失败证据

第一次fixture缺少本工程Input必需的onSubmit，组件停止，未进入并发断言（client-busy-red.log）；补fixture而不放宽生产验证。

旧普通Electron第二次真实运行（client-busy-red2.log）在late input must not unlock pending press断言失败：实际安装批准插件，ui.input通过原clock.sleep1000保持pending，再真实点击，ui.press原clock.sleep2000内250ms逐帧观察发现aria-disabled提前解除。没有替换IPC、伪造guest结果或人工派发合成点击。

## 验证与范围

helper/Node/Web types、diff lint3文件通过（根E2E旧88warnings无新增）；普通构建与新专项Electron4项通过（91461exit0），截图已检视。代码检视补测试末尾恢复全局开关，避免影响完整套件后续独立项目。新测试还覆盖off中止pending、原composer可用、重新启用的独立Client/store不接受取消旧press。

完整Mods59（含5个renderer测试）152文件1333项、真实utility process44项、完整Electron226项均通过（90522exit0），已恢复普通out，完整JSON另存client-busy-full-electron-result.json。最终helper types、6文件差量lint及CI窄测均通过（27807exit0，CI另行提交）。

独占新构建性能smoke：desktop-performance-2026-09-24T07-06-01-731Z-smoke-1ba715da，关闭/开启各2样本，TTFT p95 112.2→177.4ms（+65.2），吞吐0.996833，约1秒idle差+2.061336百分点，qualified=false/passed=false。不是正式性能PASS；本次短测不被用来抹掉修复前3c569546正式通过或更早正式失败。当前新UI构建仍需相关正式门禁。

代码检视：每个非change操作只加减自己的计数；无新callback重试、无宿主身份或lease变化，原控件忙态guard仍拦截重复操作，取消后新实例不同key；helper收尾恢复全局开关。本次独立重现的busy缺陷不被认定为旧6408事件ACK丢失根因，正式长稳仍需保留诊断重跑。
