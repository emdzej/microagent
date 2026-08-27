import type {
  ContentPart,
  Message,
  Principal,
  RunToolCall,
  StopReason,
  TokenUsage,
  ToolCall,
} from "./types.js";

/**
 * How much content the audit trail records.
 *
 * Separate levels because prompts and tool results are the most sensitive data
 * the agent touches — whatever the tools gathered ends up in them — and the
 * right amount to persist differs between a laptop, a staging cluster, and a
 * production system with a retention policy. Defaulting to `metadata` means
 * turning on content capture is always a deliberate act.
 */
export type AuditLevel =
  /** Outcomes, names, counts, usage. No prompt, argument, or result text. */
  | "metadata"
  /** Adds the user input, the model's response, tool arguments and results. */
  | "io"
  /** Adds the full message history as sent to the provider. */
  | "full";

/** Which field a redactor is being asked to scrub. */
export interface AuditRedactionContext {
  field: "system" | "input" | "response" | "message" | "tool_arguments" | "tool_result";
  sessionId: string;
  correlationId: string;
  /** Set for `tool_arguments` and `tool_result`. */
  toolName?: string;
  /** Message role, set for `message`. */
  role?: string;
}

/**
 * Scrubs text on its way into a record.
 *
 * A hook rather than built-in rules: what counts as a secret is
 * deployment-specific knowledge — which token formats, which customer
 * identifiers, which internal hostnames — and encoding one product's rules into
 * a generic runtime would be both wrong and quietly incomplete.
 *
 * Applied to every recorded string, including each string nested inside tool
 * arguments.
 */
export type AuditRedactor = (value: string, ctx: AuditRedactionContext) => string;

export interface AuditOptions {
  /** Default `"metadata"`. */
  level?: AuditLevel;
  /**
   * Cap on any single recorded text field. Default 8192 characters.
   *
   * A tool that returns a 40MB log dump would otherwise put all of it in the
   * audit stream, where it is both a cost and a liability.
   */
  maxFieldChars?: number;
  /**
   * Emit a record as each tool call finishes, rather than only in the turn
   * summary. Default true.
   *
   * Batching everything until turn end means a long-running turn's tool calls
   * are invisible while they run, and lost entirely if the process dies
   * mid-turn — which is exactly when the trail matters.
   */
  perToolCall?: boolean;
  redact?: AuditRedactor;
}

export const DEFAULT_MAX_FIELD_CHARS = 8192;

// ── Record shapes ──────────────────────────────────────────────────────────

interface AuditBase {
  /** ISO 8601. */
  timestamp: string;
  correlationId: string;
  sessionId: string;
  principal?: AuditActor;
}

export interface AuditActor {
  subject: string;
  email?: string;
  clientId?: string;
  groups?: string[];
}

/**
 * One record per turn.
 *
 * Distinct from `UsageStats`, which aggregates counters for a human reading a
 * summary. This is the per-turn trail an agent that touches production needs:
 * who asked, which model answered, why it stopped, what it spent, and every
 * tool call with its arguments and outcome. Aggregates cannot answer "what did
 * this caller do at 03:14", and that is the question that gets asked.
 */
export interface AuditTurnRecord extends AuditBase {
  type: "turn";
  provider: string;
  model: string;
  stopReason: StopReason;
  rounds: number;
  usage: TokenUsage;
  durationMs: number;
  toolCalls: AuditToolCall[];
  /** Present at `io` and `full`. */
  prompt?: AuditPrompt;
  /** The model's final text. Present at `io` and `full`. */
  response?: string;
  /** Set when the turn ended in `error`. */
  error?: string;
  /** Set when a requested schema failed to validate. */
  schemaError?: string;
}

/**
 * One record per tool call, emitted as the call finishes.
 *
 * Duplicates what the turn summary will also carry, on purpose: this one exists
 * before the turn ends.
 */
export interface AuditToolCallRecord extends AuditBase {
  type: "tool_call";
  provider: string;
  model: string;
  round: number;
  call: AuditToolCall;
}

export type AuditRecord = AuditTurnRecord | AuditToolCallRecord;

/** Backwards-compatible alias — `AuditRecord` used to mean the turn record. */
export type AuditEntry = AuditRecord;

