import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function startApp(root: string, token: string) {
  const binary = process.env.VIDEOCUTLIST_E2E_BINARY;
  if (!binary) throw new Error("Run make e2e (missing built binary)");
  let child: ChildProcess | undefined;
  let logs = "";
  let baseURL = "";
  const stop = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const exited = once(current, "exit");
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-current.pid!, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    const timeout = setTimeout(() => kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  };
  const start = async () => {
    child = spawn(binary, [], {
      env: {
        ...process.env,
        VIDEOCUTLIST_DATABASE_PATH: resolve(root, "app.db"),
        VIDEOCUTLIST_CACHE_DIR: resolve(root, "cache"),
        VIDEOCUTLIST_EXPORT_DIR: resolve(root, "exports"),
        VIDEOCUTLIST_MEDIA_ROOTS_JSON: JSON.stringify({ fixture: resolve(root, "media") }),
        VIDEOCUTLIST_LISTEN_ADDRESS: "127.0.0.1",
        VIDEOCUTLIST_PORT: "0",
        VIDEOCUTLIST_AUTH_MODE: "bearer",
        VIDEOCUTLIST_BEARER_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
    });
    baseURL = "";
    const collect = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-64 * 1024);
      const match = logs.match(/"listen_addr":"(127\.0\.0\.1:[0-9]+)"/);
      if (match) baseURL = `http://${match[1]}`;
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `App exited during startup (${child.exitCode ?? child.signalCode})\n${logs.split(token).join("[redacted]")}`,
        );
      if (baseURL) {
        try {
          const ready = await fetch(`${baseURL}/ready`, { signal: AbortSignal.timeout(1_000) });
          await ready.body?.cancel();
          if (ready.ok) {
            const status = await fetch(`${baseURL}/api/v2/media/status`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(1_000),
            });
            const body = (await status.json()) as { state: string };
            if (status.ok && ["ready_with_media", "ready_empty"].includes(body.state)) return;
            if (body.state === "failed")
              throw new Error(`Initial media scan failed: ${JSON.stringify(body)}`);
          }
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
        }
      }
      await delay(100);
    }
    throw new Error(`App did not become ready\n${logs.split(token).join("[redacted]")}`);
  };
  try {
    await start();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    get baseURL() {
      return baseURL;
    },
    get logs() {
      return logs.split(token).join("[redacted]");
    },
    token,
    mediaRoot: resolve(root, "media"),
    stop,
    async restart() {
      await stop();
      logs = "";
      await start();
    },
  };
}
