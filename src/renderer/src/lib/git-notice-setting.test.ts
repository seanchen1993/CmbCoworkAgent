import { expect, it } from "vitest"
import { gitNoticeSettingPatch } from "./git-notice-setting"

it("uses the actual saved value and refuses older ACKs after a newer SDK broadcast", () => {
  const initial = { gitChangeNoticeRevision: -1, gitChangeNoticePendingByThread: { thread: true } }
  const first = gitNoticeSettingPatch(initial, { value: false, revision: "1" })
  expect(first).toEqual({
    gitChangeNoticeEnabled: false,
    gitChangeNoticeRevision: 1,
    gitChangeNoticePendingByThread: {}
  })
  const later = {
    ...initial,
    ...first,
    ...gitNoticeSettingPatch({ ...initial, ...first }, { value: true, revision: "3" })
  }
  expect(gitNoticeSettingPatch(later, { value: false, revision: "2" })).toEqual({})
  expect(gitNoticeSettingPatch(later, { value: true, revision: "3" })).toEqual({
    gitChangeNoticeEnabled: true,
    gitChangeNoticeRevision: 3
  })
  for (const invalid of [
    null,
    {},
    { value: "false", revision: "4" },
    { value: false, revision: "-1" },
    { value: false, revision: "9007199254740992" }
  ])
    expect(gitNoticeSettingPatch(later, invalid)).toEqual({})
})
