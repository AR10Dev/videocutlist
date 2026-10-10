import * as Schema from "effect/Schema";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
// Native media component codec; its route remains outside the JSON API.
export type Waveform = {
  readonly startMs: number;
  readonly durationMs: number;
  readonly peaks: ReadonlyArray<number>;
} & { readonly [x: string]: Schema.Json };
export const Waveform = Schema.StructWithRest(
  Schema.Struct({
    startMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
    ),
    durationMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(120000).annotate({
          expected: "a value less than or equal to 120000",
        }),
      ),
    peaks: Schema.Array(
      Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(1).annotate({ expected: "a value less than or equal to 1" }),
        ),
    )
      .check(Schema.isMinLength(16).annotate({ expected: "a value with a length of at least 16" }))
      .check(
        Schema.isMaxLength(4096).annotate({ expected: "a value with a length of at most 4096" }),
      ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Waveform" });

// non-recursive definitions
export type MediaPage = {
  readonly items: ReadonlyArray<
    {
      readonly id: string;
      readonly name: string;
      readonly durationMs: number;
      readonly sizeBytes: number;
      readonly container: string;
      readonly streams: { readonly [x: string]: Schema.Json };
      readonly etag: string;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly nextCursor?: string | null;
} & { readonly [x: string]: Schema.Json };
export const MediaPage = Schema.StructWithRest(
  Schema.Struct({
    items: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          durationMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          sizeBytes: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          container: Schema.String,
          streams: Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
          etag: Schema.String,
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "MediaPage" });
export type Error = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  } & { readonly [x: string]: Schema.Json };
} & { readonly [x: string]: Schema.Json };
export const Error = Schema.StructWithRest(
  Schema.Struct({
    error: Schema.StructWithRest(
      Schema.Struct({ code: Schema.String, message: Schema.String, requestId: Schema.String }),
      [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Error" });
export type FolderPage = {
  readonly folders: ReadonlyArray<
    { readonly id: string; readonly label: string } & { readonly [x: string]: Schema.Json }
  >;
  readonly items: ReadonlyArray<
    {
      readonly id: string;
      readonly name: string;
      readonly durationMs: number;
      readonly sizeBytes: number;
      readonly container: string;
      readonly streams: { readonly [x: string]: Schema.Json };
      readonly etag: string;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly nextCursor?: string | null;
} & { readonly [x: string]: Schema.Json };
export const FolderPage = Schema.StructWithRest(
  Schema.Struct({
    folders: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ id: Schema.String, label: Schema.String }), [
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
      ]),
    ),
    items: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          durationMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          sizeBytes: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          container: Schema.String,
          streams: Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
          etag: Schema.String,
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "FolderPage" });
export type LibraryStatus = {
  readonly state: "unconfigured" | "scanning" | "ready_empty" | "ready_with_media" | "failed";
  readonly message: string;
} & { readonly [x: string]: Schema.Json };
export const LibraryStatus = Schema.StructWithRest(
  Schema.Struct({
    state: Schema.Literals([
      "unconfigured",
      "scanning",
      "ready_empty",
      "ready_with_media",
      "failed",
    ]),
    message: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "LibraryStatus" });
export type ImportJob = {
  readonly id: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: number;
  readonly indexed: number;
  readonly rootResults?: {
    readonly [x: string]: {
      readonly state: "scanning" | "ready_empty" | "ready_with_media" | "failed";
      readonly errorCode?: "scan_limit" | "cancelled" | "scan_failed";
    } & { readonly [x: string]: Schema.Json };
  };
  readonly errorCode?: string;
  readonly validationErrors?: ReadonlyArray<string>;
} & { readonly [x: string]: Schema.Json };
export const ImportJob = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String.check(
      Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
        expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
      }),
    ),
    state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
    progress: Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
      .check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(1).annotate({ expected: "a value less than or equal to 1" }),
      ),
    indexed: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
    ),
    rootResults: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.StructWithRest(
          Schema.Struct({
            state: Schema.Literals(["scanning", "ready_empty", "ready_with_media", "failed"]),
            errorCode: Schema.optionalKey(
              Schema.Literals(["scan_limit", "cancelled", "scan_failed"]),
            ),
          }),
          [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
        ),
      ),
    ),
    errorCode: Schema.optionalKey(Schema.String),
    validationErrors: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "ImportJob" });
export type Media = {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly container: string;
  readonly streams: { readonly [x: string]: Schema.Json };
  readonly etag: string;
} & { readonly [x: string]: Schema.Json };
export const Media = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    durationMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    sizeBytes: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    container: Schema.String,
    streams: Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
    etag: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Media" });
export type ProjectPage = {
  readonly items: ReadonlyArray<
    {
      readonly id: string;
      readonly name: string;
      readonly revision: number;
      readonly updatedAt: string;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly nextCursor: string | null;
} & { readonly [x: string]: Schema.Json };
export const ProjectPage = Schema.StructWithRest(
  Schema.Struct({
    items: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(1).annotate({
              expected: "a value greater than or equal to 1",
            }),
          ),
          updatedAt: Schema.String.annotate({ format: "date-time" }),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    nextCursor: Schema.Union([Schema.String, Schema.Null]),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "ProjectPage" });
export type Project = {
  readonly id: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly schemaVersion: 2;
  readonly name: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly mediaId: string;
    readonly segments: ReadonlyArray<{
      readonly id?: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly label?: string;
      readonly included?: boolean;
    }>;
    readonly editorState?: {
      readonly playheadMs: number;
      readonly zoom: number;
      readonly muted: boolean;
    } & { readonly [x: string]: Schema.Json };
    readonly exportOptions: {
      readonly mode?: "merge" | "separate";
      readonly selection?: "segments" | "gaps";
      readonly streamIndexes?: ReadonlyArray<number>;
      readonly cutStrategy?: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
      readonly container?: "mkv" | "mp4" | "mov";
      readonly destinationId?: string;
      readonly filenameTemplate?: string;
    };
  }>;
};
export const Project = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.String.annotate({ format: "date-time" }),
  revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
    Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
  ),
  schemaVersion: Schema.Literal(2),
  name: Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  ).check(
    Schema.isMaxCodePoints(120).annotate({ expected: "a string with at most 120 code points" }),
  ),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(
        Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
          expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
        }),
      ),
      mediaId: Schema.String.check(
        Schema.isPattern(new RegExp("^m_[A-Za-z0-9_-]{43}$", "u")).annotate({
          expected: "a string matching the RegExp ^m_[A-Za-z0-9_-]{43}$",
        }),
      ),
      segments: Schema.Array(
        Schema.Struct({
          id: Schema.optionalKey(
            Schema.String.check(
              Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
            ).check(
              Schema.isMaxCodePoints(128).annotate({
                expected: "a string with at most 128 code points",
              }),
            ),
          ),
          startMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(0).annotate({
              expected: "a value greater than or equal to 0",
            }),
          ),
          endMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(1).annotate({
              expected: "a value greater than or equal to 1",
            }),
          ),
          label: Schema.optionalKey(
            Schema.String.check(
              Schema.isMaxCodePoints(200).annotate({
                expected: "a string with at most 200 code points",
              }),
            ),
          ),
          included: Schema.optionalKey(Schema.Boolean.annotate({ default: true })),
        }),
      ),
      editorState: Schema.optionalKey(
        Schema.StructWithRest(
          Schema.Struct({
            playheadMs: Schema.Number.check(
              Schema.isInt().annotate({ expected: "an integer" }),
            ).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
            zoom: Schema.Number.check(
              Schema.isFinite().annotate({ expected: "a finite number" }),
            ).check(Schema.isGreaterThan(0).annotate({ expected: "a value greater than 0" })),
            muted: Schema.Boolean,
          }),
          [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
        ),
      ),
      exportOptions: Schema.Struct({
        mode: Schema.optionalKey(Schema.Literals(["merge", "separate"])),
        selection: Schema.optionalKey(Schema.Literals(["segments", "gaps"])),
        streamIndexes: Schema.optionalKey(
          Schema.Array(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
          ).check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
        ),
        cutStrategy: Schema.optionalKey(
          Schema.Literals(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]),
        ),
        container: Schema.optionalKey(Schema.Literals(["mkv", "mp4", "mov"])),
        destinationId: Schema.optionalKey(
          Schema.String.check(
            Schema.isMaxCodePoints(64).annotate({
              expected: "a string with at most 64 code points",
            }),
          ),
        ),
        filenameTemplate: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "At most 160 UTF-8 bytes. Standard maxLength counts Unicode characters rather than bytes, so the server enforces this bound.",
          }),
        ),
      }),
    }),
  ).check(Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" })),
}).annotate({ identifier: "Project" });
export type ProjectInput = {
  readonly revision: number;
  readonly schemaVersion: 2;
  readonly name: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly mediaId: string;
    readonly segments: ReadonlyArray<{
      readonly id?: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly label?: string;
      readonly included?: boolean;
    }>;
    readonly editorState?: {
      readonly playheadMs: number;
      readonly zoom: number;
      readonly muted: boolean;
    } & { readonly [x: string]: Schema.Json };
    readonly exportOptions: {
      readonly mode?: "merge" | "separate";
      readonly selection?: "segments" | "gaps";
      readonly streamIndexes?: ReadonlyArray<number>;
      readonly cutStrategy?: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
      readonly container?: "mkv" | "mp4" | "mov";
      readonly destinationId?: string;
      readonly filenameTemplate?: string;
    };
  }>;
};
export const ProjectInput = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
    Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
  ),
  schemaVersion: Schema.Literal(2),
  name: Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  ).check(
    Schema.isMaxCodePoints(120).annotate({ expected: "a string with at most 120 code points" }),
  ),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(
        Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
          expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
        }),
      ),
      mediaId: Schema.String.check(
        Schema.isPattern(new RegExp("^m_[A-Za-z0-9_-]{43}$", "u")).annotate({
          expected: "a string matching the RegExp ^m_[A-Za-z0-9_-]{43}$",
        }),
      ),
      segments: Schema.Array(
        Schema.Struct({
          id: Schema.optionalKey(
            Schema.String.check(
              Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
            ).check(
              Schema.isMaxCodePoints(128).annotate({
                expected: "a string with at most 128 code points",
              }),
            ),
          ),
          startMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(0).annotate({
              expected: "a value greater than or equal to 0",
            }),
          ),
          endMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(1).annotate({
              expected: "a value greater than or equal to 1",
            }),
          ),
          label: Schema.optionalKey(
            Schema.String.check(
              Schema.isMaxCodePoints(200).annotate({
                expected: "a string with at most 200 code points",
              }),
            ),
          ),
          included: Schema.optionalKey(Schema.Boolean.annotate({ default: true })),
        }),
      ),
      editorState: Schema.optionalKey(
        Schema.StructWithRest(
          Schema.Struct({
            playheadMs: Schema.Number.check(
              Schema.isInt().annotate({ expected: "an integer" }),
            ).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
            zoom: Schema.Number.check(
              Schema.isFinite().annotate({ expected: "a finite number" }),
            ).check(Schema.isGreaterThan(0).annotate({ expected: "a value greater than 0" })),
            muted: Schema.Boolean,
          }),
          [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
        ),
      ),
      exportOptions: Schema.Struct({
        mode: Schema.optionalKey(Schema.Literals(["merge", "separate"])),
        selection: Schema.optionalKey(Schema.Literals(["segments", "gaps"])),
        streamIndexes: Schema.optionalKey(
          Schema.Array(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
          ).check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
        ),
        cutStrategy: Schema.optionalKey(
          Schema.Literals(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]),
        ),
        container: Schema.optionalKey(Schema.Literals(["mkv", "mp4", "mov"])),
        destinationId: Schema.optionalKey(
          Schema.String.check(
            Schema.isMaxCodePoints(64).annotate({
              expected: "a string with at most 64 code points",
            }),
          ),
        ),
        filenameTemplate: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "At most 160 UTF-8 bytes. Standard maxLength counts Unicode characters rather than bytes, so the server enforces this bound.",
          }),
        ),
      }),
    }),
  ).check(Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" })),
}).annotate({ identifier: "ProjectInput" });
export type DetectionInput = {
  readonly mediaId: string;
  readonly projectItemId: string;
  readonly projectRevision: number;
  readonly kind: "silence" | "black" | "scene";
  readonly sourceFingerprint?: string;
  readonly noiseDb?: number;
  readonly minDurationMs?: number;
  readonly sceneThreshold?: number;
} & { readonly [x: string]: Schema.Json };
export const DetectionInput = Schema.StructWithRest(
  Schema.Struct({
    mediaId: Schema.String,
    projectItemId: Schema.String,
    projectRevision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
      Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
    ),
    kind: Schema.Literals(["silence", "black", "scene"]),
    sourceFingerprint: Schema.optionalKey(Schema.String),
    noiseDb: Schema.optionalKey(
      Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" })),
    ),
    minDurationMs: Schema.optionalKey(
      Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      ),
    ),
    sceneThreshold: Schema.optionalKey(
      Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(1).annotate({ expected: "a value less than or equal to 1" }),
        ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "DetectionInput" });
export type DetectionJob = {
  readonly id: string;
  readonly type: "detection";
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly mediaId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly kind: "silence" | "black" | "scene";
  readonly candidates?: ReadonlyArray<
    | {
        readonly id: string;
        readonly mediaId: string;
        readonly projectId: string;
        readonly projectRevision: number;
        readonly startMs: number;
        readonly endMs: number;
        readonly source: "silence" | "black";
      }
    | {
        readonly id: string;
        readonly mediaId: string;
        readonly projectId: string;
        readonly projectRevision: number;
        readonly pointMs: number;
        readonly source: "scene";
      }
  >;
  readonly errorCode?: string;
} & { readonly [x: string]: Schema.Json };
export const DetectionJob = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("detection"),
    state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
    mediaId: Schema.String,
    projectId: Schema.String,
    projectRevision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    kind: Schema.Literals(["silence", "black", "scene"]),
    candidates: Schema.optionalKey(
      Schema.Array(
        Schema.Union(
          [
            Schema.Struct({
              id: Schema.String,
              mediaId: Schema.String,
              projectId: Schema.String,
              projectRevision: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ),
              startMs: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ).check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              ),
              endMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                Schema.isGreaterThanOrEqualTo(1).annotate({
                  expected: "a value greater than or equal to 1",
                }),
              ),
              source: Schema.Literals(["silence", "black"]),
            }),
            Schema.Struct({
              id: Schema.String,
              mediaId: Schema.String,
              projectId: Schema.String,
              projectRevision: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ),
              pointMs: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ).check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              ),
              source: Schema.Literal("scene"),
            }),
          ],
          { mode: "oneOf" },
        ),
      ),
    ),
    errorCode: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "DetectionJob" });
