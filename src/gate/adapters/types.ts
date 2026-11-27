import type { EvidenceEnvironment } from '../types.ts';

/**
 * Evidence adapter contract (ADR-014 §4.1).
 *
 * An adapter owns one test runner family end to end: it proves the argv really
 * selects the declared test files (`detect`/`prepare`) and derives the evidence
 * counts from the captured run (`parse`). `verify.ts` selects the adapter from
 * argv; `evidence.ts` executes the returned argv without a shell. The Node
 * adapter is the pre-migration logic moved verbatim; pytest follows the same
 * contract without changing this file.
 */
export interface EvidenceRunTranscript {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly error?: string;
}

/** Input for validation/normalization, before anything is executed. */
export interface EvidencePrepareRequest {
  readonly root: string;
  readonly argv: readonly string[];
  readonly testFiles: readonly string[];
  /** Unique per run; adapters that need an owned result artifact derive its path from it. */
  readonly runId: string;
}

/** Exactly what will be executed, plus any adapter-owned artifact bookkeeping. */
export interface PreparedEvidenceCommand {
  readonly argv: string[];
  readonly testFiles: string[];
  /**
   * Argv as persisted for idempotency (params and digest). Adapters that append
   * ANO-owned artifacts (pytest `--junitxml=...`) return the normalized input
   * argv here so a retry with a different runId resolves to the same params.
   */
  readonly persistedArgv?: string[];
  /** Extra environment facts (for example an interpreter hash) the adapter proved. */
  readonly environment?: Readonly<Partial<EvidenceEnvironment>>;
  /** Environment overrides applied to the child process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Environment variables removed from the child process before spawning. */
  readonly envExclude?: readonly string[];
}

/** Captured run handed to the adapter; parsing must not spawn anything itself. */
export interface EvidenceParseContext extends EvidenceRunTranscript {
  readonly root: string;
  readonly runId: string;
}

/** Counts are the only source of truth for `ok`; failure text is advisory evidence. */
export interface EvidenceParseResult {
  readonly counts: Record<string, number>;
  readonly ok: boolean;
  /** Optional adapter-formatted excerpt; the gate redacts and truncates it. */
  readonly failureExcerpt?: string;
  /** Adapter-level reason (for example a missing result artifact); keeps `ok` false. */
  readonly error?: string;
  /** Facts discovered during the run (for example the result artifact digest). */
  readonly environment?: Readonly<Partial<EvidenceEnvironment>>;
}

export interface EvidenceAdapter {
  readonly id: string;
  /** True when this adapter owns argv's runner. Must not throw. */
  detect(argv: readonly string[]): boolean;
  /** Normalizes and validates argv, or throws the pre-migration refusal text. */
  prepare(request: EvidencePrepareRequest): PreparedEvidenceCommand;
  /** Derives counts/ok from the captured run. Never executes a new process. */
  parse(context: EvidenceParseContext): EvidenceParseResult | Promise<EvidenceParseResult>;
}
