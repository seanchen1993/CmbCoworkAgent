# R01-A7 · 本地 App 模拟模型版审查

状态：accepted，代码0a711b31450d11f8e3bfa5d85689bced172ee502。最后旧数据升级库与最终launcher均已独立通过并精确清理。基线ebed5fd3，用户明确继续本地可操作开发版，并要求先模拟模型返回。

## 本轮交付边界

- 独立App开发页，负责人导入私有连接文件、明确工作区、创建/绑定单专家Group、显式授权与启用/停止本地节点；旧机器人不变。
- 回环HTTP轮询接现有Java单体和既有DeepAgent受限profile。只有模拟模型/零工具/Task文本与明确澄清，不读API密钥或仓库。
- 假招乎只响应结构化@，新任务和TASK编号澄清分开，明确分析才入队；离线等待指定节点，持久结果在重连后可见，不自动重跑unknown。
- 单独持久本地控制MySQL5.7项目，随机私有凭据/回环端口，start/status/stop，保留开发数据。JDK8/无FK，原三服务不改。

## 独立证据（不是子代理自测替代验收）

| 检查 | root实际结果 |
| --- | --- |
| App+JavaHTTP+MySQL+SQLite+既有DeepAgent | 97876/8cf87b通过；model1/tools0，真正等60s旧心跳过期后waiting_node、未领取取消、Task澄清/模拟结果、SQLite重开/结果持久、重连不重跑/currentGrantCAS；资源精确removed |
| 新内部HTTP | 39080/b3f7ac通过；25拒绝/人-node身份隔离/当前ACL/授权/poll8/并发开始与同结果结算/旧公共4方法；精确removed |
| App/旧受限引擎/Thread | 77206/edb343 71通过（新15+旧56）；固定IPC9通过；最终React+Chromium9294/606fc6操作通过，IPC明确为stub，不伪称完整native全栈 |
| 类型/构建 | 78530/8cdb64 main含全部新test及web diagnostics0；73093/6e1ea1 Electron-vite全build通过，原chunk warnings保留 |
| JDK8 | 22948/f11418 62JUnit/1884原parity零/class52/34libs/V1–V5字节保留；main up-to-date、test21实际重编，原主源码tree不变；jar294d21325a4110411ad9dd3eee009a182e4c0264747d09605ac122ca3a61a1c8 |
| 原契约/Node | F03 48313/761609完整24/漂移/生成类型消费通过；service Node7f6d99 55通过 |
| 原IM/入口 | 标准架构、window surface4、旧IM bridge16通过；原BuiltinRobotPanel/IM/schema/POM/migration和个人Runtime源码不变 |
| 本地持久launcher | 初次91869失败；PID退出复核修后95594/416997通过；最终默认probe重构后6233/f62bc7也通过六保留事实+真实Bot跨重启精确读回、精确removed；4确定性PID测试/最终service55通过 |
| 旧默认LocalHttpMain | 98338/45f824两库空库与实际V1旧数据升级全部通过，各30拒绝/4重放/2JVM并发/4回滚/commit后TCP0字节及重开原bytes，旧9表facts精确保留；首库13startup，24starts/sends、active0，均精确removed |

## 审查发现与处理

1. 首次“授权→启用”节点尚未登记：明确工作区且人点击授权时，用已核对nodeSession observe固定模拟能力一次，不auto-enable或execute。后续心跳/领取仍必须人启用节点；服务端60s宽限原样，文档说明。
2. PID可在kill0与ps之间退出：ps失败后仅确认ESRCH才作不存在，live/reused/EPERM仍失败；4确定性测试覆盖，原ownership/PIDstamp/portabsence不放宽。
3. 旧V5测试探针TABLES17但ORDER16、Node仍期待16：只修test-only结果表实际PK排序space_id,run_id与17表计数，并增加JUnit护栏；业务/schema/migration不改。失败库精确回收，不能将失败记录改为通过。

凭据main加密/0700+0600/无symlink；三identity核对，内部node身份只来自Session；固定IPC只可信主frame/页面，无任意proxy/URL/身份/prompt接口。单poll、独立heartbeat、generation fence、stop等图清理、SQLite原attempt去重与持久同结果重交。人写入先保存原command/version/deadline；跨期限未知写入保留人工核对限制，不自动盲重放。

真实招乎、真实模型、生产WSS/企业认证、附件源码/上传搜索、正式PRD审批阶段、长期记忆维护、云Runtime和完整unknown协调恢复均未交付。定时仍PAUSED，无push/deploy/intranet/paid/默认Docker/prune。默认持久Partner项目尚未启动；用户按local-partner-app.md明确CLI启动即可创建。

终末737424/4003f8：原3服务sameID/healthy、只有原3卷与dev私网，无测试或相关Java/Maven进程；oldlocal2f2c31 e54d3fb0clean。71c800实际PAUSED/defaultPartnernot-created；9c48e8最终55Node通过，diffcheck0。46允许源码文件正常localcommit bc326b/0a711b31；原14任务记录exact，所有句柄已闭合，child completed/no writer。仅存用户手动继续边界，不自动进入后续产品路线。
