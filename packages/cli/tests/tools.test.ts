import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, pathConfinementPolicy } from "@microagent/core";
import type { PolicyContext } from "@microagent/core";
import { fileReadTool } from "../src/tools/file-read.js";
import { listDirTool } from "../src/tools/list-dir.js";
import { registerBuiltinTools } from "../src/tools/index.js";

describe("built-in tools", () => {
  it("registers the expected set", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    expect(registry.list().sort()).toEqual(["bash", "file_read", "file_write", "list_directory"]);
  });

  it("file_read reads a file", async () => {
    const result = await fileReadTool.execute({ path: "package.json" });
    expect(result).toContain("@microagent/cli");
  });

  it("list_directory lists entries", async () => {
    const result = await listDirTool.execute({ path: "." });
    expect(result).toContain("package.json");
  });

  it("file_read errors on missing file", async () => {
    await expect(fileReadTool.execute({ path: "/nonexistent-file-xyz" })).rejects.toThrow();
  });
});

/**
 * The built-in tools resolve any path they are given — for a local coding agent
 * that is the feature. A deployment that needs a boundary installs the policy,
 * which is checked here against the real tools rather than a stand-in, since the
 * whole risk is that the policy and the tool resolve different things.
 */
describe("path confinement against the real tools", () => {
  const ctx: PolicyContext = { sessionId: "s", round: 1, correlationId: "c" };
  let root: string;
  let outside: string;
  let cwd: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "confine-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "confine-out-")));
    writeFileSync(join(root, "inside.txt"), "allowed");
    writeFileSync(join(outside, "config.json"), '{"apiKey":"sk-live-secret"}');
    cwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lets an allowed read through, using the rewritten path", async () => {
    const policy = pathConfinementPolicy({ root });
    const decision = await policy.check(
      { id: "1", name: "file_read", arguments: { path: "inside.txt" } },
      ctx
    );

    expect(decision.action).toBe("rewrite");
    if (decision.action !== "rewrite") return;

    // The tool is handed exactly what the policy checked.
    await expect(fileReadTool.execute(decision.arguments)).resolves.toBe("allowed");
  });

  it("blocks a read of a secret outside the root before the tool runs", async () => {
    const policy = pathConfinementPolicy({ root });
    const target = join(outside, "config.json");

    const decision = await policy.check(
      { id: "1", name: "file_read", arguments: { path: target } },
      ctx
    );
    expect(decision.action).toBe("deny");

    // Confirms the file really was readable — the policy is what stopped it,
    // not a missing file.
    await expect(fileReadTool.execute({ path: target })).resolves.toContain("sk-live-secret");
  });
});
