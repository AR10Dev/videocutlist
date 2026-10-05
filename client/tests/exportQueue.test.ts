import { describe, expect, it } from "vitest";
import { idempotencyKeyForAttempt } from "../src/features/export/queueResponse";
import * as Schema from "effect/Schema";
import { BatchExportSubmission } from "../src/generated/effect-api";

describe("export command submission", () => {
  it("reuses only an uncertain command's key for its identical semantic body", () => {
    const uncertain = { key: "previous-key", body: { projectRevision: 7, itemIds: ["i_1"] } };
    const freshKey = () => "new-key";

    expect(
      idempotencyKeyForAttempt(uncertain, { projectRevision: 7, itemIds: ["i_1"] }, freshKey),
    ).toBe("previous-key");
    expect(
      idempotencyKeyForAttempt(uncertain, { projectRevision: 8, itemIds: ["i_1"] }, freshKey),
    ).toBe("new-key");
    expect(idempotencyKeyForAttempt(undefined, uncertain.body, freshKey)).toBe("new-key");
  });
});

describe("generated export batch response schema", () => {
  const decode = Schema.decodeUnknownSync(BatchExportSubmission);

  it("rejects the old singleton job response", () => {
    expect(() => decode({ id: "job-1", state: "queued" })).toThrow();
  });

  const validChild = {
    id: "j_0123456789ab",
    type: "export",
    state: "queued",
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const responseWith = (job: unknown) => ({ batchId: "b_0123456789ab", jobs: [job] });

  it("accepts a valid child job", () => {
    expect(decode(responseWith(validChild)).jobs).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["revision type", { ...validChild, revision: "not-a-revision" }],
    ["state", { ...validChild, state: "unknown" }],
    ["progress", { ...validChild, progress: 2 }],
    ["missing createdAt", (({ createdAt: _createdAt, ...job }) => job)(validChild)],
    ["revision", { ...validChild, revision: 0 }],
  ])("rejects an invalid child %s before polling and queue rendering", (_field, job) => {
    expect(() => decode(responseWith(job))).toThrow();
  });
});
