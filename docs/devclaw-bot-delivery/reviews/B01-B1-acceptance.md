# B01-B1 主代理独立验收

2026-10-06 · accepted、正常合入并完成集成树真实编译/数据库复验

## 集成复验结果（最终状态）

正常merge `70f5aed6a5c19f4cde10e70c8db037d4e8d42a70`，与冻结1ba0be91除主代理协调文档外代码字节相同（0d9bf0 exit0），无冲突/reset。集成Node7af37d exit0 20/20；F0398324最终c5e18c exit0 原24/24＋checks/types。

集成完整build **2232最终908b02 exit0**：实际Corretto8 javac **重新编译9main/5test**，20JUnit零fail/error/skip，1107同轮 `0b1cf44e-aa02-4779-98d2-0df3772a737b` 326valid/781invalid/0mismatch，36自有class52/34运行库、原Schema/manifest/V1/log exact及打包probe通过。新jar `edcf2fe35edbf8131559d5bda4adc2e4a6e660396a4a9207a8a4050d0a930ae4`；dependency tree仍 `c6eeac9cad3a0209dc4ef80d5b0a1e33ca638dbe4f0e1b49f2018020a38317f6`。

使用**该新编译产物**再次运行完整数据库入口 **27253最终44ae19 exit0**，两个顺序真实MySQL5.7库全suite/每库5history/SQLTimeout1030与1012ms/精确finally均通过：

- `devclaw-bot-test-6bd9921ad9695dc4` / `05eb2d51d0a72e3c222a58e808d53af91f496b3074eb7501f4b93361b2cd3ebf` / 12732891。
- `devclaw-bot-test-3e5b6ae46adbb51c` / `d960e002f9745dbcd8811d146facaa7f73f7c9760db110928021f5bbea1c254b` / 12732892。

随后555ccb只原三dev同ID/回环端口healthy、b9bbc0仅原三卷、d7d31c仅原网络、de92e1 integration clean；没有额外资源/数据/权限变更。B1所有required work已完成，C1可ready，但只有正式派单后才实施；自动触发仍停用。

## 接受范围

接受代码 `d15268f66c0308bff7d2f154bb02ab20fa320cfa`，报告-only HEAD `1ba0be9172eef2cb8d27ad6196bd181a1d46649a`。原实施者 `/root/b01_contracts_high`（gpt-6.1-sol/high，B01-A02）已completed、停写、工作树clean；无新增代理或并行写者。

本片只交付九表存储、固定迁移、本地封闭数据库连接/readiness、真实JDBC验收和任务资源编排。**不包含六接口业务、HTTP、身份服务、Runtime或UI。** 无物理外键；关联完整性由下一应用事务切片承担，不能把裸SQL结构探针当成业务关系拒绝。

新隔离空测试库的应用账号具 `ALL PRIVILEGES ON devclaw.*`，无GRANT OPTION、全局或其他schema权限。原开发三服务、数据、六项原权限未改变，不读已有root秘密、不用root连接JDBC。后续接入原开发库是独立受控步骤，不能声称已经可serve。

## 实际代码检查

主代理已逐项读取相对A2b接受点的21个允许实施文件，最终6个生产类再读412c0c；范围清单b500a5。冻结Schema/OpenAPI/state、原TS/DTO生成器、src、B00/F05和锁文件未改（396ec2）。code..report-only除本人A02无diff（064c00，最终c3bd82）。worker最终6723d0/e008d5确认clean及准确HEAD。

- 空间限定ASCII二进制PK/unique/关联索引、稳定ordinal；零FK/无假CHECK；MEDIUMBLOB原JSON字节与ASCII-escaped名称覆盖原协议允许的Unicode/NUL/孤立surrogate。
- 封闭local-dev输入，无任意JDBC URL、环境扫描、远程主机或root回退。metadata/实际归属/当前ready在秘密读取和发送前核验；取消前检查与finally职责分离。
- 固定Flyway Community core7.15.0/固定迁移位置及history；禁clean/repair/baseline/createSchemas，先校验，严格拒绝非V1/失败/checksum变化。仅本地开发兼容基线，不是当前维护或生产安全认证。
- history负例只test-main固定五fixture显式commit；调用真实固定runner，验证mutated十列事实未被改变，再用已知原单V1行准确tear-down并核对十列/ready。无生产table selector/repair，失败不会因恢复ready被掩盖。
- 资源adapter只处理本进程新登记的随机测试项目，不收养未知/原dev；精确身份/标签/路径/inode/私有mode。初始化root仅生成写入供官方容器入口，不读取已有root或连接root；应用密码仅stdin。
- R1取消前秘密发送、R2真实ready与清理投影分离、合法文本真实往返、迁移资源打包审计均已由实际独立测试关闭。后续业务关系责任不在本片伪造通过。