export interface AuditToolCall extends RunToolCall {
  /**
   * The call's arguments as the model produced them — after any policy rewrite,
   * so the record reflects what actually ran.
   *
   * Present at `io` and `full`.
   */
  arguments?: Record<string, unknown>;
  /** What the tool returned. Present at `io` and `full`. */
  result?: string;
  /** Which tool set supplied the tool, e.g. the MCP server name. */
  source?: string;
  /** Policy denial reason, when the call was denied. */
  denyReason?: string;
}

/**
 * The prompt as the provider received it.
 *
 * `messages` is the turn's history at the point the turn ended, which is the
 * concatenation of everything sent across its rounds — recording each round's
 * full history separately would be quadratic in size for no extra information.
 */
export interface AuditPrompt {
  system?: string;
  /** This turn's user input. */
  input?: string;
  /** Names of the tools offered to the model. */
  tools?: string[];
  /** Present at `full` only. */
  messages?: AuditMessage[];
}

export interface AuditMessage {
  role: Message["role"];
  content?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
  /**
   * Non-text parts, as descriptions rather than payloads — an inline base64
   * image would otherwise dominate the record.
   */
  attachments?: string[];
}

/** Where audit records go. */
export interface AuditSink {
  record(entry: AuditRecord): void;
}

/**
 * Emits one JSON object per line on stdout.
 *
 * Structured JSON to stdout rather than a file: in a container that is what a
 * log collector already reads, and it keeps the runtime free of log rotation.
 */
export class JsonAuditSink implements AuditSink {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(l)) {}

  record(entry: AuditRecord): void {
    try {
      this.write(JSON.stringify(entry) + "\n");
    } catch {
      // A record that cannot be serialised must not take the turn down with it.
      // Fall back to a minimal entry so the event is still counted.
      this.write(
        JSON.stringify({
          type: entry.type,
          timestamp: entry.timestamp,
          correlationId: entry.correlationId,
          sessionId: entry.sessionId,
          error: "audit record not serialisable",
        }) + "\n"
      );
    }
  }
}

/** Discards everything. The default, so the CLI stays quiet. */
export class NullAuditSink implements AuditSink {
  record(): void {
    /* intentionally empty */
  }
}

/** Fans a record out to several sinks. */
export class MultiAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  record(entry: AuditRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.record(entry);
      } catch {
        // One broken sink must not stop the others.
      }
    }
  }
}

/** Collects records in memory. Useful in tests and for a debug endpoint. */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  constructor(private readonly limit = 1000) {}

  record(entry: AuditRecord): void {
    this.records.push(entry);
    if (this.records.length > this.limit) this.records.shift();
  }

  /** Just the turn summaries. */
  get turns(): AuditTurnRecord[] {
    return this.records.filter((r): r is AuditTurnRecord => r.type === "turn");
  }

  /** Just the per-call records. */
  get toolCalls(): AuditToolCallRecord[] {
    return this.records.filter((r): r is AuditToolCallRecord => r.type === "tool_call");
  }
}

/** Reduce a principal to the fields worth persisting in an audit trail. */
export function auditPrincipal(principal?: Principal): AuditActor | undefined {
  if (!principal) return undefined;
  return {
    subject: principal.subject,
    email: principal.email,
    clientId: principal.clientId,
    groups: principal.groups.length ? principal.groups : undefined,
  };
}

// ── Content capture ────────────────────────────────────────────────────────

/**
 * Applies the configured level, cap and redactor.
 *
 * Kept as its own object so the rules live in one place: `Session` decides
 * *when* to record, this decides *what a recorded value looks like*.
 */
export class AuditContentPolicy {
  readonly level: AuditLevel;
  readonly perToolCall: boolean;
  private readonly maxFieldChars: number;
  private readonly redactor?: AuditRedactor;

  constructor(options: AuditOptions = {}) {
    this.level = options.level ?? "metadata";
    this.perToolCall = options.perToolCall ?? true;
    this.maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
    this.redactor = options.redact;
  }

  /** Whether argument, result and prompt text is recorded at all. */
  get recordsContent(): boolean {
    return this.level !== "metadata";
  }

  /** Whether the full message history is recorded. */
  get recordsMessages(): boolean {
    return this.level === "full";
  }

