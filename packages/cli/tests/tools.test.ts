import { describe, it, expect } from "vitest";
import { fileReadTool } from "../src/tools/file-read.js";
import { listDirTool } from "../src/tools/list-dir.js";

describe("built-in tools", () => {
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
