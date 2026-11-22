import type { BotAvatarShape } from "../../../../shared/bots/contracts"
import circle from "./circle.svg?url"
import cloud from "./cloud.svg?url"
import squircle from "./squircle.svg?url"
import spark from "./spark.svg?url"
import clover from "./clover.svg?url"
import heart from "./heart.svg?url"
import flower from "./flower.svg?url"
import drop from "./drop.svg?url"
import pill from "./pill.svg?url"
import triangle from "./triangle.svg?url"
import house from "./house.svg?url"
import star from "./star.svg?url"
import hexagon from "./hexagon.svg?url"

// Static masks generated from the supplied Grok geometry; see the avatar vendor README.
export const botAvatarRings = {
  circle,
  cloud,
  squircle,
  spark,
  clover,
  heart,
  flower,
  drop,
  pill,
  triangle,
  house,
  star,
  hexagon
} satisfies Record<BotAvatarShape, string>