export type ExportSubmissionInput = {
  readonly projectRevision: number;
  readonly itemIds?: ReadonlyArray<string>;
};
export const ExportSubmissionInput = Schema.Struct({
  projectRevision: Schema.Number.annotate({
    description: "Persisted revision verified by fresh export preflight.",
  })
    .check(Schema.isInt().annotate({ expected: "an integer" }))
    .check(
      Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
    ),
  itemIds: Schema.optionalKey(
    Schema.Array(Schema.String)
      .annotate({
        description:
          "Optional ordered project-item selection; omitted selects all. Export options are read from each saved project item.",
      })
      .check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
  ),
}).annotate({ identifier: "ExportSubmissionInput" });
export type BatchExportSubmission = {
  readonly batchId: string;
  readonly jobs: ReadonlyArray<
    {
      readonly id: string;
      readonly batchId?: string;
      readonly projectItemId?: string;
      readonly mediaLabel?: string;
      readonly mediaId?: string;
      readonly projectId?: string;
      readonly projectRevision?: number;
      readonly kind?: string;
      readonly type: "export" | "detection" | "library_scan";
      readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      readonly revision: number;
      readonly progress?: number;
      readonly result?: {
        readonly container?: "mkv" | "mp4" | "mov";
        readonly outputName?: string;
        readonly outputNames?: ReadonlyArray<string>;
        readonly outputFailures?: ReadonlyArray<{
          readonly segment: number;
          readonly code: string;
          readonly message: string;
        }>;
        readonly sizeBytes: number;
        readonly retainUntil: string;
        readonly destinationId?: string;
        readonly destinationKind?: "download" | "archive" | "source_adjacent";
        readonly appliedStrategies?: ReadonlyArray<{
          readonly segment: number;
          readonly outputName?: string;
          readonly strategy: string;
        }>;
      };
      readonly strategy?: string;
      readonly container?: "mkv" | "mp4" | "mov";
      readonly mode?: "merge" | "separate";
      readonly selection?: "segments" | "gaps";
      readonly selectedStreams?: ReadonlyArray<number>;
      readonly appliedStrategy?: string;
      readonly warnings?: ReadonlyArray<string>;
      readonly warningDetails?: ReadonlyArray<
        {
          readonly severity: string;
          readonly code: string;
          readonly message: string;
          readonly streamIndex?: number;
        } & { readonly [x: string]: Schema.Json }
      >;
      readonly verified?: boolean;
      readonly errorCode?: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    } & { readonly [x: string]: Schema.Json }
  >;
} & { readonly [x: string]: Schema.Json };
export const BatchExportSubmission = Schema.StructWithRest(
  Schema.Struct({
    batchId: Schema.String,
    jobs: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          batchId: Schema.optionalKey(Schema.String),
          projectItemId: Schema.optionalKey(Schema.String),
          mediaLabel: Schema.optionalKey(Schema.String),
          mediaId: Schema.optionalKey(Schema.String),
          projectId: Schema.optionalKey(Schema.String),
          projectRevision: Schema.optionalKey(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          ),
          kind: Schema.optionalKey(Schema.String),
          type: Schema.Literals(["export", "detection", "library_scan"]),
          state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
          revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(1).annotate({
              expected: "a value greater than or equal to 1",
            }),
          ),
          progress: Schema.optionalKey(
            Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
              .check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              )
              .check(
                Schema.isLessThanOrEqualTo(1).annotate({
                  expected: "a value less than or equal to 1",
                }),
              ),
          ),
          result: Schema.optionalKey(
            Schema.Struct({
              container: Schema.optionalKey(
                Schema.Literals(["mkv", "mp4", "mov"]).annotate({
                  description: "Published output container.",
                }),
              ),
              outputName: Schema.optionalKey(
                Schema.String.annotate({
                  description: "Published merged-export filename, never a filesystem path.",
                }),
              ),
              outputNames: Schema.optionalKey(
                Schema.Array(Schema.String).annotate({
                  description: "Published separate-export filenames, never filesystem paths.",
                }),
              ),
              outputFailures: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    segment: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(1).annotate({
                        expected: "a value greater than or equal to 1",
                      }),
                    ),
                    code: Schema.String,
                    message: Schema.String,
                  }),
                ).annotate({
                  description: "Per-segment failures when a separate export partially succeeds.",
                }),
              ),
              sizeBytes: Schema.Number.annotate({ format: "int64" })
                .check(Schema.isInt().annotate({ expected: "an integer" }))
                .check(
                  Schema.isGreaterThanOrEqualTo(0).annotate({
                    expected: "a value greater than or equal to 0",
                  }),
                ),
              retainUntil: Schema.String.annotate({ format: "date-time" }),
              destinationId: Schema.optionalKey(Schema.String),
              destinationKind: Schema.optionalKey(
                Schema.Literals(["download", "archive", "source_adjacent"]),
              ),
              appliedStrategies: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    segment: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(1).annotate({
                        expected: "a value greater than or equal to 1",
                      }),
                    ),
                    outputName: Schema.optionalKey(
                      Schema.String.annotate({
                        description: "Published separate-export filename, never a filesystem path.",
                      }),
                    ),
                    strategy: Schema.String,
                  }),
                ).annotate({
                  description:
                    "Strategy used for each selected segment; outputName identifies separately published outputs.",
                }),
              ),
            }).annotate({ description: "Present only when an export job succeeded." }),
          ),
          strategy: Schema.optionalKey(
            Schema.String.annotate({ description: "Requested cut strategy." }),
          ),
          container: Schema.optionalKey(
            Schema.Literals(["mkv", "mp4", "mov"]).annotate({
              description: "Requested output container.",
            }),
          ),
          mode: Schema.optionalKey(
            Schema.Literals(["merge", "separate"]).annotate({
              description: "Requested output arrangement.",
            }),
          ),
          selection: Schema.optionalKey(
            Schema.Literals(["segments", "gaps"]).annotate({
              description: "Requested ranges (included cuts or gaps between cuts).",
            }),
          ),
          selectedStreams: Schema.optionalKey(
            Schema.Array(
              Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              ),
            ).annotate({ description: "Resolved stream indexes used by the export job." }),
          ),
          appliedStrategy: Schema.optionalKey(
            Schema.String.annotate({
              description:
                "Strategy used by every selected segment; omitted when segments use different strategies. See result.appliedStrategies for per-segment values.",
            }),
          ),
          warnings: Schema.optionalKey(Schema.Array(Schema.String)),
          warningDetails: Schema.optionalKey(
            Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  severity: Schema.String,
                  code: Schema.String,
                  message: Schema.String,
                  streamIndex: Schema.optionalKey(
                    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                      Schema.isGreaterThanOrEqualTo(0).annotate({
                        expected: "a value greater than or equal to 0",
                      }),
                    ),
                  ),
                }),
                [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
              ),
            ),
          ),
          verified: Schema.optionalKey(
            Schema.Boolean.annotate({
              description: "False when the output requires human inspection.",
            }),
          ),
          errorCode: Schema.optionalKey(
            Schema.String.annotate({
              description: "Stable export failure code; present only when state is failed.",
            }),
          ),
          createdAt: Schema.String.annotate({ format: "date-time" }),
          updatedAt: Schema.String.annotate({ format: "date-time" }),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "BatchExportSubmission" });
export type BatchPage = {
  readonly items: ReadonlyArray<
    {
      readonly batchId: string;
      readonly projectId?: string;
      readonly projectRevision?: number;
      readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      readonly progress: number;
      readonly jobs: ReadonlyArray<
        {
          readonly id: string;
          readonly batchId?: string;
          readonly projectItemId?: string;
          readonly mediaLabel?: string;
          readonly mediaId?: string;
          readonly projectId?: string;
          readonly projectRevision?: number;
          readonly kind?: string;
          readonly type: "export" | "detection" | "library_scan";
          readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
          readonly revision: number;
          readonly progress?: number;
          readonly result?: {
            readonly container?: "mkv" | "mp4" | "mov";
            readonly outputName?: string;
            readonly outputNames?: ReadonlyArray<string>;
            readonly outputFailures?: ReadonlyArray<{
              readonly segment: number;
              readonly code: string;
              readonly message: string;
            }>;
            readonly sizeBytes: number;
            readonly retainUntil: string;
            readonly destinationId?: string;
            readonly destinationKind?: "download" | "archive" | "source_adjacent";
            readonly appliedStrategies?: ReadonlyArray<{
              readonly segment: number;
              readonly outputName?: string;
              readonly strategy: string;
            }>;
          };
          readonly strategy?: string;
          readonly container?: "mkv" | "mp4" | "mov";
          readonly mode?: "merge" | "separate";
          readonly selection?: "segments" | "gaps";
          readonly selectedStreams?: ReadonlyArray<number>;
          readonly appliedStrategy?: string;
          readonly warnings?: ReadonlyArray<string>;
          readonly warningDetails?: ReadonlyArray<
            {
              readonly severity: string;
              readonly code: string;
              readonly message: string;
              readonly streamIndex?: number;
            } & { readonly [x: string]: Schema.Json }
          >;
          readonly verified?: boolean;
          readonly errorCode?: string;
          readonly createdAt: string;
          readonly updatedAt: string;
        } & { readonly [x: string]: Schema.Json }
      >;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly nextCursor: string | null;
} & { readonly [x: string]: Schema.Json };
export const BatchPage = Schema.StructWithRest(
  Schema.Struct({
    items: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          batchId: Schema.String,
          projectId: Schema.optionalKey(Schema.String),
          projectRevision: Schema.optionalKey(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
              Schema.isGreaterThanOrEqualTo(1).annotate({
                expected: "a value greater than or equal to 1",
              }),
            ),
          ),
          state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
          progress: Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
            .check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            )
            .check(
              Schema.isLessThanOrEqualTo(1).annotate({
                expected: "a value less than or equal to 1",
              }),
            ),
          jobs: Schema.Array(
            Schema.StructWithRest(
              Schema.Struct({
                id: Schema.String,
                batchId: Schema.optionalKey(Schema.String),
                projectItemId: Schema.optionalKey(Schema.String),
                mediaLabel: Schema.optionalKey(Schema.String),
                mediaId: Schema.optionalKey(Schema.String),
                projectId: Schema.optionalKey(Schema.String),
                projectRevision: Schema.optionalKey(
                  Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
                ),
                kind: Schema.optionalKey(Schema.String),
                type: Schema.Literals(["export", "detection", "library_scan"]),
                state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
                revision: Schema.Number.check(
                  Schema.isInt().annotate({ expected: "an integer" }),
                ).check(
                  Schema.isGreaterThanOrEqualTo(1).annotate({
                    expected: "a value greater than or equal to 1",
                  }),
                ),
                progress: Schema.optionalKey(
                  Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
                    .check(
                      Schema.isGreaterThanOrEqualTo(0).annotate({
                        expected: "a value greater than or equal to 0",
                      }),
                    )
                    .check(
                      Schema.isLessThanOrEqualTo(1).annotate({
                        expected: "a value less than or equal to 1",
                      }),
                    ),
                ),
                result: Schema.optionalKey(
                  Schema.Struct({
                    container: Schema.optionalKey(
                      Schema.Literals(["mkv", "mp4", "mov"]).annotate({
                        description: "Published output container.",
                      }),
                    ),
                    outputName: Schema.optionalKey(
                      Schema.String.annotate({
                        description: "Published merged-export filename, never a filesystem path.",
                      }),
                    ),
                    outputNames: Schema.optionalKey(
                      Schema.Array(Schema.String).annotate({
                        description: "Published separate-export filenames, never filesystem paths.",
                      }),
                    ),
                    outputFailures: Schema.optionalKey(
                      Schema.Array(
                        Schema.Struct({
                          segment: Schema.Number.check(
                            Schema.isInt().annotate({ expected: "an integer" }),
                          ).check(
                            Schema.isGreaterThanOrEqualTo(1).annotate({
                              expected: "a value greater than or equal to 1",
                            }),
                          ),
                          code: Schema.String,
                          message: Schema.String,
                        }),
                      ).annotate({
                        description:
                          "Per-segment failures when a separate export partially succeeds.",
                      }),
                    ),
                    sizeBytes: Schema.Number.annotate({ format: "int64" })
                      .check(Schema.isInt().annotate({ expected: "an integer" }))
                      .check(
                        Schema.isGreaterThanOrEqualTo(0).annotate({
                          expected: "a value greater than or equal to 0",
                        }),
                      ),
                    retainUntil: Schema.String.annotate({ format: "date-time" }),
                    destinationId: Schema.optionalKey(Schema.String),
                    destinationKind: Schema.optionalKey(
                      Schema.Literals(["download", "archive", "source_adjacent"]),
                    ),
                    appliedStrategies: Schema.optionalKey(
                      Schema.Array(
                        Schema.Struct({
                          segment: Schema.Number.check(
                            Schema.isInt().annotate({ expected: "an integer" }),
                          ).check(
                            Schema.isGreaterThanOrEqualTo(1).annotate({
                              expected: "a value greater than or equal to 1",
                            }),
                          ),
                          outputName: Schema.optionalKey(
                            Schema.String.annotate({
                              description:
                                "Published separate-export filename, never a filesystem path.",
                            }),
                          ),
                          strategy: Schema.String,
                        }),
                      ).annotate({
                        description:
                          "Strategy used for each selected segment; outputName identifies separately published outputs.",
                      }),
                    ),
                  }).annotate({ description: "Present only when an export job succeeded." }),
                ),
                strategy: Schema.optionalKey(
                  Schema.String.annotate({ description: "Requested cut strategy." }),
                ),
                container: Schema.optionalKey(
                  Schema.Literals(["mkv", "mp4", "mov"]).annotate({
                    description: "Requested output container.",
                  }),
                ),
                mode: Schema.optionalKey(
                  Schema.Literals(["merge", "separate"]).annotate({
                    description: "Requested output arrangement.",
                  }),
                ),
                selection: Schema.optionalKey(
                  Schema.Literals(["segments", "gaps"]).annotate({
                    description: "Requested ranges (included cuts or gaps between cuts).",
                  }),
                ),
                selectedStreams: Schema.optionalKey(
                  Schema.Array(
                    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                      Schema.isGreaterThanOrEqualTo(0).annotate({
                        expected: "a value greater than or equal to 0",
                      }),
                    ),
                  ).annotate({ description: "Resolved stream indexes used by the export job." }),
                ),
                appliedStrategy: Schema.optionalKey(
                  Schema.String.annotate({
                    description:
                      "Strategy used by every selected segment; omitted when segments use different strategies. See result.appliedStrategies for per-segment values.",
                  }),
                ),
                warnings: Schema.optionalKey(Schema.Array(Schema.String)),
                warningDetails: Schema.optionalKey(
                  Schema.Array(
                    Schema.StructWithRest(
                      Schema.Struct({
                        severity: Schema.String,
                        code: Schema.String,
                        message: Schema.String,
                        streamIndex: Schema.optionalKey(
                          Schema.Number.check(
                            Schema.isInt().annotate({ expected: "an integer" }),
                          ).check(
                            Schema.isGreaterThanOrEqualTo(0).annotate({
                              expected: "a value greater than or equal to 0",
                            }),
                          ),
                        ),
                      }),
                      [
                        Schema.Record(
                          Schema.String,
                          Schema.Json.annotate({ expected: "JSON value" }),
                        ),
                      ],
                    ),
                  ),
                ),
                verified: Schema.optionalKey(
                  Schema.Boolean.annotate({
                    description: "False when the output requires human inspection.",
                  }),
                ),
                errorCode: Schema.optionalKey(
                  Schema.String.annotate({
                    description: "Stable export failure code; present only when state is failed.",
                  }),
                ),
                createdAt: Schema.String.annotate({ format: "date-time" }),
                updatedAt: Schema.String.annotate({ format: "date-time" }),
              }),
              [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
            ),
          ),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    nextCursor: Schema.Union([Schema.String, Schema.Null]),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "BatchPage" });
