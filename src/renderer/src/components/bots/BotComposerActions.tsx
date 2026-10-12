import * as Menu from "@radix-ui/react-dropdown-menu"
import { useRef } from "react"
import { ChevronRight, Circle, Loader2, Paperclip, Plus, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BotAvatar } from "./BotAvatar"
import type { CoworkBot } from "../../../../shared/bot-types"

/** One input-actions menu over the original attachment and Teach owners. */
export function BotComposerActions({
  disabled,
  uploading,
  group,
  members,
  teachAvailable,
  attach,
  selectSkills,
  teach
}: {
  disabled: boolean
  uploading: boolean
  group: boolean
  members: CoworkBot[]
  teachAvailable: boolean
  attach(): void
  selectSkills?(): void
  teach?(botId: string): void
}) {
  const skillHandoff = useRef(false)
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="bot-attachment-button"
          aria-label="输入操作"
          title="添加附件或选择输入操作"
          disabled={disabled}
        >
          {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={20} />}
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="bot-more-menu"
          side="top"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={(event) => {
            if (skillHandoff.current) {
              event.preventDefault()
              skillHandoff.current = false
            }
          }}
        >
          <Menu.Item disabled={disabled || uploading} onSelect={attach}>
            <Paperclip size={15} />
            添加附件
          </Menu.Item>
          {selectSkills && (
            <Menu.Item
              disabled={disabled}
              onSelect={() => {
                skillHandoff.current = true
                selectSkills()
              }}
            >
              <Sparkles size={15} />
              选择技能
            </Menu.Item>
          )}
          {teach &&
            (group ? (
              <Menu.Sub>
                <Menu.SubTrigger disabled={disabled || !teachAvailable || !members.length}>
                  <Circle size={15} className="text-destructive" />
                  教它做一项任务
                  <ChevronRight size={13} className="ml-auto" />
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent
                    className="bot-more-menu max-h-72 overflow-y-auto"
                    sideOffset={6}
                  >
                    <Menu.Label className="px-3 py-2 text-xs text-muted-foreground">
                      选择学习的 Bot
                    </Menu.Label>
                    {members.map((bot) => (
                      <Menu.Item key={bot.id} onSelect={() => teach(bot.id)}>
                        <BotAvatar agentId={bot.id} size="xs" isStatic />
                        <span className="max-w-52 truncate">{bot.name}</span>
                      </Menu.Item>
                    ))}
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
            ) : (
              <Menu.Item
                disabled={disabled || !teachAvailable || members.length !== 1}
                onSelect={() => {
                  if (members.length === 1) teach(members[0].id)
                }}
              >
                <Circle size={15} className="text-destructive" />
                教它做一项任务
              </Menu.Item>
            ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
