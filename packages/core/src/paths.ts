import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "microagent";

/** XDG Base Directory paths */
export const paths = {
  /** Config files (e.g. microagent.config.json) */
  config(): string {
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, APP_NAME);
  },

  /** Persistent data (e.g. cached tokens) */
  data(): string {
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    return join(base, APP_NAME);
  },

  /** Cache (e.g. temporary session tokens) */
  cache(): string {
    const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
    return join(base, APP_NAME);
  },

  /** Default config file path */
  configFile(): string {
    return join(paths.config(), "config.json");
  },
};
