# Destination alias 检查的独立 SQL callee 修复

本稿只申请一个独立功能修复窗口，不实施 Shared Manager 邻接 DATA 去重，不增加 SQL reader
provenance 资格，不声称默认 5 秒性能通过。当前 Manager postflight 整体仍 BLOCK。Root 是
唯一实际测试 / Node probe runner；Root DESIGN1 与 Latest 独立 DESIGN2 已齐。

Root 实际 Node 22 probe 已记录
`output/stage23-native-destination-glob-probe-current.log`：旧 GLOB callback 2，实际 UPDATE
mutation 1；新候选 callback / mutation 0，fresh late collision 1。另
`output/stage23-native-destination-alias-golden-current.log` 的 36 项 golden 全通过、schema
name string 门成立；TEMP 同名普通表使 prepare 精确抛 `not a function`，恢复后仍是真
schema。此实际证据只属于 predicate 小窗，不给 whole SQL reader / Manager 资格。

## 当前实际入口与修复范围

`src/main/db/function-conversation-native-destination.ts` 的私 `destinationSnapshot()` 在原
完整 JOIN 中以 `count(*) / name GLOB '<prefix>*'` 检查映射表 schema 列名是否与合成 alias
前缀碰撞。消费只接受 `row[alias_collisions] === 0`，没有消费正数的具体数值。

