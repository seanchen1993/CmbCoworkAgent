import { useEffect, useMemo, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import { loadBotEmojiCatalog, searchBotEmoji } from "./bot-emoji-catalog"
import type { BotEmojiCatalog } from "./bot-emoji-catalog"

/** This module and its full catalog are imported only when the user chooses More. */
export default function BotEmojiPicker({
  selected,
  disabled,
  onSelect
}: {
  selected: ReadonlySet<string>
  disabled: boolean
  onSelect(emoji: string): void
}) {
  const [catalog, setCatalog] = useState<BotEmojiCatalog | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState("")
  const [group, setGroup] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void loadBotEmojiCatalog()
      .then((value) => {
        if (active) setCatalog(value)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [attempt])
  const entries = useMemo(() => {
    if (!catalog) return []
    return query.trim()
      ? searchBotEmoji(catalog.entries, query)
      : catalog.entries.filter((entry) => group === null || entry.group === group)
  }, [catalog, query, group])
  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(entries.length / 8) }, (_, index) =>
        entries.slice(index * 8, index * 8 + 8)
      ),
    [entries]
  )
  if (error)
    return (
      <div role="alert">
        表情暂时无法加载。
        <button
          type="button"
          onClick={() => {
            setError(false)
            setAttempt((value) => value + 1)
          }}
        >
          重试
        </button>
      </div>
    )
  return (
    <div style={{ width: 288, maxWidth: "calc(100vw - 40px)" }}>
      <input
        aria-label="搜索全部表情"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索表情（名称或 :shortcode:）"
        className="mb-2 w-full rounded border bg-transparent px-2 py-1 text-sm"
      />
      {!catalog ? (
        <p role="status">正在加载表情…</p>
      ) : (
        <>
          <select
            aria-label="表情分类"
            value={group ?? "all"}
            onChange={(event) =>
              setGroup(event.target.value === "all" ? null : Number(event.target.value))
            }
            className="mb-2 w-full rounded border bg-popover text-sm"
          >
            <option value="all">全部表情</option>
            {catalog.groups.map((item) => (
              <option key={item.order} value={item.order}>
                {item.message}
              </option>
            ))}
          </select>
          <div aria-label="全部表情" role="group">
            <Virtuoso
              key={`${group}:${query}`}
              style={{ height: 224 }}
              data={rows}
              itemContent={(_, row) => (
                <div
                  className="grid grid-cols-8"
                  style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", height: 36 }}
                >
                  {row.map((item) => (
                    <button
                      key={item.native}
                      type="button"
                      disabled={disabled}
                      aria-label={item.label}
                      title={item.label}
                      aria-pressed={selected.has(item.native)}
                      onClick={() => onSelect(item.native)}
                      className="rounded text-xl hover:bg-accent focus-visible:outline focus-visible:outline-2 aria-pressed:bg-accent disabled:opacity-50"
                    >
                      {item.native}
                    </button>
                  ))}
                </div>
              )}
            />
          </div>
          {!entries.length && <p role="status">没有匹配的表情</p>}
          <p className="mt-1 text-[10px] text-muted-foreground">
            Emoji data:{" "}
            <a
              href={new URL("../../assets/emoji/LICENSE-MIT.txt", import.meta.url).href}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              emojibase (MIT)
            </a>{" "}
            ·{" "}
            <a
              href={new URL("../../assets/emoji/LICENSE-UNICODE.txt", import.meta.url).href}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Unicode
            </a>
          </p>
        </>
      )}
    </div>
  )
}
