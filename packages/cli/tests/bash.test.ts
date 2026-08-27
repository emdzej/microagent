import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { ToolRegistry } from "@microagent/core";
import { bashTool } from "../src/tools/bash.js";
import { listDirTool } from "../src/tools/list-dir.js";

const posix = process.platform !== "win32";

function registry() {
  const reg = new ToolRegistry();
  reg.register(bashTool);
  reg.register(listDirTool);
  return reg;
}

const run = (
  command: string,
  ctx: { timeoutMs?: number; signal?: AbortSignal } = {},
  cwd?: string
) =>
  registry().execute(
    { id: "t", name: "bash", arguments: { command, ...(cwd ? { cwd } : {}) } },
    ctx
  );

describe("bash: normal operation", () => {
  it("returns stdout on success", async () => {
    const result = await run("echo hello");
    expect(result.content).toBe("hello\n");
    expect(result.isError).toBeUndefined();
  });

  it("reports a non-zero exit as a readable result, not an exception", async () => {
    const result = await run("echo out; echo err 1>&2; exit 3");
    expect(result.content).toContain("EXIT ERROR (code 3)");
    expect(result.content).toContain("stdout: out");
    expect(result.content).toContain("stderr: err");
  });

  it("honours cwd", async () => {
    const result = await run(posix ? "pwd" : "cd", {}, "/");
    expect(result.content.trim()).toBe(posix ? "/" : expect.anything());
  });

  it("turns a failure to start into an error result", async () => {
    const result = await run("echo hi", {}, "/nonexistent-directory-xyz");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool error");
  });

  it("still supports shell syntax", async () => {
    const result = await run("echo one && echo two | tr a-z A-Z");
    expect(result.content).toContain("one");
    expect(result.content).toContain("TWO");
  });
});

describe("bash: event loop", () => {
  /**
   * The regression that mattered most. `execSync` let the loop tick zero times
   * for the duration of the command, so one session's command stalled every
   * other session, the HTTP server, and every open SSE stream — which silently
   * undid the point of giving sessions their own histories.
   */
  it("does not block the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await run(posix ? "sleep 0.5" : "timeout 1");
    clearInterval(timer);

    expect(ticks).toBeGreaterThan(20);
  });

  it("runs two commands concurrently", async () => {
    const started = Date.now();
    await Promise.all([run("sleep 0.4"), run("sleep 0.4"), run("sleep 0.4")]);
    const elapsed = Date.now() - started;

    // Sequential execution would need ~1200ms.
    expect(elapsed).toBeLessThan(900);
  });
});

describe("bash: timeouts and cancellation", () => {
  /**
   * `execSync` ignores an `AbortSignal`, and a blocked loop cannot fire the
   * timer that would abort it anyway — so a 200ms cap against a 3s command used
   * to return after 3s *reporting success*.
   */
  it("is interrupted by the tool timeout", async () => {
    const started = Date.now();
    const result = await run("sleep 5; echo finished", { timeoutMs: 200 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 200ms");
    expect(result.content).not.toContain("finished");
  });

  it("is interrupted by an external abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const started = Date.now();
    const result = await run("sleep 5", { signal: controller.signal, timeoutMs: 60_000 });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("was cancelled");
  });

  it("returns immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const result = await run("sleep 5", { signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBe(true);
  });

  /**
   * Killing only the shell's own pid leaves the grandchildren of a compound
   * command running after the tool has returned, so the child is spawned into
   * its own process group and the group is signalled.
   */
  it.skipIf(!posix)("kills the whole process tree, not just the shell", async () => {
    const marker = `microagent-test-${process.pid}-${Date.now()}`;
    const reg = registry();

    // `& wait` so the sleep is a *background* child of the shell — the case
    // where killing only the shell's pid leaves it orphaned. The marker rides
    // along in the shell's argv so the test can find the process group.
    const pending = reg.execute(
      { id: "t", name: "bash", arguments: { command: `sleep 47 & wait # ${marker}` } },
      { timeoutMs: 300 }
    );

    // Let the shell start and background its child.
    await new Promise((r) => setTimeout(r, 150));
    const before = descendantSleeps(marker);

    await pending;
    // Past SIGTERM; well short of the SIGKILL grace period.
    await new Promise((r) => setTimeout(r, 500));

    expect(before.length).toBeGreaterThan(0);
    expect(before.filter(alive)).toEqual([]);
  });
});

describe("bash: output cap", () => {
  /**
   * `execSync` threw ENOBUFS past its `maxBuffer` and discarded everything
   * captured. Keeping what fits is more useful, as long as the clipping is
   * visible — a silently truncated result would be read as complete.
   */
  it.skipIf(!posix)("truncates huge output with a visible marker", async () => {
    const result = await run("head -c 1200000 < /dev/zero | tr '\\0' 'a'", { timeoutMs: 20_000 });

    expect(result.content).toContain("[output truncated at 1048576 bytes");
    expect(result.content.length).toBeLessThan(1024 * 1024 + 200);
  }, 30_000);
});

describe("list_directory", () => {
  it("lists entries with a type prefix", async () => {
    const result = await registry().execute(
      { id: "l", name: "list_directory", arguments: { path: "." } },
      {}
    );
    expect(result.content).toContain("f package.json");
    expect(result.content).toContain("d src");
  });

  it("does not block the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    // Enough iterations that a synchronous implementation would starve the loop.
    for (let i = 0; i < 40; i++) {
      await registry().execute(
        { id: `l${i}`, name: "list_directory", arguments: { path: "." } },
        {}
      );
    }
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it("errors on a missing directory", async () => {
    const result = await registry().execute(
      { id: "l", name: "list_directory", arguments: { path: "/nonexistent-dir-xyz" } },
      {}
    );
    expect(result.isError).toBe(true);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * PIDs of `sleep` processes belonging to the shell that carries our marker.
 *
 * Matched via the process group rather than a command-line grep: the test
 * runner's own command line can contain the script's text, which makes a naive
 * grep report phantom survivors.
 */
function descendantSleeps(marker: string): number[] {
  try {
    // Bracket the first character so the grep does not match itself.
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    const pgids = execSync(`ps -eo pid,pgid,command | grep '${pattern}' | awk '{print $2}'`)
      .toString()
      .trim();
    if (!pgids) return [];

    const pids = new Set<number>();
    for (const pgid of new Set(pgids.split("\n").map((s) => s.trim()))) {
      const group = execSync(
        `ps -eo pid,pgid,comm | awk '$2==${pgid} && $3 ~ /sleep/ {print $1}'`
      )
        .toString()
        .trim();
      for (const p of group ? group.split("\n") : []) pids.add(Number(p));
    }
    return [...pids];
  } catch {
    return [];
  }
}