export type Batch = {
  readonly batchId: string;
  readonly projectId?: string;
  readonly projectRevision?: number;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: number;
  readonly jobs: ReadonlyArray<
    {
      readonly id: string;
      readonly batchId?: string;
      readonly projectItemId?: string;
      readonly mediaLabel?: string;
      readonly mediaId?: string;
      readonly projectId?: string;
      readonly projectRevision?: number;
      readonly kind?: string;
      readonly type: "export" | "detection" | "library_scan";
      readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      readonly revision: number;
      readonly progress?: number;
      readonly result?: {
        readonly container?: "mkv" | "mp4" | "mov";
        readonly outputName?: string;
        readonly outputNames?: ReadonlyArray<string>;
        readonly outputFailures?: ReadonlyArray<{
          readonly segment: number;
          readonly code: string;
          readonly message: string;
        }>;
        readonly sizeBytes: number;
        readonly retainUntil: string;
        readonly destinationId?: string;
        readonly destinationKind?: "download" | "archive" | "source_adjacent";
        readonly appliedStrategies?: ReadonlyArray<{
          readonly segment: number;
          readonly outputName?: string;
          readonly strategy: string;
        }>;
      };
      readonly strategy?: string;
      readonly container?: "mkv" | "mp4" | "mov";
      readonly mode?: "merge" | "separate";
      readonly selection?: "segments" | "gaps";
      readonly selectedStreams?: ReadonlyArray<number>;
      readonly appliedStrategy?: string;
      readonly warnings?: ReadonlyArray<string>;
      readonly warningDetails?: ReadonlyArray<
        {
          readonly severity: string;
          readonly code: string;
          readonly message: string;
          readonly streamIndex?: number;
        } & { readonly [x: string]: Schema.Json }
      >;
      readonly verified?: boolean;
      readonly errorCode?: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    } & { readonly [x: string]: Schema.Json }
  >;
} & { readonly [x: string]: Schema.Json };
export const Batch = Schema.StructWithRest(
  Schema.Struct({
    batchId: Schema.String,
    projectId: Schema.optionalKey(Schema.String),
    projectRevision: Schema.optionalKey(
      Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      ),
    ),
    state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
    progress: Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
      .check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(1).annotate({ expected: "a value less than or equal to 1" }),
      ),
    jobs: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.String,
          batchId: Schema.optionalKey(Schema.String),
          projectItemId: Schema.optionalKey(Schema.String),
          mediaLabel: Schema.optionalKey(Schema.String),
          mediaId: Schema.optionalKey(Schema.String),
          projectId: Schema.optionalKey(Schema.String),
          projectRevision: Schema.optionalKey(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          ),
          kind: Schema.optionalKey(Schema.String),
          type: Schema.Literals(["export", "detection", "library_scan"]),
          state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
          revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
            Schema.isGreaterThanOrEqualTo(1).annotate({
              expected: "a value greater than or equal to 1",
            }),
          ),
          progress: Schema.optionalKey(
            Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
              .check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              )
              .check(
                Schema.isLessThanOrEqualTo(1).annotate({
                  expected: "a value less than or equal to 1",
                }),
              ),
          ),
          result: Schema.optionalKey(
            Schema.Struct({
              container: Schema.optionalKey(
                Schema.Literals(["mkv", "mp4", "mov"]).annotate({
                  description: "Published output container.",
                }),
              ),
              outputName: Schema.optionalKey(
                Schema.String.annotate({
                  description: "Published merged-export filename, never a filesystem path.",
                }),
              ),
              outputNames: Schema.optionalKey(
                Schema.Array(Schema.String).annotate({
                  description: "Published separate-export filenames, never filesystem paths.",
                }),
              ),
              outputFailures: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    segment: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(1).annotate({
                        expected: "a value greater than or equal to 1",
                      }),
                    ),
                    code: Schema.String,
                    message: Schema.String,
                  }),
                ).annotate({
                  description: "Per-segment failures when a separate export partially succeeds.",
                }),
              ),
              sizeBytes: Schema.Number.annotate({ format: "int64" })
                .check(Schema.isInt().annotate({ expected: "an integer" }))
                .check(
                  Schema.isGreaterThanOrEqualTo(0).annotate({
                    expected: "a value greater than or equal to 0",
                  }),
                ),
              retainUntil: Schema.String.annotate({ format: "date-time" }),
              destinationId: Schema.optionalKey(Schema.String),
              destinationKind: Schema.optionalKey(
                Schema.Literals(["download", "archive", "source_adjacent"]),
              ),
              appliedStrategies: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    segment: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(1).annotate({
                        expected: "a value greater than or equal to 1",
                      }),
                    ),
                    outputName: Schema.optionalKey(
                      Schema.String.annotate({
                        description: "Published separate-export filename, never a filesystem path.",
                      }),
                    ),
                    strategy: Schema.String,
                  }),
                ).annotate({
                  description:
                    "Strategy used for each selected segment; outputName identifies separately published outputs.",
                }),
              ),
            }).annotate({ description: "Present only when an export job succeeded." }),
          ),
          strategy: Schema.optionalKey(
            Schema.String.annotate({ description: "Requested cut strategy." }),
          ),
          container: Schema.optionalKey(
            Schema.Literals(["mkv", "mp4", "mov"]).annotate({
              description: "Requested output container.",
            }),
          ),
          mode: Schema.optionalKey(
            Schema.Literals(["merge", "separate"]).annotate({
              description: "Requested output arrangement.",
            }),
          ),
          selection: Schema.optionalKey(
            Schema.Literals(["segments", "gaps"]).annotate({
              description: "Requested ranges (included cuts or gaps between cuts).",
            }),
          ),
          selectedStreams: Schema.optionalKey(
            Schema.Array(
              Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              ),
            ).annotate({ description: "Resolved stream indexes used by the export job." }),
          ),
          appliedStrategy: Schema.optionalKey(
            Schema.String.annotate({
              description:
                "Strategy used by every selected segment; omitted when segments use different strategies. See result.appliedStrategies for per-segment values.",
            }),
          ),
          warnings: Schema.optionalKey(Schema.Array(Schema.String)),
          warningDetails: Schema.optionalKey(
            Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  severity: Schema.String,
                  code: Schema.String,
                  message: Schema.String,
                  streamIndex: Schema.optionalKey(
                    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                      Schema.isGreaterThanOrEqualTo(0).annotate({
                        expected: "a value greater than or equal to 0",
                      }),
                    ),
                  ),
                }),
                [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
              ),
            ),
          ),
          verified: Schema.optionalKey(
            Schema.Boolean.annotate({
              description: "False when the output requires human inspection.",
            }),
          ),
          errorCode: Schema.optionalKey(
            Schema.String.annotate({
              description: "Stable export failure code; present only when state is failed.",
            }),
          ),
          createdAt: Schema.String.annotate({ format: "date-time" }),
          updatedAt: Schema.String.annotate({ format: "date-time" }),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Batch" });
export type ExportInput = {
  readonly mode: "merge" | "separate";
  readonly selection: "segments" | "gaps";
  readonly streamIndexes?: ReadonlyArray<number>;
  readonly cutStrategy: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
  readonly container: "mkv" | "mp4" | "mov";
  readonly destinationId?: string;
  readonly filenameTemplate?: string;
  readonly itemIds?: ReadonlyArray<string>;
};
export const ExportInput = Schema.Struct({
  mode: Schema.Literals(["merge", "separate"]),
  selection: Schema.Literals(["segments", "gaps"]).annotate({ default: "segments" }),
  streamIndexes: Schema.optionalKey(
    Schema.Array(
      Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      ),
    ).check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
  ),
  cutStrategy: Schema.Literals(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]),
  container: Schema.Literals(["mkv", "mp4", "mov"]),
  destinationId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Opaque configured destination ID; never a filesystem path.",
    }).check(
      Schema.isMaxCodePoints(64).annotate({ expected: "a string with at most 64 code points" }),
    ),
  ),
  filenameTemplate: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Restricted template using documented variables only, at most 160 UTF-8 bytes. Standard maxLength counts Unicode characters rather than bytes, so the server enforces this bound.",
    }),
  ),
  itemIds: Schema.optionalKey(
    Schema.Array(Schema.String)
      .annotate({ description: "Optional ordered project-item selection; omitted selects all." })
      .check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
  ),
}).annotate({ identifier: "ExportInput" });
export type ExportPreflight = {
  readonly allowed: boolean;
  readonly selection: ReadonlyArray<number>;
  readonly findings: ReadonlyArray<
    {
      readonly severity: "allowed" | "warn" | "blocked";
      readonly code: string;
      readonly message: string;
      readonly streamIndex?: number;
    } & { readonly [x: string]: Schema.Json }
  >;
} & { readonly [x: string]: Schema.Json };
export const ExportPreflight = Schema.StructWithRest(
  Schema.Struct({
    allowed: Schema.Boolean,
    selection: Schema.Array(
      Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      ),
    ),
    findings: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          severity: Schema.Literals(["allowed", "warn", "blocked"]),
          code: Schema.String,
          message: Schema.String,
          streamIndex: Schema.optionalKey(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
          ),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "ExportPreflight" });
export type Destination = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: "download" | "archive" | "source_adjacent";
  readonly retention?: string;
} & { readonly [x: string]: Schema.Json };
export const Destination = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    description: Schema.optionalKey(Schema.String),
    kind: Schema.Literals(["download", "archive", "source_adjacent"]),
    retention: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Destination" });
export type DestinationCapabilities = { readonly saveBesideSource: boolean } & {
  readonly [x: string]: Schema.Json;
};
export const DestinationCapabilities = Schema.StructWithRest(
  Schema.Struct({
    saveBesideSource: Schema.Boolean.annotate({
      description:
        "True only when deployment configuration explicitly includes a source_adjacent destination. No filesystem path is exposed.",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "DestinationCapabilities" });
export type Job = {
  readonly id: string;
  readonly batchId?: string;
  readonly projectItemId?: string;
  readonly mediaLabel?: string;
  readonly mediaId?: string;
  readonly projectId?: string;
  readonly projectRevision?: number;
  readonly kind?: string;
  readonly type: "export" | "detection" | "library_scan";
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly revision: number;
  readonly progress?: number;
  readonly result?: {
    readonly container?: "mkv" | "mp4" | "mov";
    readonly outputName?: string;
    readonly outputNames?: ReadonlyArray<string>;
    readonly outputFailures?: ReadonlyArray<{
      readonly segment: number;
      readonly code: string;
      readonly message: string;
    }>;
    readonly sizeBytes: number;
    readonly retainUntil: string;
    readonly destinationId?: string;
    readonly destinationKind?: "download" | "archive" | "source_adjacent";
    readonly appliedStrategies?: ReadonlyArray<{
      readonly segment: number;
      readonly outputName?: string;
      readonly strategy: string;
    }>;
  };
  readonly strategy?: string;
  readonly container?: "mkv" | "mp4" | "mov";
  readonly mode?: "merge" | "separate";
  readonly selection?: "segments" | "gaps";
  readonly selectedStreams?: ReadonlyArray<number>;
  readonly appliedStrategy?: string;
  readonly warnings?: ReadonlyArray<string>;
  readonly warningDetails?: ReadonlyArray<
    {
      readonly severity: string;
      readonly code: string;
      readonly message: string;
      readonly streamIndex?: number;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly verified?: boolean;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} & { readonly [x: string]: Schema.Json };
export const Job = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    batchId: Schema.optionalKey(Schema.String),
    projectItemId: Schema.optionalKey(Schema.String),
    mediaLabel: Schema.optionalKey(Schema.String),
    mediaId: Schema.optionalKey(Schema.String),
    projectId: Schema.optionalKey(Schema.String),
    projectRevision: Schema.optionalKey(
      Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    ),
    kind: Schema.optionalKey(Schema.String),
    type: Schema.Literals(["export", "detection", "library_scan"]),
    state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
    revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
      Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
    ),
    progress: Schema.optionalKey(
      Schema.Number.check(Schema.isFinite().annotate({ expected: "a finite number" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(1).annotate({ expected: "a value less than or equal to 1" }),
        ),
    ),
    result: Schema.optionalKey(
      Schema.Struct({
        container: Schema.optionalKey(
          Schema.Literals(["mkv", "mp4", "mov"]).annotate({
            description: "Published output container.",
          }),
        ),
        outputName: Schema.optionalKey(
          Schema.String.annotate({
            description: "Published merged-export filename, never a filesystem path.",
          }),
        ),
        outputNames: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Published separate-export filenames, never filesystem paths.",
          }),
        ),
        outputFailures: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              segment: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ).check(
                Schema.isGreaterThanOrEqualTo(1).annotate({
                  expected: "a value greater than or equal to 1",
                }),
              ),
              code: Schema.String,
              message: Schema.String,
            }),
          ).annotate({
            description: "Per-segment failures when a separate export partially succeeds.",
          }),
        ),
        sizeBytes: Schema.Number.annotate({ format: "int64" })
          .check(Schema.isInt().annotate({ expected: "an integer" }))
          .check(
            Schema.isGreaterThanOrEqualTo(0).annotate({
              expected: "a value greater than or equal to 0",
            }),
          ),
        retainUntil: Schema.String.annotate({ format: "date-time" }),
        destinationId: Schema.optionalKey(Schema.String),
        destinationKind: Schema.optionalKey(
          Schema.Literals(["download", "archive", "source_adjacent"]),
        ),
        appliedStrategies: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              segment: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ).check(
                Schema.isGreaterThanOrEqualTo(1).annotate({
                  expected: "a value greater than or equal to 1",
                }),
              ),
              outputName: Schema.optionalKey(
                Schema.String.annotate({
                  description: "Published separate-export filename, never a filesystem path.",
                }),
              ),
              strategy: Schema.String,
            }),
          ).annotate({
            description:
              "Strategy used for each selected segment; outputName identifies separately published outputs.",
          }),
        ),
      }).annotate({ description: "Present only when an export job succeeded." }),
    ),
    strategy: Schema.optionalKey(
      Schema.String.annotate({ description: "Requested cut strategy." }),
    ),
    container: Schema.optionalKey(
      Schema.Literals(["mkv", "mp4", "mov"]).annotate({
        description: "Requested output container.",
      }),
    ),
    mode: Schema.optionalKey(
      Schema.Literals(["merge", "separate"]).annotate({
        description: "Requested output arrangement.",
      }),
    ),
    selection: Schema.optionalKey(
      Schema.Literals(["segments", "gaps"]).annotate({
        description: "Requested ranges (included cuts or gaps between cuts).",
      }),
    ),
    selectedStreams: Schema.optionalKey(
      Schema.Array(
        Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      ).annotate({ description: "Resolved stream indexes used by the export job." }),
    ),
    appliedStrategy: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Strategy used by every selected segment; omitted when segments use different strategies. See result.appliedStrategies for per-segment values.",
      }),
    ),
    warnings: Schema.optionalKey(Schema.Array(Schema.String)),
    warningDetails: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            severity: Schema.String,
            code: Schema.String,
            message: Schema.String,
            streamIndex: Schema.optionalKey(
              Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                Schema.isGreaterThanOrEqualTo(0).annotate({
                  expected: "a value greater than or equal to 0",
                }),
              ),
            ),
          }),
          [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
        ),
      ),
    ),
    verified: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "False when the output requires human inspection." }),
    ),
    errorCode: Schema.optionalKey(
      Schema.String.annotate({
        description: "Stable export failure code; present only when state is failed.",
      }),
    ),
    createdAt: Schema.String.annotate({ format: "date-time" }),
    updatedAt: Schema.String.annotate({ format: "date-time" }),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "Job" });
