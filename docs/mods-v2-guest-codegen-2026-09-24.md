# Guest 字符串代码生成限制

固定官方 Claude Code v2.1.278 声明要求 hooks 与 Client 中的 eval / new Function 对字符串抛错。此前本工程 QuickJS 没有 Node/DOM，但仍可执行这些字符串；两者不是同一个约束。本次在任意插件代码及注册执行前安装 guest 内限制，宿主修订为 guest-codegen-boundary-v63，批准摘要随运行时契约变化，旧批准需要按原流程重新确认。

直接/间接 eval、Function、对象或函数 constructor 链、普通/生成器/原生 async/async-generator 函数原型的 constructor、Reflect.construct 和绑定调用都不能生成代码。全局和原型绑定使用不可配置 getter；真实重新定义/赋值/删除测试验证了限制。正常声明函数、生成器、正则匹配、Promise 和原宿主 SDK 调用仍使用原执行链。

限制脚本在宿主评估的独立字符串中保留原生 async/generator 语法，不能经过 ES2016 降级后再查找原型。QuickJS 的 Eval intrinsic 保留：实际实验发现关闭它会连宿主 bootstrap / invoke 的 evalCode 一起禁止。宿主仍只评估受控 bootstrap、批准的初始模块及原 JSON 编码调用表达式；没有新增让插件执行任意源码的宿主接口。共享依赖没有修改。

错误使用 TypeError / MODS_CODE_GENERATION_DENIED，列为 adapted 行为；这不是完整 JavaScript 全局环境或所有上游错误细节的兼容声明，也不是逃逸漏洞审计结论。WebAssembly、Node、DOM、ambient timers 的已有缺省限制仍保留。应用主进程和 renderer 的 JavaScript 环境、旧 Mods 执行器不修改。

取消、撤权、运行时替换与关闭继续走原 authority/session 生命周期；代码生成限制不增加权限、不提供检查 PASS 或 checkpoint 推进能力。依赖动态字符串生成的 Function Mods 需改用已批准模块中的普通函数。
