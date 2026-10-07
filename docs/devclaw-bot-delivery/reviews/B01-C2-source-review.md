# B01-C2 增量源码审查

2026-10-07 · implementing；不是最终接受

## 首代码与构建事实

唯一实施者仍为原 `/root/b01_contracts_high`、gpt-6.1-sol/high、B01-A02。代码 aea0b95339caa4a3700d30cc3e0fe551f7739c18 的17允许文件、736新增行已由主代理完整实际读取（5826ab至92dc4b及9dc535），5542d6范围与d19f7e diffcheck符合任务。原C1/B1、POM、契约与V1未修改；build只追加6项HTTP单元测试，旧25项保留。

0147ce983a20706f92458413b3fa4d840e88c314保存子代理唯一build12101/e99263确切exit0：30main/8test真正重新编译、31JUnit零失败/错误/跳过、1107同3f0a475a零差异、67自身class major52、34固定库及原资源/fatjar审计。主代理1915e5/f57535实际读取六suite XML、dc2b97实际jarSHA相同6e9497bc453549a73157bd89f6fb72f73dc2550daeb510b7cd795cdc39819db3；这是核对自测材料，非主代理独立运行全验。两猜测源路径不存在已dbba50查真实路径纠正，不能据失败命令称所有冻结hash通过。

后续5eaba3确切exit0在真实openapi.json与db/bot-migration/V1__bot_group_storage.sql得到6d98a1a4及6c9a109a完整冻结hash匹配；schema/state/log在dc2b97也实际匹配。原路径诊断错误保留为失败，不更改其exit结论。

严格EOF配置、不可变身份、readiness先于factory、原六selector与一次ID解码、原bytes响应、原错误码、实际byte/时限/容量边界均进入源码。此前缺失ID的substring边界和非ASCII percent十六进制问题已在新RawRoute修复并补unit；未改原Capability。

## 当前待修与待证

1. **C2-R1仍open。** 固定Tomcat会改写头，首ProtocolHeadValve把完整物理value与normalized值比较会误拒普通OWS；子代理也在真实TCP前主动确认。主代理准许仅新http用公开MessageBytes/ByteChunk start/end限定实际value span，当前窗口/数组/offset/名字/顺序/请求行交叉核对、原buffer与Coyote不变。不可从旧尾部重建wire、不可把public getter当实际证明。正常OWS/tab、duplicate、CL+TE、fold多例、absolute-form、合法encoded ID、body伪头、keepalive/pipeline等真实TCP仍必须完成；非可逆折叠诚实说明，不关闭未知风险。
2. **C2-R2有界私有文件。** 新http-fixture先readFile再检查64KiB可能先分配超大同inode文件。已下发同一写者在读前大小检查并有界读取，保留uid/inode/nlink/O_NOFOLLOW/digest/信号/实际owner检查及精确cleanup，补超大/漂移负例。旧helper不改。
3. **整套HTTP与生命周期尚未运行。** 新test-only main/Node启动器草稿在原worker保留，主代理不竞争builder/DB、不同步协调文件进活跃树。真实两库六操作、各拒绝完整九表facts、双JVM握手并发、未知提交TCP丢响应、取消及实际PID/listener/资源收尾、八入口原回归与原dev不变仍待。

最后代码/报告准确SHA、clean停写且所有句柄确定闭合之后，主代理完整diff、独立实测、正常合入并真正重新编译集成产物复验，才能标记C2接受。未扩Runtime/UI/招乎/B02/B03或新公共API；自动续跑保持PAUSED。

## 第二检查点f1f68d8d

主代理619c41/65ed2f/009a26/4b2481/f7eb8c/9e1818/fb1e20完整12文件增量实际读；234434 diffcheck与f1169f worker clean。R2已有读前实际size<=64KiB、固定有界buffer+EOF哨兵、digest/metadata/signal复验和同inode65537B负例，子代理fa6a0f4Node全部通过，主代理最终独立仍待。R1使用真实数组一致/当前span对齐，arrayOffset显式防线已提醒，真实TCP仍未开始。新testmain/launcher/client/SQL/proof均只测试允许文件，既有公开API/生产NONE不改。

connect close/abort已确定收束、HTTP总deadline10s、响应aborted和正常stop的真实原port lsof absence已落新代码。新增C2-R3：全局stopHttpChildren和startcatch只rawchildstop绕过handle的ESRCH/portabsence；已派同一写者统一异常/取消收尾证明，不动未知listener。第二builder97399/98caab/run296367eb唯一运行结果未知，不能借上一编通过；child自行poll，main不竞争。main4cd4ad/a2e20a只读原三完整ID、sameowner/healthy/OOMfalse/回环端口与无testcontainer；未读取旧秘密、修改原环境或恢复自动化。

## 首真实HTTP先决6da6cd07

主代理7033a4/ff6563完整四文件实际增量、cbe2d9 diffcheck/33c98b clean；统一登记handle在所有异常/取消/globalcleanup保留到ownPID监听观察、ESRCH及精确port absence结束，arrayOffset显式0前提已写，R3代码问题修复但真实新生命周期验收仍待。第二build97399/8904cf及第三build17847/c97dfa确切exit0，后者30main/10test/31JUnit/1107同a6370f77零差异/68class52/34libs；reportb4062caa已实际读4b9623，main7456f2实际jar ebd67ee1完整hash同。

唯一先决HTTP99987运行中，worker消息仅第一隔离项目通过六HTTP/四键序重放/重开/12raw/full九表facts并精确清理，第二项目未结束，不能接受完整两库或全C2。该脚本明确preliminary。主代理指出pipeline不能只首404+body contains第二HTTP状态，完整版本须按CL严格两帧无残余且分别原Ajv；401等普通拒绝不能空body跳过schema，容器framing空400/close需单列。child在当前句柄收束后补，不在实跑中改载入源码。所有full授权/数值canonical/竞争/rollback/lost-response/限流慢流/新lifecycle/secret扫描/原回归及main独立仍待，R1未关闭。

99987现已a1aaa2确切exit0，180bdd6c本人报告实际36229d完整读取：两个顺序库各首六HTTP/四键序重放/重开/12有限raw和完整九表facts相等，starts4/secretSends4/active0，精确清理和原devdeepEqual健康。仍仅worker preliminary；reopen PID未打印、pipeline/普通空body分类、full suite和主代理独立都未补完。主代理52b2c2/35199d/daaf64/47b369只读证明现只原三健康容器、原网络/三卷/真实dev目录，无测试资源；没有竞争副作用或读原秘密。