export type SettingsResponse = {
  readonly settings: {
    readonly destinations?: ReadonlyArray<
      {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly kind: "download" | "archive" | "source_adjacent";
        readonly retention?: string;
      } & { readonly [x: string]: Schema.Json }
    >;
    readonly exportLimit: number;
    readonly cacheMaxBytes: number;
    readonly previewGlobalLimit: number;
    readonly previewBeforeMs: number;
    readonly previewAfterMs: number;
    readonly previewMaxMs: number;
    readonly previewGridMs: number;
    readonly mediaMaxFiles: number;
    readonly mediaMaxDepth: number;
    readonly mcpEnabled: boolean;
  };
  readonly revision: number;
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly pathsConstrained: boolean;
  readonly roots: {
    readonly [x: string]: {
      readonly state?: "ready" | "unavailable";
      readonly message?: string;
    } & { readonly [x: string]: Schema.Json };
  };
} & { readonly [x: string]: Schema.Json };
export const SettingsResponse = Schema.StructWithRest(
  Schema.Struct({
    settings: Schema.Struct({
      destinations: Schema.optionalKey(
        Schema.Array(
          Schema.StructWithRest(
            Schema.Struct({
              id: Schema.String,
              label: Schema.String,
              description: Schema.optionalKey(Schema.String),
              kind: Schema.Literals(["download", "archive", "source_adjacent"]),
              retention: Schema.optionalKey(Schema.String),
            }),
            [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
          ),
        ),
      ),
      exportLimit: Schema.Number.annotate({
        description:
          "Live shared scheduler worker limit for export, detection, and library scan jobs. 64 is a safety ceiling, not recommended concurrency. Admission allows at most four times this limit in queued/running jobs. Increases allow more workers immediately. Decreases do not cancel active jobs or discard queued work; excess workers retire after their current job and queued work drains at the new limit.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(1).annotate({
            expected: "a value greater than or equal to 1",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
        ),
      cacheMaxBytes: Schema.Number.annotate({
        description:
          "Combined cache disk budget, partitioned between preview clips (three quarters) and timeline assets (one quarter), with at least one byte per partition. Completed entries are evicted on publication; oversized artifacts cannot be published.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(2).annotate({
            expected: "a value greater than or equal to 2",
          }),
        ),
      previewGlobalLimit: Schema.Number.annotate({
        description:
          "Limits concurrent media processes immediately and MCP request capacity on the next server startup. 64 is a safety ceiling, not recommended concurrency.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(1).annotate({
            expected: "a value greater than or equal to 1",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
        ),
      previewBeforeMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewAfterMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewMaxMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewGridMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mediaMaxFiles: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mediaMaxDepth: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mcpEnabled: Schema.Boolean,
    }),
    revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    schemaVersion: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    updatedAt: Schema.String.annotate({ format: "date-time" }),
    pathsConstrained: Schema.Boolean,
    roots: Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          state: Schema.optionalKey(Schema.Literals(["ready", "unavailable"])),
          message: Schema.optionalKey(Schema.String),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "SettingsResponse" });
export type SettingsUpdate = {
  readonly revision: number;
  readonly settings: {
    readonly destinations?: ReadonlyArray<
      {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly kind: "download" | "archive" | "source_adjacent";
        readonly retention?: string;
      } & { readonly [x: string]: Schema.Json }
    >;
    readonly exportLimit: number;
    readonly cacheMaxBytes: number;
    readonly previewGlobalLimit: number;
    readonly previewBeforeMs: number;
    readonly previewAfterMs: number;
    readonly previewMaxMs: number;
    readonly previewGridMs: number;
    readonly mediaMaxFiles: number;
    readonly mediaMaxDepth: number;
    readonly mcpEnabled: boolean;
  };
};
export const SettingsUpdate = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
    Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
  ),
  settings: Schema.Struct({
    destinations: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            id: Schema.String,
            label: Schema.String,
            description: Schema.optionalKey(Schema.String),
            kind: Schema.Literals(["download", "archive", "source_adjacent"]),
            retention: Schema.optionalKey(Schema.String),
          }),
          [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
        ),
      ),
    ),
    exportLimit: Schema.Number.annotate({
      description:
        "Live shared scheduler worker limit for export, detection, and library scan jobs. 64 is a safety ceiling, not recommended concurrency. Admission allows at most four times this limit in queued/running jobs. Increases allow more workers immediately. Decreases do not cancel active jobs or discard queued work; excess workers retire after their current job and queued work drains at the new limit.",
    })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
      ),
    cacheMaxBytes: Schema.Number.annotate({
      description:
        "Combined cache disk budget, partitioned between preview clips (three quarters) and timeline assets (one quarter), with at least one byte per partition. Completed entries are evicted on publication; oversized artifacts cannot be published.",
    })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(2).annotate({
          expected: "a value greater than or equal to 2",
        }),
      ),
    previewGlobalLimit: Schema.Number.annotate({
      description:
        "Limits concurrent media processes immediately and MCP request capacity on the next server startup. 64 is a safety ceiling, not recommended concurrency.",
    })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
      )
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
      ),
    previewBeforeMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    previewAfterMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    previewMaxMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    previewGridMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    mediaMaxFiles: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    mediaMaxDepth: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    mcpEnabled: Schema.Boolean,
  }),
}).annotate({ identifier: "SettingsUpdate" });
export type SettingsUpdated = {
  readonly settings: {
    readonly destinations?: ReadonlyArray<
      {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly kind: "download" | "archive" | "source_adjacent";
        readonly retention?: string;
      } & { readonly [x: string]: Schema.Json }
    >;
    readonly exportLimit: number;
    readonly cacheMaxBytes: number;
    readonly previewGlobalLimit: number;
    readonly previewBeforeMs: number;
    readonly previewAfterMs: number;
    readonly previewMaxMs: number;
    readonly previewGridMs: number;
    readonly mediaMaxFiles: number;
    readonly mediaMaxDepth: number;
    readonly mcpEnabled: boolean;
  };
  readonly revision: number;
  readonly schemaVersion: number;
  readonly updatedAt: string;
} & { readonly [x: string]: Schema.Json };
export const SettingsUpdated = Schema.StructWithRest(
  Schema.Struct({
    settings: Schema.Struct({
      destinations: Schema.optionalKey(
        Schema.Array(
          Schema.StructWithRest(
            Schema.Struct({
              id: Schema.String,
              label: Schema.String,
              description: Schema.optionalKey(Schema.String),
              kind: Schema.Literals(["download", "archive", "source_adjacent"]),
              retention: Schema.optionalKey(Schema.String),
            }),
            [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
          ),
        ),
      ),
      exportLimit: Schema.Number.annotate({
        description:
          "Live shared scheduler worker limit for export, detection, and library scan jobs. 64 is a safety ceiling, not recommended concurrency. Admission allows at most four times this limit in queued/running jobs. Increases allow more workers immediately. Decreases do not cancel active jobs or discard queued work; excess workers retire after their current job and queued work drains at the new limit.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(1).annotate({
            expected: "a value greater than or equal to 1",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
        ),
      cacheMaxBytes: Schema.Number.annotate({
        description:
          "Combined cache disk budget, partitioned between preview clips (three quarters) and timeline assets (one quarter), with at least one byte per partition. Completed entries are evicted on publication; oversized artifacts cannot be published.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(2).annotate({
            expected: "a value greater than or equal to 2",
          }),
        ),
      previewGlobalLimit: Schema.Number.annotate({
        description:
          "Limits concurrent media processes immediately and MCP request capacity on the next server startup. 64 is a safety ceiling, not recommended concurrency.",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(1).annotate({
            expected: "a value greater than or equal to 1",
          }),
        )
        .check(
          Schema.isLessThanOrEqualTo(64).annotate({ expected: "a value less than or equal to 64" }),
        ),
      previewBeforeMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewAfterMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewMaxMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      previewGridMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mediaMaxFiles: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mediaMaxDepth: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
      mcpEnabled: Schema.Boolean,
    }),
    revision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
      Schema.isGreaterThanOrEqualTo(1).annotate({ expected: "a value greater than or equal to 1" }),
    ),
    schemaVersion: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    updatedAt: Schema.String.annotate({ format: "date-time" }),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "SettingsUpdated" });
export type MCPSettingsResponse = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly authentication: string;
  readonly remoteAccessGuidance: string;
  readonly clientCompatibility: string;
  readonly permissions: ReadonlyArray<string>;
  readonly roots: ReadonlyArray<
    { readonly id: string; readonly label: string } & { readonly [x: string]: Schema.Json }
  >;
  readonly credentials: ReadonlyArray<{
    readonly id: string;
    readonly tokenIdentifier: string;
    readonly name: string;
    readonly permissions: ReadonlyArray<string>;
    readonly mediaScope: {
      readonly kind: "all" | "roots" | "media";
      readonly rootIds?: ReadonlyArray<string>;
      readonly mediaIds?: ReadonlyArray<string>;
    };
    readonly projectScope: {
      readonly kind: "all" | "projects";
      readonly projectIds?: ReadonlyArray<string>;
    };
    readonly expiresAt?: string;
    readonly revokedAt?: string;
    readonly unattendedExports: boolean;
    readonly createdAt: string;
    readonly lastUsedAt?: string;
    readonly status?: "active" | "expired" | "revoked";
  }>;
  readonly proposals: ReadonlyArray<
    {
      readonly id: string;
      readonly credentialId: string;
      readonly projectId?: string;
      readonly projectRevision: number;
      readonly mediaId?: string;
      readonly snapshots: ReadonlyArray<
        {
          readonly projectRevision: number;
          readonly mediaLabel: string;
          readonly item: {
            readonly id: string;
            readonly mediaId: string;
            readonly segments: ReadonlyArray<{
              readonly id?: string;
              readonly startMs: number;
              readonly endMs: number;
              readonly label?: string;
              readonly included?: boolean;
            }>;
            readonly editorState?: {
              readonly playheadMs: number;
              readonly zoom: number;
              readonly muted: boolean;
            } & { readonly [x: string]: Schema.Json };
            readonly exportOptions: {
              readonly mode?: "merge" | "separate";
              readonly selection?: "segments" | "gaps";
              readonly streamIndexes?: ReadonlyArray<number>;
              readonly cutStrategy?:
                | "stream_copy_preferred"
                | "precise_reencode"
                | "hybrid_smart_cut";
              readonly container?: "mkv" | "mp4" | "mov";
              readonly destinationId?: string;
              readonly filenameTemplate?: string;
            };
          };
          readonly source: {
            readonly mediaId: string;
            readonly rootId?: string;
            readonly etag: string;
            readonly sizeBytes: number;
            readonly durationMs: number;
          } & { readonly [x: string]: Schema.Json };
        } & { readonly [x: string]: Schema.Json }
      >;
      readonly findings: ReadonlyArray<
        {
          readonly severity: "allowed" | "warn" | "blocked";
          readonly code: string;
          readonly message: string;
          readonly streamIndex?: number;
        } & { readonly [x: string]: Schema.Json }
      >;
      readonly allowed: boolean;
      readonly requiresReencoding: boolean;
      readonly accuracy: "frame_exact" | "keyframe_limited" | "mixed";
      readonly destinationId: string;
      readonly expiresAt: string;
      readonly approvedAt?: string;
      readonly createdAt: string;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly nextCursor?: string;
  readonly proposalNextCursor?: string;
};
export const MCPSettingsResponse = Schema.Struct({
  enabled: Schema.Boolean,
  endpoint: Schema.String,
  authentication: Schema.String,
  remoteAccessGuidance: Schema.String,
  clientCompatibility: Schema.String,
  permissions: Schema.Array(Schema.String),
  roots: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ id: Schema.String, label: Schema.String }), [
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
    ]),
  ),
  credentials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tokenIdentifier: Schema.String,
      name: Schema.String,
      permissions: Schema.Array(Schema.String),
      mediaScope: Schema.Struct({
        kind: Schema.Literals(["all", "roots", "media"]),
        rootIds: Schema.optionalKey(Schema.Array(Schema.String)),
        mediaIds: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      projectScope: Schema.Struct({
        kind: Schema.Literals(["all", "projects"]),
        projectIds: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      expiresAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      revokedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      unattendedExports: Schema.Boolean,
      createdAt: Schema.String.annotate({ format: "date-time" }),
      lastUsedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
      status: Schema.optionalKey(Schema.Literals(["active", "expired", "revoked"])),
    }),
  ),
  proposals: Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({
        id: Schema.String,
        credentialId: Schema.String,
        projectId: Schema.optionalKey(Schema.String),
        projectRevision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
        mediaId: Schema.optionalKey(Schema.String),
        snapshots: Schema.Array(
          Schema.StructWithRest(
            Schema.Struct({
              projectRevision: Schema.Number.check(
                Schema.isInt().annotate({ expected: "an integer" }),
              ),
              mediaLabel: Schema.String,
              item: Schema.Struct({
                id: Schema.String.check(
                  Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
                    expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
                  }),
                ),
                mediaId: Schema.String.check(
                  Schema.isPattern(new RegExp("^m_[A-Za-z0-9_-]{43}$", "u")).annotate({
                    expected: "a string matching the RegExp ^m_[A-Za-z0-9_-]{43}$",
                  }),
                ),
                segments: Schema.Array(
                  Schema.Struct({
                    id: Schema.optionalKey(
                      Schema.String.check(
                        Schema.isMinLength(1).annotate({
                          expected: "a value with a length of at least 1",
                        }),
                      ).check(
                        Schema.isMaxCodePoints(128).annotate({
                          expected: "a string with at most 128 code points",
                        }),
                      ),
                    ),
                    startMs: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(0).annotate({
                        expected: "a value greater than or equal to 0",
                      }),
                    ),
                    endMs: Schema.Number.check(
                      Schema.isInt().annotate({ expected: "an integer" }),
                    ).check(
                      Schema.isGreaterThanOrEqualTo(1).annotate({
                        expected: "a value greater than or equal to 1",
                      }),
                    ),
                    label: Schema.optionalKey(
                      Schema.String.check(
                        Schema.isMaxCodePoints(200).annotate({
                          expected: "a string with at most 200 code points",
                        }),
                      ),
                    ),
                    included: Schema.optionalKey(Schema.Boolean.annotate({ default: true })),
                  }),
                ),
                editorState: Schema.optionalKey(
                  Schema.StructWithRest(
                    Schema.Struct({
                      playheadMs: Schema.Number.check(
                        Schema.isInt().annotate({ expected: "an integer" }),
                      ).check(
                        Schema.isGreaterThanOrEqualTo(0).annotate({
                          expected: "a value greater than or equal to 0",
                        }),
                      ),
                      zoom: Schema.Number.check(
                        Schema.isFinite().annotate({ expected: "a finite number" }),
                      ).check(
                        Schema.isGreaterThan(0).annotate({ expected: "a value greater than 0" }),
                      ),
                      muted: Schema.Boolean,
                    }),
                    [
                      Schema.Record(
                        Schema.String,
                        Schema.Json.annotate({ expected: "JSON value" }),
                      ),
                    ],
                  ),
                ),
                exportOptions: Schema.Struct({
                  mode: Schema.optionalKey(Schema.Literals(["merge", "separate"])),
                  selection: Schema.optionalKey(Schema.Literals(["segments", "gaps"])),
                  streamIndexes: Schema.optionalKey(
                    Schema.Array(
                      Schema.Number.check(
                        Schema.isInt().annotate({ expected: "an integer" }),
                      ).check(
                        Schema.isGreaterThanOrEqualTo(0).annotate({
                          expected: "a value greater than or equal to 0",
                        }),
                      ),
                    ).check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
                  ),
                  cutStrategy: Schema.optionalKey(
                    Schema.Literals([
                      "stream_copy_preferred",
                      "precise_reencode",
                      "hybrid_smart_cut",
                    ]),
                  ),
                  container: Schema.optionalKey(Schema.Literals(["mkv", "mp4", "mov"])),
                  destinationId: Schema.optionalKey(
                    Schema.String.check(
                      Schema.isMaxCodePoints(64).annotate({
                        expected: "a string with at most 64 code points",
                      }),
                    ),
                  ),
                  filenameTemplate: Schema.optionalKey(
                    Schema.String.annotate({
                      description:
                        "At most 160 UTF-8 bytes. Standard maxLength counts Unicode characters rather than bytes, so the server enforces this bound.",
                    }),
                  ),
                }),
              }),
              source: Schema.StructWithRest(
                Schema.Struct({
                  mediaId: Schema.String,
                  rootId: Schema.optionalKey(Schema.String),
                  etag: Schema.String,
                  sizeBytes: Schema.Number.check(
                    Schema.isInt().annotate({ expected: "an integer" }),
                  ),
                  durationMs: Schema.Number.check(
                    Schema.isInt().annotate({ expected: "an integer" }),
                  ),
                }),
                [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
              ),
            }),
            [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
          ),
        ),
        findings: Schema.Array(
          Schema.StructWithRest(
            Schema.Struct({
              severity: Schema.Literals(["allowed", "warn", "blocked"]),
              code: Schema.String,
              message: Schema.String,
              streamIndex: Schema.optionalKey(
                Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                  Schema.isGreaterThanOrEqualTo(0).annotate({
                    expected: "a value greater than or equal to 0",
                  }),
                ),
              ),
            }),
            [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
          ),
        ),
        allowed: Schema.Boolean,
        requiresReencoding: Schema.Boolean,
        accuracy: Schema.Literals(["frame_exact", "keyframe_limited", "mixed"]),
        destinationId: Schema.String,
        expiresAt: Schema.String.annotate({ format: "date-time" }),
        approvedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
        createdAt: Schema.String.annotate({ format: "date-time" }),
      }),
      [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
    ),
  ),
  nextCursor: Schema.optionalKey(Schema.String),
  proposalNextCursor: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "MCPSettingsResponse" });
