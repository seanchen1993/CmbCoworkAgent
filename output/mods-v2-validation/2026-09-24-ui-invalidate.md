# 2026-09-24 ui.invalidate operation 生产桥

基线 ae834f7d，codex/mods-v2，宿主修订v61。仅Mods工作树；UAT与共享依赖未修改。

## 实现与代码检视

SDK原来直接标记Pane/site失效，导致同名operation Hook不会执行。现在经过原FunctionSession dispatch，保留调用registration跳过、depth/turnHeld、原authority/取消和结果发布；core再次核实signal与plugin有效性。只允许一个ui.render参数，改写输入必须严格为{event:"ui.render"}，返回使用原void operation envelope。空deny同样拒绝；before-next拒绝不执行core，after-next拒绝不声称回滚已发生的重绘失效。宿主v61需要重新批准摘要。

检视没有扩大到任意事件广播，没有改通用guest bootstrap或命令取消语义，没有绕过ModsManager/FunctionSession。运行中命令cancelJob仍unknown；session撤权/关闭导致原job failed/MODS_CANCELLED，两者按原账本区别处理。

## 失败先行与验证

- ui-invalidate-red.log真实guest首轮8失败/1通过，扩展red-2为9失败/1通过，均在生产实现之前。实现后的真实guest/session14项通过，覆盖Pane/site、取消、撤权、close、同registration跳过、空deny、晚deny、输入改写、返回验证与原恢复规则。
- 测试检视修正了一项错误预期：裸undefined不是合法operation成功envelope；它走原可选Hook恢复。新增显式{value:undefined}短路与裸undefined恢复两项对照，而不是改变guest实现迎合错误测试。最终green-3为14通过。
- 普通旧v60包运行新Electron红测，真实重绘发生但Hook calls=0（electron-red-2.log/artifacts），证明原桥缺失。首次Electron运行还遇到脚本插入位置语法错误，已修正；该次不算能力红测。
- 普通v61 build成功；加强后的Electron专项6检查通过（electron-green-2.log/artifacts），原SDK进入Hook/实际Pane更新、empty deny、原job取消、真实持久化撤权、等待中的global off分别验证。关闭后等待5200ms超过Hook delay，再启用读真实store，after仍1、Pane空、原composer可用。
- 完整Mods52使用4 worker：142文件1281项通过。真实utilityProcess41项通过；Node/Web/helper类型检查通过。ESLint全文件0error、旧session与E2E格式warnings保留，新测试/helper无warning。
- 完整Electron204检查通过（ui-invalidate-full-electron.log/artifacts，exec25277 exit0），普通out已恢复。代码/测试在完整运行期间保持不变，完成后最终diff ESLint5文件0error、修改行无诊断；session原2条/E2E原88条格式warning保留。实际关闭截图已查看：活动Pane消失，原composer文本保留，历史命令账本仍可读。
- 独占性能smoke exec74104 exit0，artifact `desktop-performance-2026-09-24T04-14-05-033Z-smoke-9eaff6a2`。TTFT p95 127.9→178.2ms（+50.3ms），吞吐比0.994378，约1秒idle CPU差+2.536284单核百分点。每组仅2个stream样本，qualified=false/passed=false；不替代正式性能结果，也不把与前次短样本波动解释为本桥接的因果影响。

本能力不代表业务验收、checkpoint推进或完整Claude兼容。兼容矩阵的SDK与operation均为partial/bounded，固定参考官方v2.1.278声明。正式两小时长稳、TTFT及Actions安装门禁仍按原状态保留，不用smoke替代正式结果。
