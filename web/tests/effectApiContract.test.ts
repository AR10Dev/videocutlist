import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as Schema from "effect/Schema";
import {
  DetectionInput,
  ExportSubmissionInput,
  MCPCredentialCreated,
  Project,
  ProjectPage,
  PutProjectRequestJson,
  SettingsResponse,
  VideoCutListApi,
  Waveform,
} from "../src/generated/effect-api";

const project = {
  id: "p_123456789012",
  updatedAt: "2026-10-01T00:00:00Z",
  revision: 3,
  schemaVersion: 2 as const,
  name: "Fixture",
  items: [
    {
      id: "i_123456789012345678901234",
      mediaId: `m_${"a".repeat(43)}`,
      segments: [{ startMs: 0, endMs: 1200 }],
      exportOptions: {},
    },
  ],
};
const projectInput = {
  revision: project.revision,
  schemaVersion: project.schemaVersion,
  name: project.name,
  items: project.items,
};
const completedJob = {
  id: "j_123456789012",
  type: "export",
  state: "succeeded",
  revision: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:01Z",
};

describe("generated Effect response codecs", () => {
  it("accepts omitted and future media-root reason codes", () => {
    const response = {
      settings: {
        exportLimit: 2,
        cacheMaxBytes: 1000,
        previewGlobalLimit: 2,
        previewBeforeMs: 1000,
        previewAfterMs: 1000,
        previewMaxMs: 5000,
        previewGridMs: 1000,
        mediaMaxFiles: 100,
        mediaMaxDepth: 4,
        mcpEnabled: false,
      },
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-10-01T00:00:00Z",
      pathsConstrained: false,
      roots: { archive: { state: "unavailable", message: "Mount unavailable." } },
    };
    expect(Schema.decodeUnknownSync(SettingsResponse)(response).roots.archive).toEqual(
      response.roots.archive,
    );
    const futureReason = {
      ...response,
      roots: { archive: { ...response.roots.archive, reasonCode: "future_reason" } },
    };
    expect(Schema.decodeUnknownSync(SettingsResponse)(futureReason).roots.archive.reasonCode).toBe(
      "future_reason",
    );
  });

  it("decodes the native waveform contract without adding its route to JSON HttpApi", () => {
    const waveform = { startMs: 0, durationMs: 1000, peaks: Array(16).fill(0.5) };
    expect(Schema.decodeUnknownSync(Waveform)(waveform)).toEqual(waveform);
    expect(() => Schema.decodeUnknownSync(Waveform)({ ...waveform, peaks: "malformed" })).toThrow();

    const endpoints: Array<{ identifier: string; path: string }> = [];
    HttpApi.reflect(VideoCutListApi, {
      onGroup: () => undefined,
      onEndpoint: ({ endpoint }) => {
        endpoints.push({ identifier: endpoint.identifier, path: endpoint.path });
      },
    });
    expect(
      endpoints.some(
        ({ identifier, path }) =>
          identifier.toLowerCase().includes("waveform") || path.toLowerCase().includes("waveform"),
      ),
    ).toBe(false);
  });
  it("decodes actual-shaped project and credential fixtures and rejects malformed data", () => {
    expect(Schema.decodeUnknownSync(Project)(project)).toEqual(project);
    expect(Schema.decodeUnknownSync(ExportSubmissionInput)({ projectRevision: 3 })).toEqual({
      projectRevision: 3,
    });
    expect(() => Schema.decodeUnknownSync(ExportSubmissionInput)({})).toThrow();
    const detection = {
      mediaId: project.items[0].mediaId,
      projectItemId: project.items[0].id,
      projectRevision: 3,
      kind: "silence" as const,
    };
    expect(Schema.decodeUnknownSync(DetectionInput)(detection)).toEqual(detection);
    expect(() =>
      Schema.decodeUnknownSync(DetectionInput)({ ...detection, projectRevision: undefined }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Project)({ ...project, revision: 0 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Project, { onExcessProperty: "error" })({
        ...project,
        filesystemPath: "/private",
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Project)({ ...project, items: [] })).toThrow();
    const credential = {
      id: "credential-id",
      tokenIdentifier: "t_identifier",
      name: "review",
      permissions: ["project.read"],
      mediaScope: { kind: "all" },
      projectScope: { kind: "all" },
      unattendedExports: false,
      createdAt: "2026-10-01T00:00:00Z",
      secret: "one-time-secret",
    };
    expect(Schema.decodeUnknownSync(MCPCredentialCreated)(credential)).toEqual(credential);
    expect(() =>
      Schema.decodeUnknownSync(MCPCredentialCreated)({ ...credential, secret: 42 }),
    ).toThrow();
  });

  it.effect(
    "executes generated client reads, revision-aware mutation, and terminal job decoding",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        let submissionHeader: string | undefined;
        const httpClient = HttpClient.make((request, url) => {
          requests++;
          const method = request.method;
          const response =
            url.pathname.endsWith("/projects") && method === "GET"
              ? Response.json(
                  {
                    items: [
                      {
                        id: project.id,
                        name: project.name,
                        revision: 3,
                        updatedAt: project.updatedAt,
                      },
                    ],
                    nextCursor: "cursor-next",
                  },
                  { headers: { "X-Request-ID": "req-page" } },
                )
              : url.pathname.endsWith(`/projects/${project.id}`) && method === "GET"
                ? Response.json({ ...project, filesystemPath: "/private" })
                : url.pathname.endsWith(`/projects/${project.id}`) &&
                    method === "PUT" &&
                    requests === 3
                  ? Response.json(project)
                  : url.pathname.endsWith(`/projects/${project.id}`) && method === "PUT"
                    ? Response.json(
                        {
                          error: {
                            code: "revision_conflict",
                            message: "Revision conflict",
                            requestId: "fixture",
                          },
                        },
                        { status: 409, headers: { "X-Request-ID": "req-conflict" } },
                      )
                    : url.pathname.endsWith("/media/refresh") && method === "POST"
                      ? Response.json(
                          { id: "j_123456789012", state: "queued", progress: 0, indexed: 0 },
                          { status: 202 },
                        )
                      : url.pathname.endsWith(`/jobs/${completedJob.id}`)
                        ? Response.json(completedJob)
                        : Response.json(
                            {
                              error: {
                                code: "not_found",
                                message: "Not found",
                                requestId: "fixture",
                              },
                            },
                            { status: 404 },
                          );
          if (url.pathname.endsWith("/media/refresh")) {
            submissionHeader =
              request.headers["Idempotency-Key"] ?? request.headers["idempotency-key"];
          }
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
        const client = yield* HttpApiClient.makeWith(VideoCutListApi, {
          httpClient,
          baseUrl: "https://api.example.test/api/v2",
        });
        const page = yield* client.listProjects({ query: { limit: 1 } });
        expect(Schema.decodeUnknownSync(ProjectPage)(page).nextCursor).toBe("cursor-next");
        const headerResponse = yield* client.listProjects({
          query: { limit: 1 },
          responseMode: "response-only",
        });
        expect(headerResponse.headers["x-request-id"]).toBe("req-page");
        const saved = yield* client.putProject({
          params: { projectId: project.id },
          payload: projectInput,
        });
        expect(Schema.decodeUnknownSync(Project)(saved).revision).toBe(3);
        const invalidInput = yield* Effect.exit(
          client.putProject({
            params: { projectId: project.id },
            payload: {
              ...projectInput,
              filesystemPath: "/private",
            } as unknown as PutProjectRequestJson,
          }),
        );
        expect(Exit.isFailure(invalidInput)).toBe(true);
        expect(requests).toBe(3);
        const invalidResponse = yield* Effect.exit(
          client.getProject({ params: { projectId: project.id } }),
        );
        expect(Exit.isFailure(invalidResponse)).toBe(true);
        const conflict = yield* Effect.exit(
          client.putProject({ params: { projectId: project.id }, payload: projectInput }),
        );
        expect(Exit.isFailure(conflict)).toBe(true);
        const conflictResponse = yield* client.putProject({
          params: { projectId: project.id },
          payload: projectInput,
          responseMode: "response-only",
        });
        expect(conflictResponse.status).toBe(409);
        expect(conflictResponse.headers["x-request-id"]).toBe("req-conflict");
        const invalidKey = yield* Effect.exit(
          client.refreshMedia({ headers: { "Idempotency-Key": "bad key" } }),
        );
        expect(Exit.isFailure(invalidKey)).toBe(true);
        expect(requests).toBe(6);
        yield* client.refreshMedia({ headers: { "Idempotency-Key": "submission-key-01" } });
        expect(submissionHeader).toBe("submission-key-01");
        const job = yield* client.getJob({ params: { jobId: completedJob.id } });
        expect(job.state).toBe("succeeded");
        expect(job.revision).toBe(1);
        expect(requests).toBe(8);
      }),
  );

  it.effect("exposes the same paginated resource through AtomHttpApi", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ items: [], nextCursor: null })),
        ),
      );
      const Api = AtomHttpApi.Service()("ContractProofApi", {
        api: VideoCutListApi,
        httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
        baseUrl: "https://api.example.test/api/v2",
      });
      const registry = AtomRegistry.make();
      const atom = Api.query("default", "listProjects", { query: { limit: 2 } });
      registry.mount(atom);
      const result = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      registry.dispose();
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    }),
  );
});