## 主代理独立执行（不是child自测）

命令均使用Node `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`，cwd为冻结实施树 `/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`。

| 命令 | 实际结果 |
| --- | --- |
| `--test tests/bot/service/*.spec.mjs` | e35ca8，exit0，20/20，零失败/skip |
| `tests/bot/check-contracts.mjs` | session69528，最终219283 exit0，原24/24、漂移检查及生成类型消费 |
| `deploy/dev/service/build.mjs` | session28320，最终4135ef exit0，真实Corretto1.8.0_482/Maven3.9.6，20JUnit，0fail/error/skip |
| 同轮Java/Ajv parity | 1107，326valid/781invalid，0mismatch；run `21264c24-e575-435f-bdd5-a442bd1fd67f` |
| fatjar审计 | 36自有class major52、34实际运行库；原三Schema/manifest/V1/log字节一致；实际打包probe通过 |
| `deploy/dev/service/database-check.mjs` | session3051，最终a81b6a exit0，两个顺序真实空MySQL5.7，完整suite及精确finally回收 |
| `deploy/dev/service/database-lifecycle.mjs` | session75260，最终100a80 exit0，故障与两个真实SIGTERM，各child exit1、JDBC starts0、秘密stdin0、父进程实际确认资源/目录不存在 |

本轮builder实际重跑测试、parity、打包与审计，但复用worker已编classes；**不冒充新编译**。接受合入后必须在集成树编译新增main9/test5源码并复验。

实际jar SHA256 `6a69e1ec03475b68caebb28497192241c23efaccbd7727d70ec6376e52dbbc0c`；dependency tree `c6eeac9cad3a0209dc4ef80d5b0a1e33ca638dbe4f0e1b49f2018020a38317f6`；V1 `6c9a109af0b0ef4d6c5b260672379190beb00bcc6c9137a8377bbecb363f276f`。

## 真实数据库与清理身份

两库：

- `devclaw-bot-test-a35000e6d308d005`；container `f87909be800e200fd90ffd25371d8b4a84683a878bf68214e14e783bf3dc425e`；12732888；SQLTimeoutException1033ms。
- `devclaw-bot-test-f185b17b5db9f1b7`；container `a756db6dd692db4a4cc2526bef9f0ea6d3e823f306cdb60bef565c688489db8b`；12732889；SQLTimeoutException1027ms。

每库：empty-readiness拒绝、首次migration1/no-op0、十表全部列/22索引/零FK、合法名称/config/receipt字节/UTC/稳定数组重开往返、五种损坏history拒绝且不变、schema-ALL限定和三个跨库/global拒绝、坏密码/停止/过时端口、实际query deadline全部通过。两个项目均finally精确removed，未修改原dev。

生命周期三个项目：

- 注入故障 `ea703c4ecebd21af` / `aed61cb65ef208bb52794a68a1e49cbb9e8b45deab9aa97643bea069114247cb` / portnull。
- 未ready真实SIGTERM `51dfe5fb05a1cea9` / `32a8b934930d4f99e5c0796ec70d9d495855885f628db45cf94e9589870dfdc3` / portnull。
- 秘密发送前真实SIGTERM `3a9fe4cc9d525b5c` / `cf5e16efcab5f94967fc917e11b6ef2439ceb609e8b5c5d45b8f5ad760b1f050` / 12732890。

最后主代理只读audit：e9663c仅原MySQL/ES/S3同完整ID、12732878/32877/32876且healthy；0bc96e仅原network `2e882b136c9a52cf97388b4945df6ae1f5dc195d3ed52c0dba7697cfaad7100d`；6420c2仅三原dev卷；3ceab3 runtime仅dev；1626ce无测试/build进程。所有主代理与worker句柄闭合。SIGKILL/宿主掉电不能承诺finally，未知残留不自动收养或重放。

## 历史失败与下一动作

保留FK1142及被拒绝权限提议、Flyway8商业门槛、7.15 getter编译错误、history事务假设失败的真实记录；均不是接受轮通过。修正由主代理窄任务决定、原high child实施，无付费/许可证绕过/数据库升级/reset。

下一正常merge上述冻结报告HEAD，核对除协调文档外字节相同，集成树实际编译复验并记录SHA。之后才将B01-C1任务改ready、给同原high写者正式派单。定时自动续跑持续PAUSED，不扩大B01范围。