export type MCPCredentialCreate = {
  readonly name: string;
  readonly permissions: ReadonlyArray<string>;
  readonly mediaScope: {
    readonly kind: "all" | "roots" | "media";
    readonly rootIds?: ReadonlyArray<string>;
    readonly mediaIds?: ReadonlyArray<string>;
  };
  readonly projectScope: {
    readonly kind: "all" | "projects";
    readonly projectIds?: ReadonlyArray<string>;
  };
  readonly expiresAt?: string;
  readonly allowNonExpiring?: boolean;
  readonly unattendedExports?: boolean;
};
export const MCPCredentialCreate = Schema.Struct({
  name: Schema.String.check(
    Schema.isMaxCodePoints(120).annotate({ expected: "a string with at most 120 code points" }),
  ),
  permissions: Schema.Array(Schema.String),
  mediaScope: Schema.Struct({
    kind: Schema.Literals(["all", "roots", "media"]),
    rootIds: Schema.optionalKey(Schema.Array(Schema.String)),
    mediaIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  projectScope: Schema.Struct({
    kind: Schema.Literals(["all", "projects"]),
    projectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  expiresAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  allowNonExpiring: Schema.optionalKey(Schema.Boolean),
  unattendedExports: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "MCPCredentialCreate" });
export type MCPCredentialCreated = {
  readonly id: string;
  readonly tokenIdentifier: string;
  readonly name: string;
  readonly permissions: ReadonlyArray<string>;
  readonly mediaScope: {
    readonly kind: "all" | "roots" | "media";
    readonly rootIds?: ReadonlyArray<string>;
    readonly mediaIds?: ReadonlyArray<string>;
  };
  readonly projectScope: {
    readonly kind: "all" | "projects";
    readonly projectIds?: ReadonlyArray<string>;
  };
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly unattendedExports: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: "active" | "expired" | "revoked";
  readonly secret: string;
};
export const MCPCredentialCreated = Schema.Struct({
  id: Schema.String,
  tokenIdentifier: Schema.String,
  name: Schema.String,
  permissions: Schema.Array(Schema.String),
  mediaScope: Schema.Struct({
    kind: Schema.Literals(["all", "roots", "media"]),
    rootIds: Schema.optionalKey(Schema.Array(Schema.String)),
    mediaIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  projectScope: Schema.Struct({
    kind: Schema.Literals(["all", "projects"]),
    projectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  expiresAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  revokedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  unattendedExports: Schema.Boolean,
  createdAt: Schema.String.annotate({ format: "date-time" }),
  lastUsedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  status: Schema.optionalKey(Schema.Literals(["active", "expired", "revoked"])),
  secret: Schema.String,
}).annotate({ identifier: "MCPCredentialCreated" });
export type ExportProposal = {
  readonly id: string;
  readonly credentialId: string;
  readonly projectId?: string;
  readonly projectRevision: number;
  readonly mediaId?: string;
  readonly snapshots: ReadonlyArray<
    {
      readonly projectRevision: number;
      readonly mediaLabel: string;
      readonly item: {
        readonly id: string;
        readonly mediaId: string;
        readonly segments: ReadonlyArray<{
          readonly id?: string;
          readonly startMs: number;
          readonly endMs: number;
          readonly label?: string;
          readonly included?: boolean;
        }>;
        readonly editorState?: {
          readonly playheadMs: number;
          readonly zoom: number;
          readonly muted: boolean;
        } & { readonly [x: string]: Schema.Json };
        readonly exportOptions: {
          readonly mode?: "merge" | "separate";
          readonly selection?: "segments" | "gaps";
          readonly streamIndexes?: ReadonlyArray<number>;
          readonly cutStrategy?: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
          readonly container?: "mkv" | "mp4" | "mov";
          readonly destinationId?: string;
          readonly filenameTemplate?: string;
        };
      };
      readonly source: {
        readonly mediaId: string;
        readonly rootId?: string;
        readonly etag: string;
        readonly sizeBytes: number;
        readonly durationMs: number;
      } & { readonly [x: string]: Schema.Json };
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly findings: ReadonlyArray<
    {
      readonly severity: "allowed" | "warn" | "blocked";
      readonly code: string;
      readonly message: string;
      readonly streamIndex?: number;
    } & { readonly [x: string]: Schema.Json }
  >;
  readonly allowed: boolean;
  readonly requiresReencoding: boolean;
  readonly accuracy: "frame_exact" | "keyframe_limited" | "mixed";
  readonly destinationId: string;
  readonly expiresAt: string;
  readonly approvedAt?: string;
  readonly createdAt: string;
} & { readonly [x: string]: Schema.Json };
export const ExportProposal = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    credentialId: Schema.String,
    projectId: Schema.optionalKey(Schema.String),
    projectRevision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
    mediaId: Schema.optionalKey(Schema.String),
    snapshots: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          projectRevision: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
          mediaLabel: Schema.String,
          item: Schema.Struct({
            id: Schema.String.check(
              Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
                expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
              }),
            ),
            mediaId: Schema.String.check(
              Schema.isPattern(new RegExp("^m_[A-Za-z0-9_-]{43}$", "u")).annotate({
                expected: "a string matching the RegExp ^m_[A-Za-z0-9_-]{43}$",
              }),
            ),
            segments: Schema.Array(
              Schema.Struct({
                id: Schema.optionalKey(
                  Schema.String.check(
                    Schema.isMinLength(1).annotate({
                      expected: "a value with a length of at least 1",
                    }),
                  ).check(
                    Schema.isMaxCodePoints(128).annotate({
                      expected: "a string with at most 128 code points",
                    }),
                  ),
                ),
                startMs: Schema.Number.check(
                  Schema.isInt().annotate({ expected: "an integer" }),
                ).check(
                  Schema.isGreaterThanOrEqualTo(0).annotate({
                    expected: "a value greater than or equal to 0",
                  }),
                ),
                endMs: Schema.Number.check(
                  Schema.isInt().annotate({ expected: "an integer" }),
                ).check(
                  Schema.isGreaterThanOrEqualTo(1).annotate({
                    expected: "a value greater than or equal to 1",
                  }),
                ),
                label: Schema.optionalKey(
                  Schema.String.check(
                    Schema.isMaxCodePoints(200).annotate({
                      expected: "a string with at most 200 code points",
                    }),
                  ),
                ),
                included: Schema.optionalKey(Schema.Boolean.annotate({ default: true })),
              }),
            ),
            editorState: Schema.optionalKey(
              Schema.StructWithRest(
                Schema.Struct({
                  playheadMs: Schema.Number.check(
                    Schema.isInt().annotate({ expected: "an integer" }),
                  ).check(
                    Schema.isGreaterThanOrEqualTo(0).annotate({
                      expected: "a value greater than or equal to 0",
                    }),
                  ),
                  zoom: Schema.Number.check(
                    Schema.isFinite().annotate({ expected: "a finite number" }),
                  ).check(Schema.isGreaterThan(0).annotate({ expected: "a value greater than 0" })),
                  muted: Schema.Boolean,
                }),
                [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
              ),
            ),
            exportOptions: Schema.Struct({
              mode: Schema.optionalKey(Schema.Literals(["merge", "separate"])),
              selection: Schema.optionalKey(Schema.Literals(["segments", "gaps"])),
              streamIndexes: Schema.optionalKey(
                Schema.Array(
                  Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
                    Schema.isGreaterThanOrEqualTo(0).annotate({
                      expected: "a value greater than or equal to 0",
                    }),
                  ),
                ).check(Schema.isUnique().annotate({ expected: "an array with unique items" })),
              ),
              cutStrategy: Schema.optionalKey(
                Schema.Literals(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]),
              ),
              container: Schema.optionalKey(Schema.Literals(["mkv", "mp4", "mov"])),
              destinationId: Schema.optionalKey(
                Schema.String.check(
                  Schema.isMaxCodePoints(64).annotate({
                    expected: "a string with at most 64 code points",
                  }),
                ),
              ),
              filenameTemplate: Schema.optionalKey(
                Schema.String.annotate({
                  description:
                    "At most 160 UTF-8 bytes. Standard maxLength counts Unicode characters rather than bytes, so the server enforces this bound.",
                }),
              ),
            }),
          }),
          source: Schema.StructWithRest(
            Schema.Struct({
              mediaId: Schema.String,
              rootId: Schema.optionalKey(Schema.String),
              etag: Schema.String,
              sizeBytes: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
              durationMs: Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })),
            }),
            [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
          ),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    findings: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          severity: Schema.Literals(["allowed", "warn", "blocked"]),
          code: Schema.String,
          message: Schema.String,
          streamIndex: Schema.optionalKey(
            Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" })).check(
              Schema.isGreaterThanOrEqualTo(0).annotate({
                expected: "a value greater than or equal to 0",
              }),
            ),
          ),
        }),
        [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
      ),
    ),
    allowed: Schema.Boolean,
    requiresReencoding: Schema.Boolean,
    accuracy: Schema.Literals(["frame_exact", "keyframe_limited", "mixed"]),
    destinationId: Schema.String,
    expiresAt: Schema.String.annotate({ format: "date-time" }),
    approvedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
    createdAt: Schema.String.annotate({ format: "date-time" }),
  }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
).annotate({ identifier: "ExportProposal" });
export type MCPCredential = {
  readonly id: string;
  readonly tokenIdentifier: string;
  readonly name: string;
  readonly permissions: ReadonlyArray<string>;
  readonly mediaScope: {
    readonly kind: "all" | "roots" | "media";
    readonly rootIds?: ReadonlyArray<string>;
    readonly mediaIds?: ReadonlyArray<string>;
  };
  readonly projectScope: {
    readonly kind: "all" | "projects";
    readonly projectIds?: ReadonlyArray<string>;
  };
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly unattendedExports: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: "active" | "expired" | "revoked";
};
export const MCPCredential = Schema.Struct({
  id: Schema.String,
  tokenIdentifier: Schema.String,
  name: Schema.String,
  permissions: Schema.Array(Schema.String),
  mediaScope: Schema.Struct({
    kind: Schema.Literals(["all", "roots", "media"]),
    rootIds: Schema.optionalKey(Schema.Array(Schema.String)),
    mediaIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  projectScope: Schema.Struct({
    kind: Schema.Literals(["all", "projects"]),
    projectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  expiresAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  revokedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  unattendedExports: Schema.Boolean,
  createdAt: Schema.String.annotate({ format: "date-time" }),
  lastUsedAt: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  status: Schema.optionalKey(Schema.Literals(["active", "expired", "revoked"])),
}).annotate({ identifier: "MCPCredential" });
export type AutomationCommand = {
  readonly action: "project.import" | "project.export" | "job.status";
  readonly projectId?: string;
  readonly projectItemId?: string;
  readonly jobId?: string;
  readonly format?: "csv" | "chapters";
  readonly input?: string;
};
export const AutomationCommand = Schema.Struct({
  action: Schema.Literals(["project.import", "project.export", "job.status"]),
  projectId: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
        expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
      }),
    ),
  ),
  projectItemId: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
        expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
      }),
    ),
  ),
  jobId: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
        expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
      }),
    ),
  ),
  format: Schema.optionalKey(Schema.Literals(["csv", "chapters"])),
  input: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AutomationCommand" });