SQLite [原函数文档](https://sqlite.org/lang_corefunc.html) 说明覆盖 glob 会改变 GLOB operator。
当前原实际 native 对象支持 `native.function()`，Source 回调能在同连接注册 JS glob；同一个
已 prepare 的 Statement 后续 get 仍可能进入该 JS。因此原 alias SQL 是实际可替 callee，
不能只以原 Statement/get 地址相同声称 DATA callback-free。Root 将运行的最小 counter /
UPDATE 复现已保存到 `output/stage23-native-destination-glob-probe-plan.md`，Legacy 未运行。

仅两个文件可编辑：

- `src/main/db/function-conversation-native-destination.ts`：原 prefix 选取保留，私构造固定
  prefix 的 upper，然后只替换该合成 alias scalar 的 SQL 表达式。
- `src/main/db/function-conversation-native-destination.test.ts`：复用已有实际 open factory /
  Store / physical thread / child / 原 Source fixture，添加针对回归。既有 32 定义全保。

Adapter / Manager / Restore / Producer / Family / Registry / SQL API / Scope / 创建和 cleanup
不改。不修改未知 DB wrapper 的行为，不赋予真实 Destination 私表新的执行资格。

## 精确谓词与适用域

原 prefix 为固定 ASCII `__cmb_native_destination_`，存在初始列名碰撞时每次追加 `x_`。
它没有 GLOB wildcard 元字符，最后字符总是 `_`。设 lower 为该原 prefix，upper 为保留前面
所有字节并只把最后 `_` (0x5f) 替成反引号 (0x60)。upper 用私局部同序字符索引构造，
不添加晚 Array / String 原型遍历入口，不接收 caller prefix，也不更改原 prefix 选择。

替换表达式：

```sql
EXISTS(SELECT 1 FROM pragma_table_info('function_conversation_native_destinations')
  WHERE name COLLATE BINARY >= '<fixed lower>'
    AND name COLLATE BINARY < '<fixed upper>')
  AS "<same prefix>alias_collisions"
```

这是当前固定前缀的 BINARY 半开范围。lower 自身与所有其后缀包含；upper 自身、比 lower
短、大小写不同或首不同字符不包含。Unicode / 引号 / 星号 / 方括号仅作为 schema 名称
后缀时仍按原 prefix* 判为碰撞。显式 BINARY 不依赖 NOCASE 等 schema collation。
SQLite 的 [比较规则](https://sqlite.org/datatype3.html#collation) 支持此当前 ASCII 域的推导；
逐项真实 golden 仍是实施验收要求。

EXISTS 的原 SQL 整数 0/1 对应无碰撞 / 至少一个碰撞。消费保原严格 `=== 0`，原 count 的
任何正数与新 1 都拒。SQL 不再调用 GLOB / glob / COUNT，不用替代的 typeof / substr /
length / like / instr SQL helper。CAST 类型加强候选不在本窗口内。

保留同一个 fresh JOIN、全部 `m.*`、四 thread / 两 ref 的完整原字段、所有 JOIN / WHERE /
原参数值与顺序、缺行拒绝、当前 invocation / metadata / incarnation 校验、完整原 Source
次数和检查位置。初始 mappingKeys 与 prefix 回避仍原算法；晚 ALTER TABLE 加 prefix 列
时仍拒，不借前一个 SQL/schema snapshot 或另一个连接。

真实 built-in `pragma_table_info` 的 name 是 normal column 名称，本窗口保原 table_info
范围，不改 table_xinfo。引用 [原 PRAGMA 文档](https://sqlite.org/pragma.html#pragma_table_info)
只说明此实际 schema 数据域，不把未知同名表值来源或非文本值当已认证。Root Node 22 probe
须先核实际 PRAGMA name 的 JS string 类型以及 TEMP `pragma_table_info` 普通表的解析行为。
若同名表能让 table-valued 调用返回影子数据，需明确其原有异常或另行封来源；不能以
shadow 返回 0 给新 qualified 路径授纯性。真实原 factory 未开启 native extension；本稿不
把原 BINARY 名字外推为任意 custom native / extension 都无 callback。

## 真实回归计划

现两文件已原子冻结，新增 8 个定义，连同既有 32 定义为 40；shadow 按 Root 已实际确认的
`not a function` 精确错误断言，不 fallback 0。Legacy 没有运行任何 CPU / 测试 / 类型门，
Root 已实际运行 40 Destination + 66 DataScope + 20 Restore，126/126 通过，34.23 秒。
日志 `output/stage23-native-destination-alias-scope-restore-current.log`。这仅为此实际功能门，
不是 schema/SQL 执行来源资格扩张，也不是原默认五秒性能通过。

1. 真 fixture 首建 / 读完整 Destination 后，在其原 Source FULL 中注册 glob 和 count JS
   回调；各回调若被调用会尝试实际 mapping SQL mutation。真实 assertCurrent / 独立 DATA
   成功、callee 0、原 Source 次数保持；随后同 Source 真修改 metadata_digest 后严格拒绝，
   不能把注册函数存在误当撤权或绕过 fresh 数据。
2. 单一 golden 定义在真正 native、注册任何覆盖前对照原 builtin GLOB 与新范围的逐项
   0/nonzero：ordinary、lower、lower+ASCII/Unicode/引号/星号/方括号、少末字符、upper、
   大写 prefix。对原 prefix 与追加 x_ 的 prefix 各跑，原 PRAGMA name strict string 保留。
3. 真 fixture 初始增加非 prefix 的 Unicode / quoted / wildcard 后缀列名；Destination 的
   完整额外 m.* 数据保持可用，实际改变该原额外字段仍拒。不是只测 SQL synthetic 值。
4. 真 fixture 初始已存在 prefix 列且下一 x_ prefix 也有列，仍按原算法顺延；新 Destination
   full/data 成功，末独立修改原额外 mapping 字段拒，保初始 prefix 回避语义。
5. 三个晚 ALTER 定义分别增加 lower 自身、lower+Unicode、lower+quoted/wildcard 字符的
   normal 列。在原 Source 返回后复用 captured JOIN，FULL 与独立 DATA 都拒，getter /
   SQL function callback 0。现有晚 alias 和全部原关系 / inc / close 回归保留。
6. 真实同 native TEMP 表 shadow 定义严格断言完整 Destination 以 `not a function` 拒绝，
   不能吞成 0；恢复 TEMP 表后完整 fresh 原 schema 数据仍可核验，不以 broad throw /
   matcher 隐藏解析错误。

所有测试使用原原生 SQL 和实际 fixture Source，不假造 dataChecker、权限、Producer 或
native reader。SQL 函数测试只读固定 counter，原真 SQL mutation / Store/raw/source 完整
断言保；关闭和资源 cleanup 仍原 fixture 顺序。Root 独占 CPU，先真实 probe、窄 32+新增，
再 current 类型 / Worker build / 相关 DataScope 门；旧失败日志保留。

此票只关闭 alias SQL 的已知可替函数 callee，不把它等同完整 qualified reader 来源、
不消除所有 SQLite / JS 可能入口，也不授权删 Manager 最后一 DATA。后继 native SQL
provenance 小窗须独立精确 API / 两设计票 / 两源码票 / 真实门。

Legacy 本窗自检 SOURCE1：upper 只保留原 prefix 前全部字符并补固定反引号；唯一 SQL
差异为该 alias scalar；read 当前 4 个 prepared statements、Source FULL、dataScope /
current publication、线程/ref/mapping/metadata/inc 字段与所有消费检查均保原。新真实函数
注册与晚 ALTER 门同时断言 SQL callee 0，schema shadow 恢复遵循原泛型 SQL-error 可 fresh
重读合同，没有新增 sticky。`git diff --check` 0；独立 Root / Latest scoped SOURCE2 已
通过，真实 126 项结果如上，原 probe 与本功能门分别留证，不外推 whole SQL 纯性。
