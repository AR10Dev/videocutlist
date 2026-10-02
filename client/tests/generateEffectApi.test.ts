import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const generatedPath = new URL("../src/generated/effect-api.ts", import.meta.url);

describe("Effect API generator", () => {
  it("exports the native waveform schema without its route in JSON HttpApi", () => {
    const generated = readFileSync(generatedPath, "utf8");
    expect(generated).toContain("export const Waveform = Schema.StructWithRest(");
    expect(generated).not.toContain("getWaveform");
  });
});
