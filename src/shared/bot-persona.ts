// Palette and shape identifiers extracted from the user-provided Grok Bot avatar editor.
// See renderer/components/bots/upstream/PROVENANCE.json for source and adaptations.
export const AVATAR_COLORS = [
  { id: "black", label: "Black", value: "#000" },
  { id: "brown", label: "Brown", value: "#936439" },
  { id: "red", label: "Red", value: "#FF263C" },
  { id: "orange", label: "Orange", value: "#FF6700" },
  { id: "yellow", label: "Yellow", value: "#FF9800" },
  { id: "green", label: "Green", value: "#00C972" },
  { id: "cyan", label: "Cyan", value: "#00BCA6" },
  { id: "blue", label: "Blue", value: "#1084FE" },
  { id: "violet", label: "Violet", value: "#9159FE" },
  { id: "magenta", label: "Magenta", value: "#FF309B" },
  { id: "gray", label: "Gray", value: "#777777" }
] as const

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=22691 (Ij character shapes; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=22691 (Ij character shapes; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)
export const AVATAR_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop"
] as const

export type BotAvatarShape = (typeof AVATAR_SHAPES)[number]
export type BotAvatarColor = (typeof AVATAR_COLORS)[number]["id"]
