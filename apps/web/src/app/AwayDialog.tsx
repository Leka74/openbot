// "While you were away": coming back to a profile shows what it held back while another one was
// active (app-model away.ts groups it). Closing it clears up to the newest item it showed, so
// anything newer is shown next.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { awayAtom, commands } from "@openbot/client"
import type { HeldNotification, NotificationId } from "@openbot/contracts"
import { Avatar, Dialog, DialogBody, DialogFooter, DialogHeader, PillButton, StatusPill, useToast } from "@openbot/ui"
import { Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState } from "react"
import { describeFailure } from "../cards/useRespond.ts"
import { useRoster } from "./data.ts"
import { awayGroups, formatListTime } from "./format.ts"
import { useSelection } from "./uiState.ts"

export function AwayDialog(): ReactNode {
  const away = useAtomValue(awayAtom)
  const dismiss = useAtomSet(commands["profiles.dismissAway"], { mode: "promiseExit" })
  const { toast } = useToast()
  const roster = useRoster()
  const { select } = useSelection()
  const [dismissed, setDismissed] = useState<NotificationId | undefined>(undefined)
  const summary = AsyncResult.isSuccess(away) ? away.value : undefined
  const newest = summary?.items.at(-1)?.notification.id
  if (summary === undefined || newest === undefined || newest === dismissed) return null

  const close = () => {
    setDismissed(newest)
    void dismiss({ through: newest }).then((exit) => {
      if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
    })
  }
  const open = (item: HeldNotification) => {
    if (item.notification.conversationId !== undefined) select(item.notification.conversationId)
    close()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && close()} width={520} label="While you were away" className="ob-phone-full">
      <DialogHeader
        title="While you were away"
        {...(summary.dropped > 0 ? { description: `${summary.dropped} older ones are not shown.` } : {})}
        onClose={close}
      />
      <DialogBody className="flex flex-col gap-4">
        {awayGroups(summary.items).map((group) => {
          const bot = group.botId === undefined ? undefined : roster.botById(group.botId)
          const name = bot?.name ?? group.botName ?? "OpenBot"
          return (
            <section key={group.botId ?? "openbot"} className="flex flex-col gap-1" data-testid="away-group">
              <div className="flex items-center gap-2 px-1">
                {bot && <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={20} />}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{name}</span>
                {group.needsYou && (
                  <StatusPill tone="warn" className="h-[22px] text-xs">
                    Needs you
                  </StatusPill>
                )}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.notification.id}
                  type="button"
                  onClick={() => open(item)}
                  className="flex items-baseline gap-2 rounded-xl px-3 py-2 text-start hover:bg-secondary"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {item.notification.title !== name && (
                      <span className="truncate text-base text-fg">{item.notification.title}</span>
                    )}
                    <span className="line-clamp-2 text-sm text-fg-secondary">{item.notification.body}</span>
                  </span>
                  <span className="shrink-0 text-xs text-fg-tertiary">{formatListTime(item.notification.at)}</span>
                </button>
              ))}
            </section>
          )
        })}
      </DialogBody>
      <DialogFooter>
        <PillButton variant="primary" size="card" onClick={close} data-autofocus>
          Done
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}
