# 2026-09-24 正式桌面长稳失败记录

被测提交：0664963b，运行前工作树干净，普通应用，无测试 IPC 桥。启动命令 `node tests/run-mods-desktop-soak.mjs`，完整包与驱动 SHA 在原 artifact/run.json。

原 artifact：`desktop-soak-2026-09-24T01-39-36-251Z-full-a535898b`。开始 01:40:33.073Z，退出 02:57:55.091Z（exit 1）。completed=6407，cycles=25，elapsedMs=4637034.926，qualified=false。第6408次事件填入 Soak3 后点击，等待 ACK_3:1602 超时15秒，未延长超时。既未达到2小时，也未达到10000事件，不能作为长稳通过。

隔离 profile `C:/Users/87624/AppData/Local/Temp/cmb-mods-e2e-eYAm4L` 保留，只读检查。SQLite mods_function_state 的实际计数为 [1602,1602,1602,1601]，与截图一致，因此并非只有页面漏显已保存的1602。50条 mods_jobs 均为 succeeded。

## 已确认的独立缺陷

命令历史公开最多50条，React对每条输出挂载CommandOutput；宿主错误复用其他消息位置的32槽上限。主日志滚动文件中大量 mods:function-site-mount / MODS_UI_SITE_LIMIT，截图也有原生错误回退。每次Client变化广播后失败位置再次尝试挂载，形成无效IPC和日志负载。另有较早的Pane stale action日志，最后15秒没有Client错误记录。

这些证据不足以断言容量冲突就是第6408次点击超时的唯一原因。先修复可确定重现的容量冲突；需要继续定位点击/IPC/Client确认路径，不能将容量修复称为已解决长稳失败。

## 测量边界

179个强制GC窗口。已完成6407次事件的原生输入到第二帧 p95=11.7ms、最大27.6ms；点击到宿主ACK的DOM更新 p95=380.5ms、最大1238.5ms。失败事件不包含在成功分位数中。

每千次live renderer GC后堆中位数依次15.781、16.212、16.513、16.715、16.920、17.111 MiB；最后407次17.206 MiB。主进程WSS中位数482.24→586.97 MiB，后者不是强制GC堆。不能由这些数据宣称无内存增长或内存门禁通过。25个off窗口已观测Function Mods utility退出，legacy Mods进程不是同一断言对象。

TTFT、吞吐、五分钟空闲CPU由独立性能门禁衡量，本次不覆盖。此前正式TTFT预算失败、关闭模块ingress预算失败仍待处理。
