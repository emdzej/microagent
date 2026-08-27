import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PolicyDecision, ToolCall, ToolPolicy } from "./types.js";

/**
 * Ready-made tool policies.
 *
 * Deliberately opt-in. A local coding agent reading a file outside its working
 * directory is the feature, not the bug, so nothing here is installed by
 * default — a deployment that needs a boundary asks for one.
 */

export interface PathConfinementOptions {
  /** Directory every path argument must resolve inside. */
  root: string;
  /**
   * Argument names treated as paths.
   * Defaults to `path`, `cwd`, `file`, `filename`, `directory`, `dir`.
   */
  pathArguments?: string[];
  /**
   * Restrict the check to these tools. By default every tool is checked, and a
   * call carrying none of the path arguments is allowed through untouched.
   */
  tools?: string[];
}

const DEFAULT_PATH_ARGUMENTS = ["path", "cwd", "file", "filename", "directory", "dir"];

/**
 * Confine a tool's path arguments to a root directory.
 *
 * Two details that make the difference between confinement and a check that
 * merely looks like one:
 *
 * - **Symlinks are resolved** on every component that exists, so a link inside
 *   the root pointing out of it is rejected. Checking the literal string would
 *   miss that entirely.
 * - **Allowed calls are rewritten** to the absolute, resolved path. The tools
 *   call `path.resolve()` themselves, against the process working directory; if
 *   the policy checked one path and the tool then resolved a different one, the
 *   check would be decoration. Rewriting removes the possibility of
 *   disagreement.
 *
 * Known limitation: a symlink swapped between this check and the tool's open
 * would still escape. Closing that needs `openat`/`O_NOFOLLOW` inside each
 * tool, which Node does not expose — so treat this as a boundary against a
 * confused model, not against a local attacker racing the filesystem.
 */
export function pathConfinementPolicy(options: PathConfinementOptions): ToolPolicy {
  const names = options.pathArguments ?? DEFAULT_PATH_ARGUMENTS;
  const scoped = options.tools ? new Set(options.tools) : undefined;

  return {
    async check(call: ToolCall): Promise<PolicyDecision> {
      if (scoped && !scoped.has(call.name)) return { action: "allow" };

      const present = names.filter(
        (name) => typeof call.arguments[name] === "string" && call.arguments[name] !== ""
      );
      if (!present.length) return { action: "allow" };

      let realRoot: string;
      try {
        realRoot = await realpath(resolve(options.root));
      } catch {
        // A root that does not exist cannot confine anything. Fail closed
        // rather than silently allowing every path.
        return {
          action: "deny",
          reason: `path confinement root ${options.root} does not exist`,
        };
      }

      const rewritten: Record<string, unknown> = { ...call.arguments };

      for (const name of present) {
        const candidate = String(call.arguments[name]);
        const resolved = await resolveWithinRoot(candidate);

        const rel = relative(realRoot, resolved);
        const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
        if (!inside) {
          return {
            action: "deny",
            reason: `${name} must stay inside ${realRoot} (resolved to ${resolved})`,
          };
        }
        rewritten[name] = resolved;
      }

      return { action: "rewrite", arguments: rewritten };
    },
  };
}

/**
 * Resolve a path, following symlinks as far as the filesystem allows.
 *
 * Resolved against the process working directory, matching what the built-in
 * tools do. `realpath` needs the target to exist, which it will not for a file
 * about to be written — so the nearest existing ancestor is resolved and the
 * remaining segments appended. `resolve` has already collapsed any `..`, so the
 * appended tail cannot climb back out.
 */
async function resolveWithinRoot(candidate: string): Promise<string> {
  const resolved = resolve(candidate);

  let existing = resolved;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = await realpath(existing);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolved; // reached the filesystem root
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Deny a fixed set of tools.
 *
 * Useful for turning off a capability the deployment does not want without
 * unregistering the tool — the model still sees it and is told plainly why it
 * cannot use it, rather than working around a gap it cannot see.
 */
export function denyToolsPolicy(tools: string[], reason?: string): ToolPolicy {
  const denied = new Set(tools);
  return {
    check(call) {
      if (!denied.has(call.name)) return { action: "allow" };
      return {
        action: "deny",
        reason: reason ?? `tool ${call.name} is disabled on this deployment`,
      };
    },
  };
}

/**
 * Run several policies in order, stopping at the first denial.
 *
 * A rewrite from one policy is visible to the next, so an argument-normalising
 * policy can be composed in front of one that inspects those arguments.
 */
export function composePolicies(policies: ToolPolicy[]): ToolPolicy {
  return {
    async check(call, ctx) {
      let current = call;
      let rewritten = false;

      for (const policy of policies) {
        const decision = await policy.check(current, ctx);
        if (decision.action === "deny") return decision;
        if (decision.action === "rewrite") {
          current = { ...current, arguments: decision.arguments };
          rewritten = true;
        }
      }

      return rewritten ? { action: "rewrite", arguments: current.arguments } : { action: "allow" };
    },
  };
}
