// W2.2 <-> W2.3 contract (docs/plan.md rows W2.2 / W2.3). W2.2 (shell + chat) owns this file and
// MOUNTS the components below; W2.3 (details / computer / settings / dialogs / onboarding) BUILDS them.
//
// Module + export names (each module is a directory with an `index.ts(x)`; W2.2 imports them lazily
// with `React.lazy`, so every export below must be a NAMED export of the directory index):
//
//   apps/web/src/details/index.tsx     export function DetailsPane(props: DetailsPaneProps)
//   apps/web/src/computer/index.tsx    export function ComputerView(props: ComputerViewProps)
//   apps/web/src/settings/index.tsx    export function SettingsDialog(props: SettingsDialogProps)
//   apps/web/src/dialogs/index.tsx     export function NewBotForm(props: NewBotFormProps)
//                                      export function NewGroupForm(props: NewGroupFormProps)
//   apps/web/src/onboarding/index.tsx  export function Onboarding(props: OnboardingProps)
//
// Where they mount:
//   - DetailsPane: the right column of the AppShell grid (320 px, resizable 280..424). The shell
//     owns the column, its left border and the resize handle; DetailsPane fills it (height 100 %,
//     own scroll) and renders its own header (Details | Library | Computer SegmentedTabs + close).
//     `botId` is set for direct chats; groups get only `conversationId`.
//   - ComputerView: full-window overlay (Grok's full-screen computer view; the shell renders a
//     `fixed inset-0` container above everything but dialogs; ComputerView fills it). Opened via
//     `useComputerView().open(botId)` (DetailsPane's Computer tab, the handoff card's Take over).
//   - SettingsDialog: rendered always by the shell, controlled by `open`. It should use the ui
//     `Dialog` primitive (900x702). The sidebar's "Computers" pill opens it at page "computers".
//   - NewBotForm / NewGroupForm: rendered by the shell inside a ui `Dialog` it owns (width 480,
//     with a `DialogHeader` title "New Bot" / "New group chat" and the close button). The form
//     renders below the header and owns its own layout: use `DialogBody` + `DialogFooter` from
//     @openbot/ui (Cancel calls onCancel; the primary button submits).
//     Opened from the New-chat palette ("Create new Bot", "Create group chat") or the shortcuts.
//   - Onboarding: full-screen; the shell shows it instead of the app while `session.info.firstRun`
//     is true and the roster has no bots; `onDone(botId?)` returns to the app (the shell opens the
//     created Bot's DM, waiting for its roster upsert if needed, else the newest conversation).
//
// Shared UI state lives in keep-alive atoms (apps/web/src/app/uiState.ts) and is re-exported here.
// The app is wrapped in `RegistryProvider` (from @effect/atom-react) by `main.tsx`, so these hooks
// work anywhere below it. Use the hooks, not the atoms, unless you need `useAtom*` directly.
import type { BotId, ConversationId } from "@openbot/contracts"

/** Right-pane tabs (Grok: Details | Library | Computer, plus OpenBot's Tasks: background work, D5.7). */
export type DetailsTab = "details" | "tasks" | "library" | "computer"

/** Settings dialog pages. W2.3 may add pages; unknown values fall back to "general". */
export type SettingsPage =
  "general" | "profiles" | "harnesses" | "computers" | "permissions" | "skills" | "usage" | "updates"

export interface DetailsPaneProps {
  /** The bot whose details to show (direct chats and bot-scoped views). */
  readonly botId?: BotId
  /** The conversation whose details to show (groups: members, name; directs: same as botId). */
  readonly conversationId?: ConversationId
  /** Initial / controlled tab. Read/write it with `useDetailsPane()` instead when possible. */
  readonly tab?: DetailsTab
  readonly onClose: () => void
}

export interface ComputerViewProps {
  readonly botId: BotId
  readonly onClose: () => void
}

export interface SettingsDialogProps {
  readonly open: boolean
  readonly initialPage?: SettingsPage
  readonly onClose: () => void
}

export interface NewBotFormProps {
  /** Prefilled name (New chat: Create “‹typed›” Bot). */
  readonly initialName?: string
  /** Called after `bots.create` succeeds; the shell selects the bot's direct conversation. */
  readonly onCreated: (botId: BotId) => void
  readonly onCancel: () => void
}

export interface NewGroupFormProps {
  /** Called after `conversations.createGroup` succeeds; the shell selects the new conversation. */
  readonly onCreated: (conversationId: ConversationId) => void
  readonly onCancel: () => void
  /** Bots pre-selected by the New-chat palette's "To:" picker. */
  readonly initialBotIds?: ReadonlyArray<BotId>
}

export interface OnboardingProps {
  /** `botId` is the Bot created in onboarding (the shell opens its DM); undefined on Skip. */
  readonly onDone: (botId?: BotId) => void
}

// Shared UI state (implemented in ./app/uiState.ts):
//   useSelection()        -> { conversationId, select(conversationId | null), selectBot(botId) }
//   useDetailsPane()      -> { open, tab, botId, show(tab?, botId?), hide(), toggle(), setTab(tab) }
//                            (`botId`: a member bot whose details a group chat's pane shows instead)
//   useSettingsDialog()   -> { open, page, show(page?), hide() }
//   useComputerView()     -> { botId, takeControl, open(botId, {takeControl?}), close() }
//   useDialogs()          -> { dialog, show(dialog), hide() }   dialog: "new-bot" | "new-group" | …
//   useResolvedTheme()    -> "dark" | "light" (resolved from settings.theme + system)
export {
  type ActiveDialog,
  type ComputerViewState,
  type DetailsPaneState,
  type SettingsDialogState,
  computerViewAtom,
  detailsPaneAtom,
  dialogAtom,
  selectedConversationAtom,
  settingsDialogAtom,
  useComputerView,
  useDetailsPane,
  useDialogs,
  useResolvedTheme,
  useSelection,
  useSettingsDialog,
} from "./app/uiState.ts"
