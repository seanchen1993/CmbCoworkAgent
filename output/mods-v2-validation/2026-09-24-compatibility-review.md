# 2026-09-24 兼容表范围与真实可用性复核

基线7ae3c6ab，仅Mods工作树，无应用生产代码修改。245条声明为49 adapted/153 partial/43 unsupported/0 full；96条缺note planned项逐项查证，另15条classic已有明确schema-only缺口，替换占位标签而不提升状态。

## 失败先行与代码检视

新增全表范围检查和实际hooks/Client可用性检查，先3失败/3通过（compatibility-review-red.log）。SDK不可用性负测已通过，不为匹配矩阵去暴露能力。依据session/manager/SDK分发/renderer/Client/事件目录/loader与具体测试逐项填写限制；不从SDK同名机械推导engine支持。进一步源码检视确认Client控制也走宿主control hook，修正文案为实际Pane envelope。

全局探针通过真实FunctionGuestRuntime和CLIENT_BOOTSTRAP执行；独立utility追加hooks/Client两项。SDK负测合并SDK与operation里声明unavailable的名称，真实生成的guest SDK中均不存在。它们证明暴露边界，不是各API的全部语义。原有full/adapted必须有实际测试路径及范围的规则保留。

## 验证

- 窄测4文件25项通过。
- 完整Mods58四worker含5 renderer：152文件1333项通过；真实utility44项通过，包含新增两项真实跨进程全局探针（64064 exit0）。
- Node/Web/helper types通过（84280 exit0），diff ESLint4文件0error/0warning。普通v63 Electron代码生成专项5和公开JSX专项5通过（26501 exit0），包含真实撤权/重建/关闭/原composer对照；最终矩阵及可用性窄测4文件25项再次通过。
- 应用生产源与刚通过完整Electron223的v63完全相同；沿用其独占performance smoke证据：TTFT+37.6ms、吞吐.993970、qualified=false/passed=false。不为文档改动重复短测，也不据此覆盖正式性能失败。实际utility性能采样仍保留在本轮process.log，不作为正式门禁。

未修改UAT、共享依赖或GitHub工作流，未本地NSIS、push或发布。不以文档更新宣称全部剩余功能或业务验收完成。
