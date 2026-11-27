import { ReadinessError } from './errors.ts';

export interface TtyStreams {
  stdin: { isTTY?: boolean | undefined };
  stdout: { isTTY?: boolean | undefined };
}

/**
 * Human-only operations must come from an interactive terminal, never from an
 * agent transport.
 *
 * There is no ambient fallback to `process`. Callers must pass streams
 * explicitly, so omitting them always fails closed even when the surrounding
 * process happens to own a terminal. Production callers pass the real process
 * streams; tests use the explicit seam in `./test-seams.ts`.
 */
export function assertInteractiveTty(streams: TtyStreams | undefined): asserts streams is TtyStreams {
  if (streams === undefined || streams === null || typeof streams !== 'object') {
    throw new ReadinessError('TTY_REQUIRED', 'This action requires explicitly supplied interactive TTY streams; no ambient terminal is used.');
  }
  if (streams.stdin?.isTTY !== true || streams.stdout?.isTTY !== true) {
    throw new ReadinessError('TTY_REQUIRED', 'This action requires an interactive TTY on stdin and stdout.');
  }
}
