export interface UiGuideConfig {
  guideId: string
  revision: number
  maxShowCount: number
}

export interface UiGuideState {
  shownCount: number
  acknowledged: boolean
  shouldShow: boolean
}
