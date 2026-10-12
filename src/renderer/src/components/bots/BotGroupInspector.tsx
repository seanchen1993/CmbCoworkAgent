import { useState } from "react"
import { ChevronRight, Settings2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { BotConversation, CoworkBot } from "../../../../shared/bot-types"
import { BotAvatar } from "./BotAvatar"
import { BotFiles } from "./BotFiles"
import { BotGroupMembers } from "./BotGroupMembers"
import { BotInspectorPanel } from "./BotInspectorPanel"

/** Group details share the existing conversation projection and mutation receipts. */
export function BotGroupInspector({
  group,
  bots,
  settings,
  openBot,
  showDownloads,
  onExitAutoFocus,
  close
}: {
  group: BotConversation
  bots: CoworkBot[]
  settings(): void
  openBot(botId: string): void
  showDownloads?: () => void
  onExitAutoFocus?(): void
  close(): void
}) {
  const [tab, setTab] = useState("details")
  return (
    <BotInspectorPanel name={group.name} tab={tab} close={close} onExitAutoFocus={onExitAutoFocus}>
      {() => (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <div className="bot-computer-profile">
            <BotAvatar agentId={group.id} kind="group" memberIds={group.members} size="xl" />
            <h3>{group.name}</h3>
            <span>
              {group.members.length} 个 Bot{group.members.length > 1 ? " 协作" : ""}
            </span>
            <TabsList className="bot-inspector-tabs" aria-label="群聊详情内容">
              <TabsTrigger value="details">详情</TabsTrigger>
              <TabsTrigger value="library">资料库</TabsTrigger>
              <TabsTrigger value="members">成员</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="details"
            className="bot-inspector-content min-h-0 flex-1 overflow-y-auto"
          >
            <div className="space-y-6 px-6 py-4">
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">协作目标</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 rounded-full text-xs"
                    onClick={settings}
                  >
                    <Settings2 size={13} />
                    编辑
                  </Button>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {group.description || "还没有群聊描述。可以补充共同目标和分工要求。"}
                </p>
              </section>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl bg-muted/35 px-4 py-3 text-left text-sm hover:bg-muted"
                onClick={() => setTab("members")}
              >
                <Users size={16} className="text-muted-foreground" />
                <span className="flex-1">群聊成员</span>
                <span className="text-xs text-muted-foreground">{group.members.length}</span>
                <ChevronRight size={14} className="text-muted-foreground" />
              </button>
            </div>
          </TabsContent>
          <TabsContent
            value="library"
            className="bot-inspector-content min-h-0 flex-1 overflow-y-auto"
          >
            <p className="px-5 pt-4 text-xs leading-relaxed text-muted-foreground">
              来自本群聊的附件与成果
            </p>
            <BotFiles
              key={group.id}
              conversationId={group.id}
              showDownloads={showDownloads}
              inline
            />
          </TabsContent>
          <TabsContent
            value="members"
            className="bot-inspector-content min-h-0 flex-1 overflow-y-auto"
          >
            <BotGroupMembers group={group} bots={bots} openBot={openBot} />
          </TabsContent>
        </Tabs>
      )}
    </BotInspectorPanel>
  )
}
