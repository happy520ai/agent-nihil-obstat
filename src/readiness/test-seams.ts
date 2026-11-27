import type { TtyStreams } from './tty.ts';

/**
 * TEST-ONLY seam.
 *
 * Fake interactive streams are only ever produced here. This module is
 * deliberately NOT exported from `./index.ts`, so the production surface (CLI,
 * MCP, agent tools) cannot reach it through the module's public API. Production
 * approval code must pass the real process streams (`process.stdin`/`stdout`)
 * and a real TTY.
 *
 * The readiness approval format is a proof format, not cryptographic
 * non-repudiation: a caller with code execution can always fabricate objects.
 * The guarantee is that no product code path hands out such a seam, and an
 * approval can never be produced without streams being supplied explicitly.
 */
export function testOnlyInteractiveStreams(): TtyStreams {
  return {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
  };
}
