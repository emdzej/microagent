import type { ToolPlugin } from "@microagent/core";
import { spawn } from "node:child_process";

/** Fallback ceiling for callers that pass no signal of their own. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** How long a terminated command gets to exit before it is killed outright. */
const KILL_GRACE_MS = 2_000;

export const bashTool: ToolPlugin = {
  definition: {
    name: "bash",
    description: "Execute a bash command and return stdout/stderr",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
  async execute(args, ctx) {
    return runShell({
      command: String(args.command),
      cwd: args.cwd ? String(args.cwd) : process.cwd(),
      signal: ctx?.signal,
    });
  },
};

/**
 * Run a shell command without blocking the event loop.
 *
 * This used to be `execSync`, which had two consequences that only became
 * visible once sessions ran concurrently:
 *
 * 1. **It froze the process.** A one-second command let the event loop tick
 *    zero times — so one session's command stalled every other session, the
 *    HTTP server, and every open SSE stream.
 * 2. **It could not be interrupted.** `execSync` ignores an `AbortSignal`, and
 *    a blocked loop cannot fire the timer that would abort it anyway. A
 *    `toolTimeoutMs` of 200ms against `sleep 3` returned after 3s reporting
 *    success.
 *
 * `shell: true` is kept so the shell resolution matches the old behaviour
 * (`/bin/sh -c` on POSIX, `cmd.exe` on Windows) rather than quietly changing
 * which interpreter runs the command.
 */
async function runShell(opts: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      // Own process group, so terminating reaps the whole tree. Killing only
      // the shell's pid leaves the grandchildren of a compound command
      // (`sleep 60 & wait`) running after the tool has returned.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    /** Terminate the process group, escalating if it does not go quietly. */
    const terminate = () => {
      if (child.pid === undefined) return;
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      terminate();
      // Reject rather than returning the partial output: the caller's registry
      // turns this into an explicit "timed out" or "was cancelled" result, and
      // returning partial output would look like a completed command.
      finish(() => reject(new Error("command aborted")));
    };

    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new Error(`command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    if (opts.signal) {
      if (opts.signal.aborted) {
        finish(() => reject(new Error("command aborted")));
        terminate();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const collect = (chunk: Buffer, onto: "stdout" | "stderr") => {
      if (truncated) return;
      const text = chunk.toString("utf-8");
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (text.length >= remaining) {
        // Keep what fits and stop the command, rather than throwing ENOBUFS and
        // discarding everything captured so far as `execSync` did.
        const kept = text.slice(0, Math.max(0, remaining));
        if (onto === "stdout") stdout += kept;
        else stderr += kept;
        bytes = MAX_OUTPUT_BYTES;
        truncated = true;
        terminate();
        return;
      }
      bytes += text.length;
      if (onto === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));

    // Fires when the command could not be started at all — a missing cwd, for
    // example. `execSync` threw here too, and the registry turns a throw into a
    // clear error result.
    child.on("error", (err) => finish(() => reject(err)));

    child.on("close", (code, signal) => {
      const note = truncated
        ? `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes; command terminated]`
        : "";

      finish(() => {
        if (code === 0) return resolve(stdout + note);
        // Same shape as before: a non-zero exit is a result the model can read
        // and react to, not an exception.
        resolve(
          `EXIT ERROR (${signal ? `signal ${signal}` : `code ${code}`})\n` +
            `stdout: ${stdout}\nstderr: ${stderr}${note}`
        );
      });
    });
  });
}

/**
 * Signal the child's whole process group where the platform supports it.
 *
 * A negative pid addresses the group, which is why the child is spawned
 * detached. Windows has no process groups in this sense, so the child is
 * signalled directly there.
 */
function signalGroup(child: { pid?: number; kill: (s: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already exited, or the group is gone. Nothing to do.
  }
}
