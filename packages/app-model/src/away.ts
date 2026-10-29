// "While you were away": what a profile held back while another one was active, grouped by Bot.
// Bots that need you come first, and in each group what needs you comes before the rest; otherwise
// the newest first.
import type { BotId, HeldNotification } from "@openbot/contracts"

export interface AwayGroup {
  /** Absent for what no Bot sent (updates, failures of the brain itself). */
  readonly botId: BotId | undefined
  readonly botName: string | undefined
  readonly needsYou: boolean
  readonly items: ReadonlyArray<HeldNotification>
}

const needsYouFirst = (a: HeldNotification, b: HeldNotification) =>
  Number(b.needsYou) - Number(a.needsYou) || b.notification.at - a.notification.at

export const awayGroups = (items: ReadonlyArray<HeldNotification>): ReadonlyArray<AwayGroup> => {
  const byBot = new Map<BotId | undefined, Array<HeldNotification>>()
  for (const item of [...items].sort(needsYouFirst)) {
    const group = byBot.get(item.notification.botId)
    if (group === undefined) byBot.set(item.notification.botId, [item])
    else group.push(item)
  }
  // each group's first item is its most pressing one, and the groups come in that order
  return Array.from(byBot, ([botId, held]) => ({
    botId,
    botName: held.find((item) => item.botName !== undefined)?.botName,
    needsYou: held[0]!.needsYou,
    items: held,
  }))
}
