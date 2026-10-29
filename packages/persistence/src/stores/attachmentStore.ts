/**
 * `AttachmentStore`: bytes at `<attachments>/<id>` of the current profile (atomic write), metadata in
 * the `attachments` table (Schema-encoded `AttachmentRecord`, with the profile in `owner_profile_id`).
 * Bytes are written before the row, so a listed attachment always has its file.
 */
import {
  AttachmentRecord,
  AttachmentStore,
  currentProfileId,
  type DataDirShape,
  IdGen,
  joinPath,
  RepoError,
} from "@openbot/core"
import { OwnerProfileId } from "@openbot/contracts"
import { Clock, Effect, Exit, Option, Schema, Stream, Struct } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"
import { openStreamWriter, readBytesFile, removePath, safeSegment, writeFileAtomic } from "./files.ts"

/** The payload; the profile is the row's `owner_profile_id`. */
const RecordJson = jsonCodec(AttachmentRecord.mapFields(Struct.omit(["ownerProfileId"])), "attachment")
const decodeProfileId = Schema.decodeUnknownEffect(OwnerProfileId)

interface Row {
  readonly payload_json: string
  readonly owner_profile_id: string
}

export const makeFileAttachmentStore = (dataDir: DataDirShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const ids = yield* IdGen

    const getRecord = (op: string, id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<Row>`SELECT payload_json, owner_profile_id FROM attachments WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return Option.none<AttachmentRecord>()
        const payload = yield* RecordJson.decode(op, row.payload_json, id)
        const ownerProfileId = yield* decodeProfileId(row.owner_profile_id)
        return Option.some<AttachmentRecord>({ ...payload, ownerProfileId })
      }).pipe(repoOp(op))

    return AttachmentStore.of({
      put: (input) =>
        Effect.gen(function* () {
          const id = yield* ids.attachmentId
          const profileId = yield* currentProfileId
          const path = joinPath(dataDir.profile(profileId).attachments, yield* safeSegment("AttachmentStore.put", id))
          const createdAt = yield* Clock.currentTimeMillis
          const record: AttachmentRecord = {
            id,
            ownerProfileId: profileId,
            name: input.name,
            mime: input.mime,
            byteSize: input.bytes.byteLength,
            path,
            createdAt,
          }
          yield* writeFileAtomic("AttachmentStore.put", path, input.bytes)
          const payload = yield* RecordJson.encode("AttachmentStore.put", record)
          yield* sql`INSERT INTO attachments (id, owner_profile_id, created_at, payload_json)
            VALUES (${id}, ${profileId}, ${createdAt}, ${payload})`.pipe(
            Effect.tapError(() => removePath("AttachmentStore.put", path).pipe(Effect.ignore)),
          )
          return record
        }).pipe(repoOp("AttachmentStore.put")),
      putStream: (input) =>
        Effect.gen(function* () {
          const id = yield* ids.attachmentId
          const profileId = yield* currentProfileId
          const path = joinPath(
            dataDir.profile(profileId).attachments,
            yield* safeSegment("AttachmentStore.putStream", id),
          )
          // chunks go to a sibling temp file as they arrive; renamed into place once complete
          const writer = yield* openStreamWriter("AttachmentStore.putStream", path)
          const written = yield* Stream.runForEach(input.chunks, (chunk) => writer.write(chunk)).pipe(
            Effect.andThen(writer.commit),
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : writer.abort)),
          )
          const createdAt = yield* Clock.currentTimeMillis
          const record: AttachmentRecord = {
            id,
            ownerProfileId: profileId,
            name: input.name,
            mime: input.mime,
            byteSize: written,
            path,
            createdAt,
            ...(input.width === undefined ? {} : { width: input.width }),
            ...(input.height === undefined ? {} : { height: input.height }),
          }
          const payload = yield* RecordJson.encode("AttachmentStore.putStream", record)
          yield* sql`INSERT INTO attachments (id, owner_profile_id, created_at, payload_json)
            VALUES (${id}, ${profileId}, ${createdAt}, ${payload})`.pipe(
            repoOp("AttachmentStore.putStream"),
            Effect.tapError(() => removePath("AttachmentStore.putStream", path).pipe(Effect.ignore)),
          )
          return record
        }),
      get: (id) => getRecord("AttachmentStore.get", id),
      read: (id) =>
        Effect.gen(function* () {
          const record = yield* getRecord("AttachmentStore.read", id)
          if (Option.isNone(record)) return Option.none()
          const bytes = yield* readBytesFile("AttachmentStore.read", record.value.path)
          return bytes === undefined ? Option.none() : Option.some(bytes)
        }),
      stream: (id) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const record = yield* getRecord("AttachmentStore.stream", id)
            if (Option.isNone(record)) {
              return yield* Effect.fail(new RepoError({ op: "AttachmentStore.stream", message: `No attachment ${id}` }))
            }
            const path = record.value.path
            return Stream.fromReadableStream({
              evaluate: () => Bun.file(path).stream(),
              onError: (cause) =>
                new RepoError({
                  op: "AttachmentStore.stream",
                  message: `Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            })
          }),
        ),
      delete: (id) =>
        Effect.gen(function* () {
          const record = yield* getRecord("AttachmentStore.delete", id)
          if (Option.isNone(record)) return false
          yield* sql`DELETE FROM attachments WHERE id = ${id}`.pipe(repoOp("AttachmentStore.delete"))
          yield* removePath("AttachmentStore.delete", record.value.path)
          return true
        }),
    })
  })
