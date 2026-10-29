/**
 * AttachmentService: `attachments.upload` / contract views of stored attachments. Bytes live in
 * `AttachmentStore` (the profile's `attachments/<id>`); harnesses get the brain path at turn start.
 */
import type { Attachment } from "@openbot/contracts"
import { InvalidInput } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { RepoError } from "../../ports/errors.ts"
import type { CurrentProfile } from "../../ports/Profiles.ts"
import { AttachmentStore, type AttachmentRecord, type AttachmentStreamInput } from "../../ports/stores.ts"
import { AttachmentService } from "../../ports/services.ts"
import { compact, orDie, required } from "./internal/util.ts"

/** Grok Bot's desktop limit for documents and images (grok-bot-product.md §7). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_NAME_LENGTH = 255
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

/** Contract view of a stored attachment (`url` is served by the brain at `/api/attachments/<id>`). */
export const toAttachment = (record: AttachmentRecord): Attachment =>
  compact({
    id: record.id,
    name: record.name,
    mime: record.mime,
    byteSize: record.byteSize,
    url: `/api/attachments/${record.id}`,
    width: record.width,
    height: record.height,
  })

const validName = (raw: string): Effect.Effect<string, InvalidInput> => {
  const name = [...raw.trim()]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join("")
    .replace(/[\\/]/g, "_")
  return name.length === 0 || name.length > MAX_NAME_LENGTH
    ? Effect.fail(new InvalidInput({ message: `The file name must be 1 to ${MAX_NAME_LENGTH} characters.` }))
    : Effect.succeed(name)
}

/**
 * Stores a streamed file (bot-sent files, `send_file`): the bytes go to the store as they arrive,
 * never as one buffer. Validates the name and media type like `upload`; the caller bounds the
 * stream's size. The stream's own error is passed through; nothing is stored when it fails.
 */
export const storeAttachmentStream = <E>(
  store: AttachmentStore["Service"],
  input: AttachmentStreamInput<E>,
): Effect.Effect<Attachment, InvalidInput | E, CurrentProfile> =>
  Effect.gen(function* () {
    const name = yield* validName(input.name)
    if (!MIME.test(input.mime)) return yield* new InvalidInput({ message: `Unsupported media type "${input.mime}".` })
    const record = yield* store.putStream({ ...input, name, mime: input.mime.toLowerCase() }).pipe(
      Effect.catchIf(
        (e): e is RepoError => e instanceof RepoError,
        (e) => Effect.die(e),
      ),
    )
    return toAttachment(record)
  })

export const AttachmentServiceLive: Layer.Layer<AttachmentService, never, AttachmentStore> = Layer.effect(
  AttachmentService,
  Effect.gen(function* () {
    const store = yield* AttachmentStore
    return AttachmentService.of({
      upload: Effect.fn("AttachmentService.upload")(function* (input) {
        const name = yield* validName(input.name)
        if (!MIME.test(input.mime))
          return yield* new InvalidInput({ message: `Unsupported media type "${input.mime}".` })
        if (input.bytes.byteLength === 0) return yield* new InvalidInput({ message: "The file is empty." })
        if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return yield* new InvalidInput({ message: "Attachments are limited to 25 MB." })
        }
        const record = yield* orDie(store.put({ name, mime: input.mime.toLowerCase(), bytes: input.bytes }))
        return toAttachment(record)
      }),
      get: (attachmentId) => Effect.map(required(store.get(attachmentId), "attachment", attachmentId), toAttachment),
    })
  }),
)
