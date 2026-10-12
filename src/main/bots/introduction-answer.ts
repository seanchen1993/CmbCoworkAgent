import { BotModelAnswerProjection } from "./model-answer-projection"

/** Preserve the bounded greeting contract while sharing the task projection. */
export class BotIntroductionAnswer extends BotModelAnswerProjection {
  constructor() {
    super({
      providerCharacters: 128_000,
      answerCharacters: 16_000,
      errorPrefix: "introduction",
      label: "Bot 介绍",
      reasoningLabel: "模型介绍",
      mode: "strict"
    })
  }
}
