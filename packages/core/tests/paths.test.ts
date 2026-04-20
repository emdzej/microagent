import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { paths } from "../src/paths.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("paths", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default XDG config path", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(paths.config()).toBe(join(homedir(), ".config", "microagent"));
  });

  it("respects XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    expect(paths.config()).toBe("/custom/config/microagent");
  });

  it("returns default XDG data path", () => {
    delete process.env.XDG_DATA_HOME;
    expect(paths.data()).toBe(join(homedir(), ".local", "share", "microagent"));
  });

  it("respects XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    expect(paths.data()).toBe("/custom/data/microagent");
  });

  it("returns default XDG cache path", () => {
    delete process.env.XDG_CACHE_HOME;
    expect(paths.cache()).toBe(join(homedir(), ".cache", "microagent"));
  });

  it("configFile returns config.json inside config dir", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(paths.configFile()).toBe(join(homedir(), ".config", "microagent", "config.json"));
  });
});
