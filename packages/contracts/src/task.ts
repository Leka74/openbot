// Background tasks (docs/decisions.md D5.7): a piece of work a bot hands to a separate, short-lived
// harness session of its own so it stays free to chat. The bot starts it with `start_task`; when it
// ends, its result comes back to the bot in the conversation it was started from and the bot reports
// it there in its own words. The owner sees running work as a status line ("Handling…") and in the
// details pane's Tasks tab; its steps never appear as chat bubbles.
import { Schema } from "effect"
import { BotId, ConversationId, Millis, NonEmptyString, NonNegativeInt, TaskId, Usage } from "./base.ts"
import { TranscriptEntry } from "./transcript.ts"

export const TaskStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])
export type TaskStatus = typeof TaskStatus.Type

/** Who stopped a cancelled task. */
export const TaskStoppedBy = Schema.Literals(["owner", "bot", "system"])
export type TaskStoppedBy = typeof TaskStoppedBy.Type

export const Task = Schema.Struct({
  id: TaskId,
  botId: BotId,
  /** The conversation the work was started from: its result is reported there. */
  conversationId: ConversationId,
  title: NonEmptyString,
  /** What the work is (written by the bot; the task session knows only this). */
  brief: Schema.String,
  status: TaskStatus,
  createdAt: Millis,
  updatedAt: Millis,
  startedAt: Schema.optionalKey(Millis),
  endedAt: Schema.optionalKey(Millis),
  /** The final answer of a finished task (capped at `TASK_RESULT_MAX_CHARS`). */
  result: Schema.optionalKey(Schema.String),
  /** Why it failed, or why it was stopped. */
  error: Schema.optionalKey(Schema.String),
  stoppedBy: Schema.optionalKey(TaskStoppedBy),
  usage: Schema.optionalKey(Usage),
  /** Latest activity while it runs (e.g. "Running a command"). */
  progress: Schema.optionalKey(Schema.String),
  /** Tool calls so far. */
  stepCount: Schema.optionalKey(NonNegativeInt),
  /** An approval card of this task waits for the owner. */
  waiting: Schema.optionalKey(Schema.Boolean),
  /** Its harness session, resumed when a restart cut the task off. */
  nativeSessionId: Schema.optionalKey(Schema.String),
  /** Times a restart cut it off and it ran again (at most `MAX_TASK_RESTARTS`). */
  restarts: Schema.optionalKey(NonNegativeInt),
  /**
   * Boot recovery failed it (a restart cut it off) and it has not run again or been reported yet. A
   * brain stopped before doing either leaves this set, so the next boot picks the task up again.
   */
  awaitingRecovery: Schema.optionalKey(Schema.Boolean),
})
export type Task = typeof Task.Type

/** A task with its steps (tool calls, reasoning, messages), oldest first — `tasks.get`. */
export const TaskDetail = Schema.Struct({
  task: Task,
  steps: Schema.Array(TranscriptEntry),
})
export type TaskDetail = typeof TaskDetail.Type

export const isTerminalTaskStatus = (status: TaskStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled"

export const isActiveTask = (task: Pick<Task, "status">): boolean =>
  task.status === "queued" || task.status === "running"

/** Limits (characters). */
export const TASK_TITLE_MAX_CHARS = 120
export const TASK_BRIEF_MAX_CHARS = 16_000
export const TASK_RESULT_MAX_CHARS = 16_000
/** Tasks of one bot that run at the same time; more wait in line. */
export const DEFAULT_TASKS_PER_BOT = 3
/** A task cut off by more restarts than this is reported to its bot as unfinished. */
export const MAX_TASK_RESTARTS = 3
/** Finished tasks per bot kept in the roster snapshot (the Tasks tab lists more with `tasks.list`). */
export const ROSTER_FINISHED_TASKS = 5
