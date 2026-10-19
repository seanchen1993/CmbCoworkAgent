import { BOT_AVATAR_SHAPES, type BotAvatarShape } from "./contracts"

export const BOT_COLORS = [
  ["#242424", "黑色"],
  ["#936439", "棕色"],
  ["#ff263c", "红色"],
  ["#ff6700", "橙色"],
  ["#ff9800", "黄色"],
  ["#00c972", "绿色"],
  ["#00bca6", "青色"],
  ["#1084fe", "蓝色"],
  ["#9159fe", "紫罗兰色"],
  ["#ff309b", "品红色"],
  ["#777777", "灰色"]
] as const

/** Both creation paths generate once, then persist in the existing Bot profile. */
export function createBotAppearance(): { color: string; shape: BotAvatarShape } {
  const choices = crypto.getRandomValues(new Uint32Array(2))
  return {
    color: BOT_COLORS[choices[0] % BOT_COLORS.length][0],
    shape: BOT_AVATAR_SHAPES[choices[1] % BOT_AVATAR_SHAPES.length]
  }
}
