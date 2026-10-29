/** Behavioral acceptance contracts, not generated source or a substitute for the author model. */
export const genericCompositionNames = {
  provider: "text-normalizer",
  consumer: "text-quality-review",
  command: "review-text"
} as const

export const genericProviderPrompt = `请通过创造者的正式工具创建一个独立可安装 Mod，名字为 text-normalizer。
用途是通用文本规范化，不依赖任何项目流程或业务插件。
通过 on.capability 声明 devclaw.capability/v1 公共能力，id=text-normalization，version=1.0.0，scope=conversation。
声明 action normalize，输入对象 {text:string}，输出对象 {text:string, revision:string}。
行为：去除首尾空白，将所有连续空白（包括换行）折叠成一个空格，输出 revision="v1"。
采用 SDK 公共 capability 注册，不使用宿主私有接口、文件、网络、进程或模型。
请使用工具完成源码创建、编译和测试，准备供用户确认安装。不要只返回示例代码。
此 Mod 不需要执行任何特定项目阶段。`

export const genericConsumerPrompt = `请通过创造者的正式工具创建另一个独立可安装 Mod，名字为 text-quality-review。
已有另一个独立 Mod text-normalizer，通过 on.capability 暴露 text-normalization@1.0.0 的 normalize action。
请通过 $.platform.act 调用这个公共能力，ref.provider="text-normalizer"、ref.id="text-normalization"、ref.version="1.0.0"，target.kind="current"。
注册立即命令 review-text，命令参数为文本。每次调用使用不同的 requestKey；以调用的返回状态为准，只有 succeeded 才可读取 value。
禁止在消费方重复实现规范化算法或使用固定结果冒充调用成功。
收到规范化后的 text 后检查字符长度至少 8。命令 text 返回 JSON 字符串：{text,revision,passed,reason}。
passed 是布尔值。有效文本 reason="ok"，过短 reason="too-short"。
能力不可用或调用失败时应明确失败，不得把原始文本或缓存成功结果当成通过。
不使用私有宿主接口、文件、网络、进程或模型，不依赖任何项目业务。
请使用工具完成源码创建、编译和测试，准备供用户确认安装。不要只返回示例代码。`

export const genericProviderRevisionPrompt = `请修改刚才创建的 text-normalizer Mod。
保持 text-normalization@1.0.0 公共能力、normalize action 和输入输出契约不变。
规范化仍去首尾空白并折叠连续空白，新增将文本转换为小写，输出 revision="v2"。
请通过正式工具修改、编译和测试，准备供用户确认更新。不要修改 text-quality-review，不能修改主程序。`