// schemas
export type ListMediaParams = { readonly limit?: number; readonly cursor?: string };
export const ListMediaParams = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(Schema.String),
});
export type ListMediaQuery = { readonly limit?: number; readonly cursor?: string };
export const ListMediaQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(Schema.String),
});
export type ListMedia200 = MediaPage;
export const ListMedia200 = MediaPage;
export type ListMedia400 = Error;
export const ListMedia400 = Error;
export type ListMedia401 = Error;
export const ListMedia401 = Error;
export type ListMedia403 = Error;
export const ListMedia403 = Error;
export type ListMedia500 = Error;
export const ListMedia500 = Error;
export type BrowseMediaTreeParams = { readonly folderId?: string; readonly cursor?: string };
export const BrowseMediaTreeParams = Schema.Struct({
  folderId: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
});
export type BrowseMediaTreeQuery = { readonly folderId?: string; readonly cursor?: string };
export const BrowseMediaTreeQuery = Schema.Struct({
  folderId: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
});
export type BrowseMediaTree200 = FolderPage;
export const BrowseMediaTree200 = FolderPage;
export type BrowseMediaTree400 = Error;
export const BrowseMediaTree400 = Error;
export type BrowseMediaTree401 = Error;
export const BrowseMediaTree401 = Error;
export type BrowseMediaTree403 = Error;
export const BrowseMediaTree403 = Error;
export type BrowseMediaTree404 = Error;
export const BrowseMediaTree404 = Error;
export type BrowseMediaTree500 = Error;
export const BrowseMediaTree500 = Error;
export type MediaLibraryStatus200 = LibraryStatus;
export const MediaLibraryStatus200 = LibraryStatus;
export type MediaLibraryStatus401 = Error;
export const MediaLibraryStatus401 = Error;
export type MediaLibraryStatus403 = Error;
export const MediaLibraryStatus403 = Error;
export type MediaLibraryStatus500 = Error;
export const MediaLibraryStatus500 = Error;
export type RefreshMediaParams = { readonly "Idempotency-Key": string };
export const RefreshMediaParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RefreshMediaHeaders = { readonly "Idempotency-Key": string };
export const RefreshMediaHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RefreshMedia202 = ImportJob;
export const RefreshMedia202 = ImportJob;
export type RefreshMedia400 = Error;
export const RefreshMedia400 = Error;
export type RefreshMedia401 = Error;
export const RefreshMedia401 = Error;
export type RefreshMedia403 = Error;
export const RefreshMedia403 = Error;
export type RefreshMedia409 = Error;
export const RefreshMedia409 = Error;
export type RefreshMedia429 = Error;
export const RefreshMedia429 = Error;
export type RefreshMedia500 = Error;
export const RefreshMedia500 = Error;
export type GetMediaPathParams = { readonly mediaId: string };
export const GetMediaPathParams = Schema.Struct({
  mediaId: Schema.String.check(
    Schema.isPattern(new RegExp("^m_[A-Za-z0-9_-]{43}$", "u")).annotate({
      expected: "a string matching the RegExp ^m_[A-Za-z0-9_-]{43}$",
    }),
  ),
});
export type GetMedia200 = Media;
export const GetMedia200 = Media;
export type GetMedia401 = Error;
export const GetMedia401 = Error;
export type GetMedia403 = Error;
export const GetMedia403 = Error;
export type GetMedia404 = Error;
export const GetMedia404 = Error;
export type GetMedia500 = Error;
export const GetMedia500 = Error;
export type ListProjectsParams = { readonly limit?: number; readonly cursor?: string };
export const ListProjectsParams = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(Schema.String),
});
export type ListProjectsQuery = { readonly limit?: number; readonly cursor?: string };
export const ListProjectsQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(Schema.String),
});
export type ListProjects200 = ProjectPage;
export const ListProjects200 = ProjectPage;
export type ListProjects400 = Error;
export const ListProjects400 = Error;
export type ListProjects401 = Error;
export const ListProjects401 = Error;
export type ListProjects403 = Error;
export const ListProjects403 = Error;
export type ListProjects500 = Error;
export const ListProjects500 = Error;
export type GetProjectPathParams = { readonly projectId: string };
export const GetProjectPathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type GetProject200 = Project;
export const GetProject200 = Project;
export type GetProject401 = Error;
export const GetProject401 = Error;
export type GetProject403 = Error;
export const GetProject403 = Error;
export type GetProject404 = Error;
export const GetProject404 = Error;
export type GetProject500 = Error;
export const GetProject500 = Error;
export type PutProjectPathParams = { readonly projectId: string };
export const PutProjectPathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type PutProjectRequestJson = ProjectInput;
export const PutProjectRequestJson = ProjectInput;
export type PutProject200 = Project;
export const PutProject200 = Project;
export type PutProject400 = Error;
export const PutProject400 = Error;
export type PutProject401 = Error;
export const PutProject401 = Error;
export type PutProject403 = Error;
export const PutProject403 = Error;
export type PutProject404 = Error;
export const PutProject404 = Error;
export type PutProject409 = Error;
export const PutProject409 = Error;
export type PutProject500 = Error;
export const PutProject500 = Error;
export type CreateDetectionParams = { readonly "Idempotency-Key": string };
export const CreateDetectionParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type CreateDetectionPathParams = { readonly projectId: string };
export const CreateDetectionPathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type CreateDetectionHeaders = { readonly "Idempotency-Key": string };
export const CreateDetectionHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type CreateDetectionRequestJson = DetectionInput;
export const CreateDetectionRequestJson = DetectionInput;
export type CreateDetection202 = DetectionJob;
export const CreateDetection202 = DetectionJob;
export type CreateDetection400 = Error;
export const CreateDetection400 = Error;
export type CreateDetection401 = Error;
export const CreateDetection401 = Error;
export type CreateDetection403 = Error;
export const CreateDetection403 = Error;
export type CreateDetection404 = Error;
export const CreateDetection404 = Error;
export type CreateDetection409 = Error;
export const CreateDetection409 = Error;
export type CreateDetection429 = Error;
export const CreateDetection429 = Error;
export type CreateDetection500 = Error;
export const CreateDetection500 = Error;
export type CreateExportParams = { readonly "Idempotency-Key": string };
export const CreateExportParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type CreateExportPathParams = { readonly projectId: string };
export const CreateExportPathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type CreateExportHeaders = { readonly "Idempotency-Key": string };
export const CreateExportHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type CreateExportRequestJson = ExportSubmissionInput;
export const CreateExportRequestJson = ExportSubmissionInput;
export type CreateExport202 = BatchExportSubmission;
export const CreateExport202 = BatchExportSubmission;
export type CreateExport400 = Error;
export const CreateExport400 = Error;
export type CreateExport401 = Error;
export const CreateExport401 = Error;
export type CreateExport403 = Error;
export const CreateExport403 = Error;
export type CreateExport404 = Error;
export const CreateExport404 = Error;
export type CreateExport409 = Error;
export const CreateExport409 = Error;
export type CreateExport429 = Error;
export const CreateExport429 = Error;
export type CreateExport500 = Error;
export const CreateExport500 = Error;
export type ListBatchesParams = { readonly limit?: number; readonly cursor?: string };
export const ListBatchesParams = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxCodePoints(256).annotate({ expected: "a string with at most 256 code points" }),
    ),
  ),
});
export type ListBatchesQuery = { readonly limit?: number; readonly cursor?: string };
export const ListBatchesQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Number.annotate({ default: 50 })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxCodePoints(256).annotate({ expected: "a string with at most 256 code points" }),
    ),
  ),
});
export type ListBatches200 = BatchPage;
export const ListBatches200 = BatchPage;
export type ListBatches400 = Error;
export const ListBatches400 = Error;
export type ListBatches401 = Error;
export const ListBatches401 = Error;
export type ListBatches403 = Error;
export const ListBatches403 = Error;
export type ListBatches500 = Error;
export const ListBatches500 = Error;
export type GetBatchProgressPathParams = { readonly batchId: string };
export const GetBatchProgressPathParams = Schema.Struct({ batchId: Schema.String });
export type GetBatchProgress200 = Batch;
export const GetBatchProgress200 = Batch;
export type GetBatchProgress401 = Error;
export const GetBatchProgress401 = Error;
export type GetBatchProgress403 = Error;
export const GetBatchProgress403 = Error;
export type GetBatchProgress404 = Error;
export const GetBatchProgress404 = Error;
export type GetBatchProgress500 = Error;
export const GetBatchProgress500 = Error;
export type CancelBatchPathParams = { readonly batchId: string };
export const CancelBatchPathParams = Schema.Struct({ batchId: Schema.String });
export type CancelBatch401 = Error;
export const CancelBatch401 = Error;
export type CancelBatch403 = Error;
export const CancelBatch403 = Error;
export type CancelBatch404 = Error;
export const CancelBatch404 = Error;
export type CancelBatch500 = Error;
export const CancelBatch500 = Error;
export type PreflightExportPathParams = { readonly projectId: string };
export const PreflightExportPathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type PreflightExportRequestJson = ExportInput;
export const PreflightExportRequestJson = ExportInput;
export type PreflightExport200 = ExportPreflight;
export const PreflightExport200 = ExportPreflight;
export type PreflightExport400 = Error;
export const PreflightExport400 = Error;
export type PreflightExport401 = Error;
export const PreflightExport401 = Error;
export type PreflightExport403 = Error;
export const PreflightExport403 = Error;
export type PreflightExport500 = Error;
export const PreflightExport500 = Error;
export type ListDestinations200 = {
  readonly destinations: ReadonlyArray<Destination>;
  readonly capabilities: DestinationCapabilities;
} & { readonly [x: string]: Schema.Json };
export const ListDestinations200 = Schema.StructWithRest(
  Schema.Struct({ destinations: Schema.Array(Destination), capabilities: DestinationCapabilities }),
  [Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" }))],
);
export type ListDestinations401 = Error;
export const ListDestinations401 = Error;
export type ListDestinations403 = Error;
export const ListDestinations403 = Error;
export type ListDestinations500 = Error;
export const ListDestinations500 = Error;
export type GetJobPathParams = { readonly jobId: string };
export const GetJobPathParams = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type GetJob200 = Job;
export const GetJob200 = Job;
export type GetJob401 = Error;
export const GetJob401 = Error;
export type GetJob403 = Error;
export const GetJob403 = Error;
export type GetJob404 = Error;
export const GetJob404 = Error;
export type GetJob500 = Error;
export const GetJob500 = Error;
export type CancelJobPathParams = { readonly jobId: string };
export const CancelJobPathParams = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type CancelJob401 = Error;
export const CancelJob401 = Error;
export type CancelJob403 = Error;
export const CancelJob403 = Error;
export type CancelJob404 = Error;
export const CancelJob404 = Error;
export type CancelJob500 = Error;
export const CancelJob500 = Error;
export type RetryJobParams = { readonly "Idempotency-Key": string };
export const RetryJobParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RetryJobPathParams = { readonly jobId: string };
export const RetryJobPathParams = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type RetryJobHeaders = { readonly "Idempotency-Key": string };
export const RetryJobHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RetryJob202 = Batch;
export const RetryJob202 = Batch;
export type RetryJob400 = Error;
export const RetryJob400 = Error;
export type RetryJob401 = Error;
export const RetryJob401 = Error;
export type RetryJob403 = Error;
export const RetryJob403 = Error;
export type RetryJob404 = Error;
export const RetryJob404 = Error;
export type RetryJob409 = Error;
export const RetryJob409 = Error;
export type RetryJob429 = Error;
export const RetryJob429 = Error;
export type RetryJob500 = Error;
export const RetryJob500 = Error;
export type GetSettings200 = SettingsResponse;
export const GetSettings200 = SettingsResponse;
export type GetSettings401 = Error;
export const GetSettings401 = Error;
export type GetSettings403 = Error;
export const GetSettings403 = Error;
export type GetSettings404 = Error;
export const GetSettings404 = Error;
export type GetSettings500 = Error;
export const GetSettings500 = Error;
export type UpdateSettingsRequestJson = SettingsUpdate;
export const UpdateSettingsRequestJson = SettingsUpdate;
export type UpdateSettings200 = SettingsUpdated;
export const UpdateSettings200 = SettingsUpdated;
export type UpdateSettings400 = Error;
export const UpdateSettings400 = Error;
export type UpdateSettings401 = Error;
export const UpdateSettings401 = Error;
export type UpdateSettings403 = Error;
export const UpdateSettings403 = Error;
export type UpdateSettings404 = Error;
export const UpdateSettings404 = Error;
export type UpdateSettings409 = Error;
export const UpdateSettings409 = Error;
export type UpdateSettings500 = Error;
export const UpdateSettings500 = Error;
export type GetMCPSettingsParams = {
  readonly cursor?: string;
  readonly limit?: number;
  readonly proposalCursor?: string;
  readonly proposalLimit?: number;
};
export const GetMCPSettingsParams = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  proposalCursor: Schema.optionalKey(Schema.String),
  proposalLimit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
});
export type GetMCPSettingsQuery = {
  readonly cursor?: string;
  readonly limit?: number;
  readonly proposalCursor?: string;
  readonly proposalLimit?: number;
};
export const GetMCPSettingsQuery = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
  proposalCursor: Schema.optionalKey(Schema.String),
  proposalLimit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(1).annotate({
          expected: "a value greater than or equal to 1",
        }),
      )
      .check(
        Schema.isLessThanOrEqualTo(100).annotate({ expected: "a value less than or equal to 100" }),
      ),
  ),
});
export type GetMCPSettings200 = MCPSettingsResponse;
export const GetMCPSettings200 = MCPSettingsResponse;
export type GetMCPSettings400 = Error;
export const GetMCPSettings400 = Error;
export type GetMCPSettings401 = Error;
export const GetMCPSettings401 = Error;
export type GetMCPSettings403 = Error;
export const GetMCPSettings403 = Error;
export type GetMCPSettings404 = Error;
export const GetMCPSettings404 = Error;
export type GetMCPSettings500 = Error;
export const GetMCPSettings500 = Error;
export type CreateMCPCredentialRequestJson = MCPCredentialCreate;
export const CreateMCPCredentialRequestJson = MCPCredentialCreate;
export type CreateMCPCredential201 = MCPCredentialCreated;
export const CreateMCPCredential201 = MCPCredentialCreated;
export type CreateMCPCredential400 = Error;
export const CreateMCPCredential400 = Error;
export type CreateMCPCredential401 = Error;
export const CreateMCPCredential401 = Error;
export type CreateMCPCredential403 = Error;
export const CreateMCPCredential403 = Error;
export type CreateMCPCredential404 = Error;
export const CreateMCPCredential404 = Error;
export type CreateMCPCredential500 = Error;
export const CreateMCPCredential500 = Error;
export type GetExportProposalPathParams = { readonly proposalId: string };
export const GetExportProposalPathParams = Schema.Struct({
  proposalId: Schema.String.check(
    Schema.isPattern(new RegExp("^ep_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^ep_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type GetExportProposal200 = ExportProposal;
export const GetExportProposal200 = ExportProposal;
export type GetExportProposal401 = Error;
export const GetExportProposal401 = Error;
export type GetExportProposal403 = Error;
export const GetExportProposal403 = Error;
export type GetExportProposal404 = Error;
export const GetExportProposal404 = Error;
export type GetExportProposal500 = Error;
export const GetExportProposal500 = Error;
export type ApproveExportProposalPathParams = { readonly proposalId: string };
export const ApproveExportProposalPathParams = Schema.Struct({
  proposalId: Schema.String.check(
    Schema.isPattern(new RegExp("^ep_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^ep_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type ApproveExportProposal200 = ExportProposal;
export const ApproveExportProposal200 = ExportProposal;
export type ApproveExportProposal401 = Error;
export const ApproveExportProposal401 = Error;
export type ApproveExportProposal403 = Error;
export const ApproveExportProposal403 = Error;
export type ApproveExportProposal404 = Error;
export const ApproveExportProposal404 = Error;
export type ApproveExportProposal409 = Error;
export const ApproveExportProposal409 = Error;
export type ApproveExportProposal500 = Error;
export const ApproveExportProposal500 = Error;
export type RevokeMCPCredentialPathParams = { readonly credentialId: string };
export const RevokeMCPCredentialPathParams = Schema.Struct({
  credentialId: Schema.String.check(
    Schema.isPattern(new RegExp("^c_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^c_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type RevokeMCPCredential200 = MCPCredential;
export const RevokeMCPCredential200 = MCPCredential;
export type RevokeMCPCredential401 = Error;
export const RevokeMCPCredential401 = Error;
export type RevokeMCPCredential403 = Error;
export const RevokeMCPCredential403 = Error;
export type RevokeMCPCredential404 = Error;
export const RevokeMCPCredential404 = Error;
export type RevokeMCPCredential500 = Error;
export const RevokeMCPCredential500 = Error;
export type RefreshSettingsMediaParams = { readonly "Idempotency-Key": string };
export const RefreshSettingsMediaParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RefreshSettingsMediaHeaders = { readonly "Idempotency-Key": string };
export const RefreshSettingsMediaHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type RefreshSettingsMedia202 = ImportJob;
export const RefreshSettingsMedia202 = ImportJob;
export type RefreshSettingsMedia400 = Error;
export const RefreshSettingsMedia400 = Error;
export type RefreshSettingsMedia401 = Error;
export const RefreshSettingsMedia401 = Error;
export type RefreshSettingsMedia403 = Error;
export const RefreshSettingsMedia403 = Error;
export type RefreshSettingsMedia409 = Error;
export const RefreshSettingsMedia409 = Error;
export type RefreshSettingsMedia429 = Error;
export const RefreshSettingsMedia429 = Error;
export type RefreshSettingsMedia500 = Error;
export const RefreshSettingsMedia500 = Error;
export type StartMediaImportParams = { readonly "Idempotency-Key": string };
export const StartMediaImportParams = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type StartMediaImportHeaders = { readonly "Idempotency-Key": string };
export const StartMediaImportHeaders = Schema.Struct({
  "Idempotency-Key": Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
  )
    .check(
      Schema.isMaxCodePoints(128).annotate({ expected: "a string with at most 128 code points" }),
    )
    .check(
      Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$", "u")).annotate({
        expected: "a string matching the RegExp ^[A-Za-z0-9_-]+$",
      }),
    ),
});
export type StartMediaImport202 = ImportJob;
export const StartMediaImport202 = ImportJob;
export type StartMediaImport400 = Error;
export const StartMediaImport400 = Error;
export type StartMediaImport401 = Error;
export const StartMediaImport401 = Error;
export type StartMediaImport403 = Error;
export const StartMediaImport403 = Error;
export type StartMediaImport409 = Error;
export const StartMediaImport409 = Error;
export type StartMediaImport429 = Error;
export const StartMediaImport429 = Error;
export type StartMediaImport500 = Error;
export const StartMediaImport500 = Error;
export type GetMediaImportPathParams = { readonly jobId: string };
export const GetMediaImportPathParams = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type GetMediaImport200 = ImportJob;
export const GetMediaImport200 = ImportJob;
export type GetMediaImport401 = Error;
export const GetMediaImport401 = Error;
export type GetMediaImport403 = Error;
export const GetMediaImport403 = Error;
export type GetMediaImport404 = Error;
export const GetMediaImport404 = Error;
export type GetMediaImport500 = Error;
export const GetMediaImport500 = Error;
export type CancelMediaImportPathParams = { readonly jobId: string };
export const CancelMediaImportPathParams = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(new RegExp("^j_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^j_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
});
export type CancelMediaImport401 = Error;
export const CancelMediaImport401 = Error;
export type CancelMediaImport403 = Error;
export const CancelMediaImport403 = Error;
export type CancelMediaImport404 = Error;
export const CancelMediaImport404 = Error;
export type CancelMediaImport500 = Error;
export const CancelMediaImport500 = Error;
export type ImportInterchangeParams = { readonly itemId?: string };
export const ImportInterchangeParams = Schema.Struct({
  itemId: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
        expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
      }),
    ),
  ),
});
export type ImportInterchangePathParams = {
  readonly projectId: string;
  readonly format: "csv" | "chapters";
};
export const ImportInterchangePathParams = Schema.Struct({
  projectId: Schema.String.check(
    Schema.isPattern(new RegExp("^p_[A-Za-z0-9_-]{12,64}$", "u")).annotate({
      expected: "a string matching the RegExp ^p_[A-Za-z0-9_-]{12,64}$",
    }),
  ),
  format: Schema.Literals(["csv", "chapters"]),
});
export type ImportInterchangeQuery = { readonly itemId?: string };
export const ImportInterchangeQuery = Schema.Struct({
  itemId: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(new RegExp("^i_[A-Za-z0-9_-]{24}$", "u")).annotate({
        expected: "a string matching the RegExp ^i_[A-Za-z0-9_-]{24}$",
      }),
    ),
  ),
});
export type ImportInterchangeRequestTextCsv = string;
export const ImportInterchangeRequestTextCsv = Schema.String;
export type ImportInterchangeRequestText = string;
export const ImportInterchangeRequestText = Schema.String;
export type ImportInterchange200 = Project;
export const ImportInterchange200 = Project;
export type ImportInterchange400 = Error;
export const ImportInterchange400 = Error;
export type ImportInterchange401 = Error;
export const ImportInterchange401 = Error;
export type ImportInterchange403 = Error;
export const ImportInterchange403 = Error;
export type ImportInterchange404 = Error;
export const ImportInterchange404 = Error;
export type ImportInterchange409 = Error;
export const ImportInterchange409 = Error;
export type ImportInterchange500 = Error;
export const ImportInterchange500 = Error;
export type AutomationRequestJson = AutomationCommand;
export const AutomationRequestJson = AutomationCommand;
export type Automation200 =
  | ({ readonly projectId: string } & { readonly [x: string]: Schema.Json })
  | ({ readonly filename: string; readonly content: string } & {
      readonly [x: string]: Schema.Json;
    })
  | Job;
export const Automation200 = Schema.Union(
  [
    Schema.StructWithRest(Schema.Struct({ projectId: Schema.String }), [
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
    ]),
    Schema.StructWithRest(Schema.Struct({ filename: Schema.String, content: Schema.String }), [
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })),
    ]),
    Job,
  ],
  { mode: "oneOf" },
);
export type Automation400 = Error;
export const Automation400 = Error;
export type Automation401 = Error;
export const Automation401 = Error;
export type Automation403 = Error;
export const Automation403 = Error;
export type Automation404 = Error;
export const Automation404 = Error;
export type Automation409 = Error;
export const Automation409 = Error;
export type Automation413 = Error;
export const Automation413 = Error;
export type Automation500 = Error;
export const Automation500 = Error;

export const BearerAuthSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Used only when the server selects static bearer mode.",
  ),
);

export class BearerAuthSecurityMiddleware extends HttpApiMiddleware.Service<BearerAuthSecurityMiddleware>()(
  "bearerAuth security",
  { security: { bearerAuth: BearerAuthSecurity } },
) {}

class DefaultGroup extends HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("listMedia", "/media", {
    query: ListMediaQuery,
    success: ListMedia200,
    error: [
      ListMedia400.pipe(HttpApiSchema.status(400)),
      ListMedia401.pipe(HttpApiSchema.status(401)),
      ListMedia403.pipe(HttpApiSchema.status(403)),
      ListMedia500,
    ],
  })
    .annotate(OpenApi.Identifier, "listMedia")
    .annotate(OpenApi.Summary, "List indexed media")
    .annotate(
      OpenApi.Description,
      "Rejects malformed percent encoding, unknown parameters, and duplicate query keys with 400 invalid_query.",
    ),
  HttpApiEndpoint.get("browseMediaTree", "/media/tree", {
    query: BrowseMediaTreeQuery,
    success: BrowseMediaTree200,
    error: [
      BrowseMediaTree400.pipe(HttpApiSchema.status(400)),
      BrowseMediaTree401.pipe(HttpApiSchema.status(401)),
      BrowseMediaTree403.pipe(HttpApiSchema.status(403)),
      BrowseMediaTree404.pipe(HttpApiSchema.status(404)),
      BrowseMediaTree500,
    ],
  })
    .annotate(OpenApi.Identifier, "browseMediaTree")
    .annotate(OpenApi.Summary, "Browse indexed media folders and items"),
  HttpApiEndpoint.get("mediaLibraryStatus", "/media/status", {
    success: MediaLibraryStatus200,
    error: [
      MediaLibraryStatus401.pipe(HttpApiSchema.status(401)),
      MediaLibraryStatus403.pipe(HttpApiSchema.status(403)),
      MediaLibraryStatus500,
    ],
  })
    .annotate(OpenApi.Identifier, "mediaLibraryStatus")
    .annotate(OpenApi.Summary, "Read media-library status"),
  HttpApiEndpoint.post("refreshMedia", "/media/refresh", {
    headers: RefreshMediaHeaders,
    success: RefreshMedia202.pipe(HttpApiSchema.status(202)),
    error: [
      RefreshMedia400.pipe(HttpApiSchema.status(400)),
      RefreshMedia401.pipe(HttpApiSchema.status(401)),
      RefreshMedia403.pipe(HttpApiSchema.status(403)),
      RefreshMedia409.pipe(HttpApiSchema.status(409)),
      RefreshMedia429.pipe(HttpApiSchema.status(429)),
      RefreshMedia500,
    ],
  })
    .annotate(OpenApi.Identifier, "refreshMedia")
    .annotate(OpenApi.Summary, "Refresh the media index"),
  HttpApiEndpoint.get("getMedia", "/media/:mediaId", {
    params: GetMediaPathParams,
    success: GetMedia200,
    error: [
      GetMedia401.pipe(HttpApiSchema.status(401)),
      GetMedia403.pipe(HttpApiSchema.status(403)),
      GetMedia404.pipe(HttpApiSchema.status(404)),
      GetMedia500,
    ],
  })
    .annotate(OpenApi.Identifier, "getMedia")
    .annotate(OpenApi.Summary, "Read media metadata"),
  HttpApiEndpoint.get("listProjects", "/projects", {
    query: ListProjectsQuery,
    success: ListProjects200,
    error: [
      ListProjects400.pipe(HttpApiSchema.status(400)),
      ListProjects401.pipe(HttpApiSchema.status(401)),
      ListProjects403.pipe(HttpApiSchema.status(403)),
      ListProjects500,
    ],
  })
    .annotate(OpenApi.Identifier, "listProjects")
    .annotate(OpenApi.Summary, "List saved projects"),
  HttpApiEndpoint.get("getProject", "/projects/:projectId", {
    params: GetProjectPathParams,
    success: GetProject200,
    error: [
      GetProject401.pipe(HttpApiSchema.status(401)),
      GetProject403.pipe(HttpApiSchema.status(403)),
      GetProject404.pipe(HttpApiSchema.status(404)),
      GetProject500,
    ],
  })
    .annotate(OpenApi.Identifier, "getProject")
    .annotate(OpenApi.Summary, "Read a project"),
  HttpApiEndpoint.put("putProject", "/projects/:projectId", {
    params: PutProjectPathParams,
    payload: PutProjectRequestJson,
    success: PutProject200,
    error: [
      PutProject400.pipe(HttpApiSchema.status(400)),
      PutProject401.pipe(HttpApiSchema.status(401)),
      PutProject403.pipe(HttpApiSchema.status(403)),
      PutProject404.pipe(HttpApiSchema.status(404)),
      PutProject409.pipe(HttpApiSchema.status(409)),
      PutProject500,
    ],
  })
    .annotate(OpenApi.Identifier, "putProject")
    .annotate(OpenApi.Summary, "Save a project"),
  HttpApiEndpoint.post("createDetection", "/projects/:projectId/detections", {
    params: CreateDetectionPathParams,
    headers: CreateDetectionHeaders,
    payload: CreateDetectionRequestJson,
    success: CreateDetection202.pipe(HttpApiSchema.status(202)),
    error: [
      CreateDetection400.pipe(HttpApiSchema.status(400)),
      CreateDetection401.pipe(HttpApiSchema.status(401)),
      CreateDetection403.pipe(HttpApiSchema.status(403)),
      CreateDetection404.pipe(HttpApiSchema.status(404)),
      CreateDetection409.pipe(HttpApiSchema.status(409)),
      CreateDetection429.pipe(HttpApiSchema.status(429)),
      CreateDetection500,
    ],
  })
    .annotate(OpenApi.Identifier, "createDetection")
    .annotate(OpenApi.Summary, "Start media detection"),
  HttpApiEndpoint.post("createExport", "/projects/:projectId/exports", {
    params: CreateExportPathParams,
    headers: CreateExportHeaders,
    payload: CreateExportRequestJson,
    success: CreateExport202.pipe(HttpApiSchema.status(202)),
    error: [
      CreateExport400.pipe(HttpApiSchema.status(400)),
      CreateExport401.pipe(HttpApiSchema.status(401)),
      CreateExport403.pipe(HttpApiSchema.status(403)),
      CreateExport404.pipe(HttpApiSchema.status(404)),
      CreateExport409.pipe(HttpApiSchema.status(409)),
      CreateExport429.pipe(HttpApiSchema.status(429)),
      CreateExport500,
    ],
  })
    .annotate(OpenApi.Identifier, "createExport")
    .annotate(OpenApi.Summary, "Create a durable export"),
  HttpApiEndpoint.get("listBatches", "/batches", {
    query: ListBatchesQuery,
    success: ListBatches200,
    error: [
      ListBatches400.pipe(HttpApiSchema.status(400)),
      ListBatches401.pipe(HttpApiSchema.status(401)),
      ListBatches403.pipe(HttpApiSchema.status(403)),
      ListBatches500,
    ],
  })
    .annotate(OpenApi.Identifier, "listBatches")
    .annotate(OpenApi.Summary, "List durable batches"),
  HttpApiEndpoint.get("getBatchProgress", "/batches/:batchId", {
    params: GetBatchProgressPathParams,
    success: GetBatchProgress200,
    error: [
      GetBatchProgress401.pipe(HttpApiSchema.status(401)),
      GetBatchProgress403.pipe(HttpApiSchema.status(403)),
      GetBatchProgress404.pipe(HttpApiSchema.status(404)),
      GetBatchProgress500,
    ],
  })
    .annotate(OpenApi.Identifier, "getBatchProgress")
    .annotate(OpenApi.Summary, "Get durable batch export progress"),
  HttpApiEndpoint.delete("cancelBatch", "/batches/:batchId", {
    params: CancelBatchPathParams,
    success: HttpApiSchema.Empty(204),
    error: [
      CancelBatch401.pipe(HttpApiSchema.status(401)),
      CancelBatch403.pipe(HttpApiSchema.status(403)),
      CancelBatch404.pipe(HttpApiSchema.status(404)),
      CancelBatch500,
    ],
  })
    .annotate(OpenApi.Identifier, "cancelBatch")
    .annotate(OpenApi.Summary, "Cancel a batch export"),
  HttpApiEndpoint.post("preflightExport", "/projects/:projectId/exports/preflight", {
    params: PreflightExportPathParams,
    payload: PreflightExportRequestJson,
    success: PreflightExport200,
    error: [
      PreflightExport400.pipe(HttpApiSchema.status(400)),
      PreflightExport401.pipe(HttpApiSchema.status(401)),
      PreflightExport403.pipe(HttpApiSchema.status(403)),
      PreflightExport500,
    ],
  })
    .annotate(OpenApi.Identifier, "preflightExport")
    .annotate(OpenApi.Summary, "Validate export selection without queueing"),
  HttpApiEndpoint.get("listDestinations", "/destinations", {
    success: ListDestinations200,
    error: [
      ListDestinations401.pipe(HttpApiSchema.status(401)),
      ListDestinations403.pipe(HttpApiSchema.status(403)),
      ListDestinations500,
    ],
  })
    .annotate(OpenApi.Identifier, "listDestinations")
    .annotate(OpenApi.Summary, "List configured export destinations"),
  HttpApiEndpoint.get("getJob", "/jobs/:jobId", {
    params: GetJobPathParams,
    success: GetJob200,
    error: [
      GetJob401.pipe(HttpApiSchema.status(401)),
      GetJob403.pipe(HttpApiSchema.status(403)),
      GetJob404.pipe(HttpApiSchema.status(404)),
      GetJob500,
    ],
  })
    .annotate(OpenApi.Identifier, "getJob")
    .annotate(OpenApi.Summary, "Read a job"),
  HttpApiEndpoint.delete("cancelJob", "/jobs/:jobId", {
    params: CancelJobPathParams,
    success: HttpApiSchema.Empty(204),
    error: [
      CancelJob401.pipe(HttpApiSchema.status(401)),
      CancelJob403.pipe(HttpApiSchema.status(403)),
      CancelJob404.pipe(HttpApiSchema.status(404)),
      CancelJob500,
    ],
  })
    .annotate(OpenApi.Identifier, "cancelJob")
    .annotate(OpenApi.Summary, "Cancel a job"),
  HttpApiEndpoint.post("retryJob", "/jobs/:jobId/retry", {
    params: RetryJobPathParams,
    headers: RetryJobHeaders,
    success: RetryJob202.pipe(HttpApiSchema.status(202)),
    error: [
      RetryJob400.pipe(HttpApiSchema.status(400)),
      RetryJob401.pipe(HttpApiSchema.status(401)),
      RetryJob403.pipe(HttpApiSchema.status(403)),
      RetryJob404.pipe(HttpApiSchema.status(404)),
      RetryJob409.pipe(HttpApiSchema.status(409)),
      RetryJob429.pipe(HttpApiSchema.status(429)),
      RetryJob500,
    ],
  })
    .annotate(OpenApi.Identifier, "retryJob")
    .annotate(OpenApi.Summary, "Retry a failed export as a new job"),
  HttpApiEndpoint.get("getSettings", "/settings", {
    success: GetSettings200,
    error: [
      GetSettings401.pipe(HttpApiSchema.status(401)),
      GetSettings403.pipe(HttpApiSchema.status(403)),
      GetSettings404.pipe(HttpApiSchema.status(404)),
      GetSettings500,
    ],
  })
    .annotate(OpenApi.Identifier, "getSettings")
    .annotate(OpenApi.Summary, "Read runtime settings and safe root diagnostics"),
  HttpApiEndpoint.put("updateSettings", "/settings", {
    payload: UpdateSettingsRequestJson,
    success: UpdateSettings200,
    error: [
      UpdateSettings400.pipe(HttpApiSchema.status(400)),
      UpdateSettings401.pipe(HttpApiSchema.status(401)),
      UpdateSettings403.pipe(HttpApiSchema.status(403)),
      UpdateSettings404.pipe(HttpApiSchema.status(404)),
      UpdateSettings409.pipe(HttpApiSchema.status(409)),
      UpdateSettings500,
    ],
  })
    .annotate(OpenApi.Identifier, "updateSettings")
    .annotate(OpenApi.Summary, "Replace runtime settings")
    .annotate(
      OpenApi.Description,
      "Complete mutable settings document, at most 1048576 bytes. Deployment roots and destinations remain server-owned and may be omitted; destination metadata may be echoed unchanged. Invalid settings (including exportLimit outside 1..64) are rejected with 400 before live mutation or persistence. Stale revisions are 409. Unexpected application/persistence/rollback failures are 500. Live settings affect new work; existing export snapshots retain their settings, except shared worker/process/cache limits. Preview defaults, scan limits, and MCP enablement apply live. MCP transport request capacity remains the startup value; previewGlobalLimit controls media processes.",
    ),
  HttpApiEndpoint.get("getMCPSettings", "/settings/mcp", {
    query: GetMCPSettingsQuery,
    success: GetMCPSettings200,
    error: [
      GetMCPSettings400.pipe(HttpApiSchema.status(400)),
      GetMCPSettings401.pipe(HttpApiSchema.status(401)),
      GetMCPSettings403.pipe(HttpApiSchema.status(403)),
      GetMCPSettings404.pipe(HttpApiSchema.status(404)),
      GetMCPSettings500,
    ],
  })
    .annotate(OpenApi.Identifier, "getMCPSettings")
    .annotate(OpenApi.Summary, "Read MCP administration status and safe credential metadata"),
  HttpApiEndpoint.post("createMCPCredential", "/settings/mcp/credentials", {
    payload: CreateMCPCredentialRequestJson,
    success: CreateMCPCredential201.pipe(HttpApiSchema.status(201)),
    error: [
      CreateMCPCredential400.pipe(HttpApiSchema.status(400)),
      CreateMCPCredential401.pipe(HttpApiSchema.status(401)),
      CreateMCPCredential403.pipe(HttpApiSchema.status(403)),
      CreateMCPCredential404.pipe(HttpApiSchema.status(404)),
      CreateMCPCredential500,
    ],
  })
    .annotate(OpenApi.Identifier, "createMCPCredential")
    .annotate(OpenApi.Summary, "Create a scoped MCP bearer credential"),
  HttpApiEndpoint.get("getExportProposal", "/export-proposals/:proposalId", {
    params: GetExportProposalPathParams,
    success: GetExportProposal200,
    error: [
      GetExportProposal401.pipe(HttpApiSchema.status(401)),
      GetExportProposal403.pipe(HttpApiSchema.status(403)),
      GetExportProposal404.pipe(HttpApiSchema.status(404)),
      GetExportProposal500,
    ],
  })
    .annotate(OpenApi.Identifier, "getExportProposal")
    .annotate(OpenApi.Summary, "Read exact MCP export proposal details"),
  HttpApiEndpoint.post("approveExportProposal", "/export-proposals/:proposalId/approval", {
    params: ApproveExportProposalPathParams,
    success: ApproveExportProposal200,
    error: [
      ApproveExportProposal401.pipe(HttpApiSchema.status(401)),
      ApproveExportProposal403.pipe(HttpApiSchema.status(403)),
      ApproveExportProposal404.pipe(HttpApiSchema.status(404)),
      ApproveExportProposal409.pipe(HttpApiSchema.status(409)),
      ApproveExportProposal500,
    ],
  })
    .annotate(OpenApi.Identifier, "approveExportProposal")
    .annotate(OpenApi.Summary, "Approve exact MCP export proposal details"),
  HttpApiEndpoint.delete("revokeMCPCredential", "/settings/mcp/credentials/:credentialId", {
    params: RevokeMCPCredentialPathParams,
    success: RevokeMCPCredential200,
    error: [
      RevokeMCPCredential401.pipe(HttpApiSchema.status(401)),
      RevokeMCPCredential403.pipe(HttpApiSchema.status(403)),
      RevokeMCPCredential404.pipe(HttpApiSchema.status(404)),
      RevokeMCPCredential500,
    ],
  })
    .annotate(OpenApi.Identifier, "revokeMCPCredential")
    .annotate(OpenApi.Summary, "Revoke an MCP credential immediately"),
  HttpApiEndpoint.post("refreshSettingsMedia", "/settings/media/refresh", {
    headers: RefreshSettingsMediaHeaders,
    success: RefreshSettingsMedia202.pipe(HttpApiSchema.status(202)),
    error: [
      RefreshSettingsMedia400.pipe(HttpApiSchema.status(400)),
      RefreshSettingsMedia401.pipe(HttpApiSchema.status(401)),
      RefreshSettingsMedia403.pipe(HttpApiSchema.status(403)),
      RefreshSettingsMedia409.pipe(HttpApiSchema.status(409)),
      RefreshSettingsMedia429.pipe(HttpApiSchema.status(429)),
      RefreshSettingsMedia500,
    ],
  })
    .annotate(OpenApi.Identifier, "refreshSettingsMedia")
    .annotate(OpenApi.Summary, "Queue a media library refresh"),
  HttpApiEndpoint.post("startMediaImport", "/media/import", {
    headers: StartMediaImportHeaders,
    success: StartMediaImport202.pipe(HttpApiSchema.status(202)),
    error: [
      StartMediaImport400.pipe(HttpApiSchema.status(400)),
      StartMediaImport401.pipe(HttpApiSchema.status(401)),
      StartMediaImport403.pipe(HttpApiSchema.status(403)),
      StartMediaImport409.pipe(HttpApiSchema.status(409)),
      StartMediaImport429.pipe(HttpApiSchema.status(429)),
      StartMediaImport500,
    ],
  })
    .annotate(OpenApi.Identifier, "startMediaImport")
    .annotate(OpenApi.Summary, "Queue a durable media-library scan")
    .annotate(
      OpenApi.Description,
      "Scans configured server roots; takes no parameters or request body. Unconfigured roots return 409 import_unavailable; admission-capacity rejection returns 429. Poll the returned opaque job ID.",
    ),
  HttpApiEndpoint.get("getMediaImport", "/media/import/:jobId", {
    params: GetMediaImportPathParams,
    success: GetMediaImport200,
    error: [
      GetMediaImport401.pipe(HttpApiSchema.status(401)),
      GetMediaImport403.pipe(HttpApiSchema.status(403)),
      GetMediaImport404.pipe(HttpApiSchema.status(404)),
      GetMediaImport500,
    ],
  })
    .annotate(OpenApi.Identifier, "getMediaImport")
    .annotate(OpenApi.Summary, "Read a library scan job"),
  HttpApiEndpoint.delete("cancelMediaImport", "/media/import/:jobId", {
    params: CancelMediaImportPathParams,
    success: HttpApiSchema.Empty(204),
    error: [
      CancelMediaImport401.pipe(HttpApiSchema.status(401)),
      CancelMediaImport403.pipe(HttpApiSchema.status(403)),
      CancelMediaImport404.pipe(HttpApiSchema.status(404)),
      CancelMediaImport500,
    ],
  })
    .annotate(OpenApi.Identifier, "cancelMediaImport")
    .annotate(OpenApi.Summary, "Request cancellation of a library scan"),
  HttpApiEndpoint.post("importInterchange", "/projects/:projectId/interchange/:format", {
    params: ImportInterchangePathParams,
    query: ImportInterchangeQuery,
    payload: [
      ImportInterchangeRequestTextCsv.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
      ImportInterchangeRequestText.pipe(HttpApiSchema.asText()),
    ],
    success: ImportInterchange200,
    error: [
      ImportInterchange400.pipe(HttpApiSchema.status(400)),
      ImportInterchange401.pipe(HttpApiSchema.status(401)),
      ImportInterchange403.pipe(HttpApiSchema.status(403)),
      ImportInterchange404.pipe(HttpApiSchema.status(404)),
      ImportInterchange409.pipe(HttpApiSchema.status(409)),
      ImportInterchange500,
    ],
  })
    .annotate(OpenApi.Identifier, "importInterchange")
    .annotate(OpenApi.Summary, "Replace a project item's segments from a cut list")
    .annotate(
      OpenApi.Description,
      "Maximum input is 1048576 bytes and 10000 segments. CSV requires the header start,end,label. Chapters accept start title or start --> end title lines. Timestamps are seconds, MM:SS, or HH:MM:SS with up to three fractional digits. Labels may not contain slash or backslash and are limited to 200 characters. Ranges must be valid for the media. Saving uses the revision read by the server; a concurrent edit returns 409. Missing/ambiguous item selection also returns 409 project_item_required. Invalid and oversized input returns 400 invalid_interchange; this route does not return 413.",
    ),
  HttpApiEndpoint.post("automation", "/automation", {
    payload: AutomationRequestJson,
    success: Automation200,
    error: [
      Automation400.pipe(HttpApiSchema.status(400)),
      Automation401.pipe(HttpApiSchema.status(401)),
      Automation403.pipe(HttpApiSchema.status(403)),
      Automation404.pipe(HttpApiSchema.status(404)),
      Automation409.pipe(HttpApiSchema.status(409)),
      Automation413.pipe(HttpApiSchema.status(413)),
      Automation500,
    ],
  })
    .middleware(BearerAuthSecurityMiddleware)
    .annotate(OpenApi.Identifier, "automation")
    .annotate(OpenApi.Summary, "Execute an authenticated local automation command")
    .annotate(
      OpenApi.Description,
      "Requires a loopback listener, configured deployment authentication (bearer or trusted proxy), and no Origin header. This is REST, not MCP JSON-RPC. The entire JSON body is limited to 1048576 bytes (413 on overflow). Unknown/trailing JSON and invalid commands use the existing 400 status. project.import/project.export require projectId and format; projectItemId may be omitted only for a sole-item project. project.import also requires nonempty input and applies the interchange validation rules. job.status requires jobId. Filesystem paths are never accepted or returned.",
    ),
) {}