  /** Redact, then truncate. In that order — a redactor must see the whole value. */
  text(value: string | undefined, ctx: AuditRedactionContext): string | undefined {
    if (value === undefined) return undefined;
    let out = value;
    if (this.redactor) {
      try {
        out = this.redactor(out, ctx);
      } catch {
        // A failing redactor must not leak the unredacted value, and must not
        // break the turn either.
        return "[redaction failed]";
      }
    }
    return truncate(out, this.maxFieldChars);
  }

  /** Redact every string nested in a tool call's arguments, preserving shape. */
  arguments(
    args: Record<string, unknown>,
    ctx: AuditRedactionContext
  ): Record<string, unknown> {
    const walked = this.redactor ? (walk(args, (s) => this.safeRedact(s, ctx)) as Record<string, unknown>) : args;
    return capObject(walked, this.maxFieldChars);
  }

  /** Describe a message for the record, keeping payloads out of it. */
  message(message: Message, ctx: Omit<AuditRedactionContext, "field">): AuditMessage {
    const parts = typeof message.content === "string" ? undefined : message.content;
    const out: AuditMessage = { role: message.role };

    const text =
      typeof message.content === "string"
        ? message.content
        : (parts ?? [])
            .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
            .map((p) => p.text)
            .join("");

    if (text) {
      out.content = this.text(text, { ...ctx, field: "message", role: message.role });
    }
    if (message.toolCallId) out.toolCallId = message.toolCallId;

    if (message.toolCalls?.length) {
      out.toolCalls = message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        ...(this.recordsContent
          ? {
              arguments: this.arguments(call.arguments, {
                ...ctx,
                field: "tool_arguments",
                toolName: call.name,
              }),
            }
          : {}),
      }));
    }

    const attachments = (parts ?? []).flatMap(describePart);
    if (attachments.length) out.attachments = attachments;

    return out;
  }

  private safeRedact(value: string, ctx: AuditRedactionContext): string {
    try {
      return this.redactor ? this.redactor(value, ctx) : value;
    } catch {
      return "[redaction failed]";
    }
  }
}

/**
 * Describe a non-text content part instead of recording it.
 *
 * An inline base64 image is typically hundreds of kilobytes and of no forensic
 * value as a blob; its media type and size are. Provider-native blocks —
 * thinking in particular — are opaque to core by contract and may be signed or
 * encrypted, so only their provider is noted.
 */
function describePart(part: ContentPart): string[] {
  switch (part.type) {
    case "text":
      return [];
    case "image_url": {
      const url = part.image_url.url;
      const dataUri = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (dataUri) {
        const bytes = Math.floor((dataUri[2].length * 3) / 4);
        return [`image ${dataUri[1]} (${formatBytes(bytes)})`];
      }
      return [`image ${url.slice(0, 200)}`];
    }
    case "provider_native":
      return [`provider_native:${part.provider}`];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Truncate with a marker, so a clipped value is never mistaken for a full one. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const dropped = value.length - max;
  return `${value.slice(0, max)}… [truncated ${dropped} chars]`;
}

/** Recursively map every string in a value. */
function walk(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, map));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = walk(entry, map);
    return out;
  }
  return value;
}

/** Cap every string inside an object, so one huge argument cannot dominate. */
function capObject(value: Record<string, unknown>, max: number): Record<string, unknown> {
  return walk(value, (s) => truncate(s, max)) as Record<string, unknown>;
}

/** Build the tool-call entry for a record at the configured level. */
export function auditToolCall(
  policy: AuditContentPolicy,
  call: ToolCall,
  outcome: {
    isError: boolean;
    denied?: boolean;
    denyReason?: string;
    result?: string;
    durationMs?: number;
    source?: string;
  },
  ctx: { sessionId: string; correlationId: string }
): AuditToolCall {
  const base: AuditToolCall = {
    id: call.id,
    name: call.name,
    isError: outcome.isError,
    ...(outcome.denied ? { denied: true } : {}),
    ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
    ...(outcome.source ? { source: outcome.source } : {}),
    durationMs: outcome.durationMs,
  };

  if (!policy.recordsContent) return base;

  return {
    ...base,
    arguments: policy.arguments(call.arguments, {
      ...ctx,
      field: "tool_arguments",
      toolName: call.name,
    }),
    result: policy.text(outcome.result, {
      ...ctx,
      field: "tool_result",
      toolName: call.name,
    }),
  };
}
