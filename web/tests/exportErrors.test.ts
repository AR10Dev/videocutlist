import { Cause } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../src/api";
import { requestErrorMessage, resourceErrorMessage } from "../src/features/export/errors";

const envelope = {
  error: { code: "export_busy", message: "Export is busy.", requestId: "request-1" },
};

describe("export error messages", () => {
  it("preserves command errors and validated public envelopes", () => {
    expect(requestErrorMessage(new Error("Retry failed."), "Fallback")).toBe("Retry failed.");
    expect(requestErrorMessage(envelope, "Fallback")).toBe("Export is busy.");
  });

  it("uses the fallback for unknown or malformed command failures", () => {
    expect(requestErrorMessage("private details", "Fallback")).toBe("Fallback");
    expect(requestErrorMessage({ error: { message: "private details" } }, "Fallback")).toBe(
      "Fallback",
    );
  });

  it("returns no resource message before failure", () => {
    expect(resourceErrorMessage(AsyncResult.initial(), "Fallback")).toBe("");
    expect(resourceErrorMessage(AsyncResult.success("value"), "Fallback")).toBe("");
  });

  it("only exposes public resource failures", () => {
    const message = (failure: unknown) =>
      resourceErrorMessage(AsyncResult.failure(Cause.fail(failure)), "Fallback");
    expect(message(envelope)).toBe("Export is busy.");
    expect(message(new ApiFailure(409, envelope.error))).toBe("Export is busy.");
    expect(message(new Error("private details"))).toBe("Fallback");
    expect(message({ error: { message: "private details" } })).toBe("Fallback");
  });
});
