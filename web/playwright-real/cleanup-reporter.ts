import { rm } from "node:fs/promises";
import type { Reporter } from "@playwright/test/reporter";

export default class CleanupReporter implements Reporter {
  constructor(private readonly options: { directory: string }) {}
  printsToStdio() {
    return false;
  }

  async onEnd() {
    await rm(this.options.directory, { recursive: true, force: true });
  }
}
