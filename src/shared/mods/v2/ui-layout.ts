/** Bounded presentation values shared by validation and the desktop renderer. */
export const FUNCTION_UI_SPACE_PIXELS = { xs: 2, sm: 4, md: 8, lg: 12, xl: 16 } as const
export const FUNCTION_UI_TEXT_PIXELS = {
  caption: 10,
  footnote: 12,
  body: 14,
  heading: 16,
  title: 20
} as const
export const FUNCTION_UI_TEXT_WEIGHTS = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700
} as const
export const FUNCTION_UI_SPACE_PROPERTIES = [
  "gap",
  "rowGap",
  "columnGap",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "margin",
  "marginX",
  "marginY",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight"
] as const