export class VideoCutListApi extends HttpApi.make("VideoCutListApi")
  .annotate(OpenApi.Title, "VideoCutlist API")
  .annotate(OpenApi.Version, "2.0.0")
  .annotate(
    OpenApi.Description,
    "Deployment authentication applies to application endpoints. API responses carry a server-generated X-Request-ID; errors contain error.code, error.message, and matching error.requestId. Missing/invalid authentication is 401, rejected origins are 403 origin_forbidden, invalid input is 400, conflicts are 409, capacity rejection is 429, and unexpected persistence/runtime failures are safe 500 responses. Native media responses use /media/v2; JSON control uses /api/v2. The Effect generator omits response-header schemas from decoded DTOs; callers needing X-Request-ID or native response metadata use a raw/paired HttpClient response mode, including on errors. HEAD responses have no body. MCP JSON-RPC remains separate. This replaces v1 without a compatibility facade.",
  )
  .annotate(OpenApi.Servers, [
    {
      url: "{serverBaseUrl}/api/v2",
      variables: {
        serverBaseUrl: {
          default: "http://localhost:8787",
          description: "Reachable VideoCutlist server base URL; transport provider independent.",
        },
      },
    },
  ])
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .annotate(HttpApi.SuccessParseOptions, { onExcessProperty: "error" })
  .add(DefaultGroup) {}
