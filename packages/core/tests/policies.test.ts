import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composePolicies,
  denyToolsPolicy,
  pathConfinementPolicy,
} from "../src/policies.js";
import type { PolicyContext, ToolCall } from "../src/types.js";

const ctx: PolicyContext = { sessionId: "s1", round: 1, correlationId: "c1" };

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "call_1",
  name,
  arguments: args,
});

let root: string;
let outside: string;
let cwd: string;

beforeEach(() => {
  // `realpathSync` because macOS puts temp dirs under a symlinked /var.
  root = realpathSync(mkdtempSync(join(tmpdir(), "microagent-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "microagent-outside-")));
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "nested", "ok.txt"), "fine");
  writeFileSync(join(outside, "secret.txt"), "do not read me");

  cwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("pathConfinementPolicy", () => {
  it("allows a path inside the root and rewrites it to an absolute path", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(call("file_read", { path: "nested/ok.txt" }), ctx);

    // Rewritten rather than merely allowed: the tools call `path.resolve()`
    // themselves, so handing them the checked path is what stops the policy and
    // the tool from resolving different things.
    expect(decision).toEqual({
      action: "rewrite",
      arguments: { path: join(root, "nested", "ok.txt") },
    });
  });

  it("allows the root itself", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(call("list_directory", { path: root }), ctx);
    expect(decision.action).toBe("rewrite");
  });

  it("denies an absolute path outside the root", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(
      call("file_read", { path: join(outside, "secret.txt") }),
      ctx
    );

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("must stay inside");
    }
  });

  it("denies traversal out of the root", async () => {
    const policy = pathConfinementPolicy({ root });
    for (const path of ["../escape.txt", "nested/../../escape.txt", "nested/../.."]) {
      const decision = await policy.check(call("file_write", { path }), ctx);
      expect(decision.action, path).toBe("deny");
    }
  });

  /**
   * The case a string check misses entirely: the path never mentions the target
   * directory, so only resolving the link reveals that it leaves the root.
   */
  it("denies a symlink pointing out of the root", async () => {
    symlinkSync(outside, join(root, "escape-link"));
    const policy = pathConfinementPolicy({ root });

    const decision = await policy.check(
      call("file_read", { path: "escape-link/secret.txt" }),
      ctx
    );
    expect(decision.action).toBe("deny");
  });

  it("allows a symlink that stays inside the root", async () => {
    symlinkSync(join(root, "nested"), join(root, "inside-link"));
    const policy = pathConfinementPolicy({ root });

    const decision = await policy.check(call("file_read", { path: "inside-link/ok.txt" }), ctx);
    expect(decision.action).toBe("rewrite");
    if (decision.action === "rewrite") {
      expect(decision.arguments.path).toBe(join(root, "nested", "ok.txt"));
    }
  });

  /** A file about to be created does not exist yet, so `realpath` cannot see it. */
  it("allows a not-yet-existing path inside the root", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(
      call("file_write", { path: "nested/deep/new-file.txt" }),
      ctx
    );

    expect(decision.action).toBe("rewrite");
    if (decision.action === "rewrite") {
      expect(decision.arguments.path).toBe(join(root, "nested", "deep", "new-file.txt"));
    }
  });

  it("denies a not-yet-existing path outside the root", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(
      call("file_write", { path: join(outside, "deep", "new-file.txt") }),
      ctx
    );
    expect(decision.action).toBe("deny");
  });

  it("checks every configured path argument, including cwd", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(
      call("bash", { command: "ls", cwd: outside }),
      ctx
    );

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.reason).toContain("cwd");
  });

  it("leaves a call with no path arguments untouched", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(call("bash", { command: "echo hi" }), ctx);
    expect(decision).toEqual({ action: "allow" });
  });

  it("can be scoped to specific tools", async () => {
    const policy = pathConfinementPolicy({ root, tools: ["file_read"] });

    const checked = await policy.check(call("file_read", { path: outside }), ctx);
    expect(checked.action).toBe("deny");

    const unchecked = await policy.check(call("file_write", { path: outside }), ctx);
    expect(unchecked).toEqual({ action: "allow" });
  });

  it("honours a custom argument name list", async () => {
    const policy = pathConfinementPolicy({ root, pathArguments: ["target"] });

    const checked = await policy.check(call("custom", { target: outside }), ctx);
    expect(checked.action).toBe("deny");

    // `path` is no longer in the list, so it is not inspected.
    const ignored = await policy.check(call("custom", { path: outside }), ctx);
    expect(ignored).toEqual({ action: "allow" });
  });

  /** A root that cannot be resolved must not silently confine nothing. */
  it("fails closed when the root does not exist", async () => {
    const policy = pathConfinementPolicy({ root: join(root, "absent") });
    const decision = await policy.check(call("file_read", { path: "anything" }), ctx);

    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.reason).toContain("does not exist");
  });
});

describe("denyToolsPolicy", () => {
  it("denies the named tools and allows the rest", async () => {
    const policy = denyToolsPolicy(["bash"], "shell access is off here");

    const denied = await policy.check(call("bash", { command: "rm -rf /" }), ctx);
    expect(denied).toEqual({ action: "deny", reason: "shell access is off here" });

    expect(await policy.check(call("file_read", { path: "x" }), ctx)).toEqual({
      action: "allow",
    });
  });

  it("supplies a default reason", async () => {
    const policy = denyToolsPolicy(["bash"]);
    const decision = await policy.check(call("bash", {}), ctx);
    if (decision.action === "deny") expect(decision.reason).toContain("bash is disabled");
  });
});

describe("composePolicies", () => {
  it("stops at the first denial", async () => {
    const calls: string[] = [];
    const policy = composePolicies([
      {
        check: () => {
          calls.push("first");
          return { action: "deny", reason: "nope" };
        },
      },
      {
        check: () => {
          calls.push("second");
          return { action: "allow" };
        },
      },
    ]);

    expect(await policy.check(call("t", {}), ctx)).toEqual({ action: "deny", reason: "nope" });
    expect(calls).toEqual(["first"]);
  });

  /** A rewrite has to be visible downstream, or composition would be misleading. */
  it("feeds one policy's rewrite to the next", async () => {
    let seen: unknown;
    const policy = composePolicies([
      { check: (c) => ({ action: "rewrite", arguments: { ...c.arguments, since: "1h" } }) },
      {
        check: (c) => {
          seen = c.arguments;
          return { action: "allow" };
        },
      },
    ]);

    const decision = await policy.check(call("logs", { namespace: "prod" }), ctx);
    expect(seen).toEqual({ namespace: "prod", since: "1h" });
    expect(decision).toEqual({
      action: "rewrite",
      arguments: { namespace: "prod", since: "1h" },
    });
  });

  it("reports plain allow when nothing rewrote", async () => {
    const policy = composePolicies([
      { check: () => ({ action: "allow" }) },
      { check: () => ({ action: "allow" }) },
    ]);
    expect(await policy.check(call("t", {}), ctx)).toEqual({ action: "allow" });
  });

  it("combines confinement with a tool denial", async () => {
    const policy = composePolicies([
      denyToolsPolicy(["bash"]),
      pathConfinementPolicy({ root }),
    ]);

    expect((await policy.check(call("bash", { command: "ls" }), ctx)).action).toBe("deny");
    expect((await policy.check(call("file_read", { path: outside }), ctx)).action).toBe("deny");
    expect((await policy.check(call("file_read", { path: "nested/ok.txt" }), ctx)).action).toBe(
      "rewrite"
    );
  });
});
