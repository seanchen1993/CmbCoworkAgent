# R01-A9 root 检查点

2026-10-15，root串行实施。Astra设计已完成并采纳，见review。正确集成树/分支，原dirty全部保留，定时PAUSED。

## 初步源码（尚未验收）

- V7专家三表/显式采用表/Run scope，无旧资料复制；复用有界Memory值校验、收据和snapshot表，旧wire保持。
- 专家maintainer手工记忆CRUD；采用需Group admin+Bot maintainer+当前绑定/版本；新enqueue固定scope。
- App专家DTO/校验、客户端、controller新建/显式启用/采用/维护；默认私有数据目录+有界JSON可重建缓存，旧手选路径保留；仅服务端start快照进prompt。
- 页面收拢三块，Group/原始ID/旧记忆只在高级兼容；关键词检索、不自动提炼。

## 已执行

首JDK8构建85188/446b07 exit0，实际50main/23test新编、原67JUnit与1884parity零、V7产物字节审计通过，jar52eb49da。这只是既有单元与编译，不是新功能验收。首main tsc报两处unused import已修；web检查38904仍须取回结果。初版React替换一次patch因同文件delete/add冲突未应用，已用两次patch完成，未丢文件。

## 待做

新增专家/目录/创建链/IPC/UI测试、真MySQL专家权限/scope/Run闭环与V6升级，旧V5升级probe需保留历史fixture而不能用新RunStore访问旧schema。核对当前Runtime未动；实际App83014/Java28281仍旧产物，不能说用户已看到新版。新编测试后才重启，先确认无在途任务。旧启动脚本Ctrl+C/相对路径问题仍独立保留。

## 后续检查点（优先于上段历史待做）

- CUA确认原App83014未选工作区/无专家/节点未启用/无Run，57770/d228a1用明确stop入口正常关闭App+Java+Partner数据库，配置/卷保留。原B00 MySQL693a1c3实际OOM137停止，自14日00:13UTC；Node25元数据检查先B00_PLATFORM拒绝无副作用，改用Node22核对同owner/卷后2ff103仅start同容器用于旧资源守卫，验证后须恢复原停止状态。
- V5升级fixture已改为test-only历史SQL行seed，不用当前V7 Store访问旧schema；保留原事实哈希、历史null/旧结果检查，V7新增列不进入原V5字节哈希。V6真实queued/running/finished及记忆/snapshot原值保留、默认group/no promotion已验证。
- 新专家HTTP19314/e88388 exit0，真实MySQL/Java V6升级、同专家跨采用Group共享/不同专家、11拒绝/手工来源闭合/CAS并发/原命令重放/Run scope固定/两种独立失效/停用/真实Java重开与历史重交；项目d32becd00c5436a3精确回收，原资源proof一致。
- 新完整App执行5383/d1ef57 exit0：JavaHTTP+MySQL+AppControllerWorker+默认真实私有目录+JSON缓存+SQLite+既有DeepAgent fake4/tools0，两个任务复用、在途停用失败/noAutoReplay、后续空快照、新SQLite保持MySQL记忆/历史。bfb793614bf7e371精确回收。
- 76App51595/fca716、12IPC54080/cc3022、main69449/web31379类型零；React Chromium7821/fba509通过新三块/无选目录/启用确认可取消/关键词检索编辑停用/离线缓存不显示。首次bot prompt断言被引擎JSON再转义导致单项测试失败，修为解转义后验证scope，47817/92bcf5共29全部过；不是产品scope失败。
- SQLite旧receipt指纹兼容已补：显式group省略新增字段保持旧哈希，bot写入指纹；新单测证明旧结果不重跑且跨scope拒绝。
- Astra二次只读指出getBot本身maintainer-only。已改私有overview返回adopted/botName/canManage且当前Group admin/绑定核对，不扩公共getBot；App刷新不调用getBot，记忆维护失败单独清除正文、继续独立Run读取。新增非maintainer连接/启用与页面维权变化结果刷新用例，最终复验待取。当前jar70a7db89为69JUnit/1884parity编译通过，catalog测试适配新4表/列/第7history后还需最终编译。

## 收尾复验

- 13783/ad6c85与最终77505/82c461 JDK8真实新编50main/24test、69JUnit/1884parity0；最终jar9be0762b0d1b2d891c117ace30c84f996dee3a58ba9026ccdf6da386d7d30dee，七迁移字节/34库/class52审计通过。DatabaseCommand版本已改7。
- 19058/bf1feb 主项目+全部新增测试类型0；web最终25140待取。采用操作已改为单一controller串行区间，避免版本启用与scope采用之间被并发绑定换目标。34995/63c68f新旧记忆/目录/执行36测试通过。
- 16098/2cc902真实ReactChromium含维护权限丢失后继续显示获授权结果通过；55718/940905服务65单测；45324 IPC12通过但随后Node25契约入口被平台guard拒绝，改正确Node22后2665/82be98 F03全24/drift/生成类型通过，无契约改动。
- 80185/63c090旧Group真实两库全部通过：V5升级42拒绝/空库41拒绝，来源/CAS/同Bot不同组隔离/完整回滚/未知提交重放/固定快照/在途失效容量/策略disabled/过期unknown/预算100-10/重启；测试项目94ea69dd9d911fee、2c29446b60e1b771精确回收。
- 44644/24273c新版专家最终HTTP在fixed-run-scopes断言失败（未输出细分原因），e42d1c1690dd06b6精确回收，原资源proof不变；不当作通过。已把该阶段细分为旧Run启动/新scope/快照/CAS/重复/renew等固定标签，22102重验中；若复现据具体阶段定位，不通过降低断言或重跑掩盖。

## 验收出口

- 最终测试以 reviews/R01-A9-acceptance.md 为准：专家HTTP两次最终通过（22102/2719cd、2652/23aa45），实际跨层闭环46530/fdc843、数据库目录51420/df1d47、旧Group80185/63c090、App76/IPC12/服务65/F03全24及主端和Web类型检查均完成。此前44644单次原因未明的失败保留，不宣称已定位。
- 新版实际App已完成安全构建并打开：监督命令67009保持运行，App92595，Java92534，回环端口53883，jar9be0762b0d1b2d891c117ace30c84f996dee3a58ba9026ccdf6da386d7d30dee。2f946b确认运行与数据库健康，CUA核对实际页面为“我的专家 / 本地状态 / 任务”，高级设置折叠；尚未创建用户专家/Run，节点未启用。
- 7bab44确认一次性测试资源均已精确回收，Partner数据库同容器/卷保留并运行；临时启动的原B00 MySQL已恢复原停止状态（46072/edef40），ES/S3未改。自动续跑仍PAUSED。所有代码和用户既有改动保留未提交，不自动扩展后续路线；等待用户测试。
- 5600bd：最终JSON可解析、原16任务逐对象与HEAD不变、diff空白检查通过。对42个modified/untracked非docs文件另给可复算清单摘要：路径字典序，每行“文件SHA256＋两个空格＋相对路径＋LF”，清单UTF8的SHA256为b32a6dd3031ff3fa9b1a367b4a4adee3a3c49abe3d3857fcd3f27e5bc2f1c7dc；state单独标明canonical_manifest_format，避免与先前不同摘要格式混用。
