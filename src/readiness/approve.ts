import { ReadinessError } from './errors.ts';
import { sha256Canonical } from './hash.ts';
import { assertInteractiveTty, type TtyStreams } from './tty.ts';
import {
  releaseApprovalSchema,
  type ReleaseApproval,
  type ReleaseApprovalCheck,
  type ReleaseVerdict,
} from './types.ts';

export interface ApproveReleaseOptions {
  verdict: ReleaseVerdict;
  approver: string;
  /**
   * Required. Pass the real process streams for a human CLI TTY. There is no
   * ambient fallback: a verdict can never be approved without streams being
   * supplied explicitly. Fake streams exist only through the explicit test-only
   * seam in `./test-seams.ts`, which is not exported from the module surface.
   */
  streams: TtyStreams;
  confirm: (prompt: string) => Promise<string>;
  now?: Date;
}

/**
 * Final release approval is a human-only, TTY-only operation. It is deliberately not
 * exported through the MCP surface or any of the seven agent tools.
 *
 * The approval record is a proof format, not cryptographic non-repudiation: it binds
 * the target, artifact hash and verdict hash, but its authenticity depends on the
 * human TTY ceremony and on the eventual ledger append.
 */
export async function approveRelease(options: ApproveReleaseOptions): Promise<ReleaseApproval> {
  assertInteractiveTty(options.streams);
  if (typeof options.confirm !== 'function') {
    throw new ReadinessError('CONFIRM_REQUIRED', 'Release approval requires an interactive confirmation callback.');
  }
  if (options.verdict.verdict !== 'ready') {
    throw new ReadinessError('RELEASE_NOT_READY', `Only a ready verdict can be approved; current verdict is ${options.verdict.verdict}.`);
  }
  const approver = options.approver.trim();
  if (approver.length < 2 || approver.length > 120 || /[\r\n]/.test(approver)) {
    throw new ReadinessError('APPROVER_INVALID', 'A named approver (2-120 characters, one line) is required.');
  }
  const expected = `APPROVE ${options.verdict.target}`;
  const answer = await options.confirm(`Type "${expected}" to approve: `);
  if (answer.trim() !== expected) {
    throw new ReadinessError('APPROVAL_NOT_CONFIRMED', 'Approval confirmation did not match.');
  }
  const approvedAt = (options.now ?? new Date()).toISOString();
  const body = {
    schema: 1 as const,
    target: options.verdict.target,
    artifactHash: options.verdict.artifactHash,
    verdictHash: options.verdict.verdictHash,
    approver,
    approvedAt,
  };
  const record: ReleaseApproval = { ...body, approvalRef: sha256Canonical(body) };
  const parsed = releaseApprovalSchema.safeParse(record);
  if (!parsed.success) throw new ReadinessError('APPROVAL_INVALID', 'Approval record did not validate.');
  return parsed.data;
}

export interface CurrentReleaseState {
  target: string;
  artifactHash: string;
  verdictHash: string;
  now?: Date;
}

/** An approval is void as soon as the artifact or the verdict it approved changes. */
export function checkApproval(approval: ReleaseApproval, current: CurrentReleaseState): ReleaseApprovalCheck {
  const reasons: string[] = [];
  const parsed = releaseApprovalSchema.safeParse(approval);
  if (!parsed.success) {
    return { valid: false, reasons: ['Approval record is malformed.'] };
  }
  if (approval.target !== current.target) reasons.push('Release target changed after approval.');
  if (approval.artifactHash !== current.artifactHash) reasons.push('Artifact hash changed after approval; the approval is void.');
  if (approval.verdictHash !== current.verdictHash) reasons.push('Release verdict changed after approval; re-verify before releasing.');
  const approvedAt = Date.parse(approval.approvedAt);
  const now = (current.now ?? new Date()).getTime();
  if (Number.isNaN(approvedAt)) reasons.push('Approval timestamp is invalid.');
  else if (approvedAt > now + 5 * 60 * 1000) reasons.push('Approval timestamp is in the future.');
  const body = {
    schema: approval.schema,
    target: approval.target,
    artifactHash: approval.artifactHash,
    verdictHash: approval.verdictHash,
    approver: approval.approver,
    approvedAt: approval.approvedAt,
  };
  if (approval.approvalRef !== sha256Canonical(body)) reasons.push('Approval record hash does not match its contents.');
  return { valid: reasons.length === 0, reasons };
}
