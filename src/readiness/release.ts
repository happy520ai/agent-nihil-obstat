import { ReadinessError } from './errors.ts';
import { sha256Canonical } from './hash.ts';
import {
  collectFileAttestations,
  type AttestationProvenanceSource,
  type CollectAttestationOptions,
  type CollectAttestationResult,
} from './attestation.ts';
import { collectFileEvidence, type CollectEvidenceOptions, type CollectEvidenceResult } from './evidence.ts';
import {
  type GapKind,
  type Profile,
  type ProfileVerdict,
  type ReleaseItem,
  type ReleaseStatus,
  type ReleaseVerdict,
  type Requirement,
  type RequirementScope,
  type RejectedAttestation,
  type RejectedEvidence,
  type ValidatedAttestation,
  type ValidatedEvidence,
} from './types.ts';

export interface BuildReleaseVerdictOptions {
  target: string;
  artifactHash: string;
  sourceFingerprint?: string | null;
  common: Profile;
  profiles: Profile[];
  evidence: ValidatedEvidence[];
  rejectedEvidence?: RejectedEvidence[];
  attestations: ValidatedAttestation[];
  rejectedAttestations?: RejectedAttestation[];
  now?: Date;
}

function requirementMap(common: Profile, profiles: Profile[]): Map<string, Requirement> {
  if (common.id !== 'common') throw new ReadinessError('RELEASE_PROFILE', 'The common profile is required.');
  if (profiles.length === 0) throw new ReadinessError('RELEASE_PROFILE', 'At least one non-common profile is required.');
  const seenProfiles = new Set<string>();
  const plan = [common, ...profiles];
  const requirements = new Map<string, Requirement>();
  for (const profile of plan) {
    if (profile.id !== common.id && seenProfiles.has(profile.id)) {
      throw new ReadinessError('RELEASE_PROFILE', `Profile ${profile.id} is selected more than once.`);
    }
    if (profile.id === common.id && profile !== common) {
      throw new ReadinessError('RELEASE_PROFILE', 'The common profile must be passed separately, not in profiles.');
    }
    seenProfiles.add(profile.id);
    for (const requirement of profile.requirements) {
      const existing = requirements.get(requirement.id);
      if (existing !== undefined) {
        throw new ReadinessError('RELEASE_PROFILE', `Requirement ${requirement.id} is declared more than once.`);
      }
      requirements.set(requirement.id, requirement);
    }
  }
  return requirements;
}

interface ItemDecision {
  status: ReleaseItem['status'];
  gap: GapKind;
  reason: string;
  evidenceRef: string | null;
  expiresAt: string | null;
}

function newestEvidence(evidence: ValidatedEvidence[]): ValidatedEvidence {
  return [...evidence].sort((a, b) => (a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : b.timestamp.localeCompare(a.timestamp)))[0]!;
}

function newestAttestation(attestations: ValidatedAttestation[]): ValidatedAttestation {
  return [...attestations].sort((a, b) => (a.signedAt === b.signedAt ? a.id.localeCompare(b.id) : b.signedAt.localeCompare(a.signedAt)))[0]!;
}

function rejectedDetail<T extends { reason: string; detail: string }>(items: T[]): string {
  return [...new Set(items.map((item) => `${item.reason}: ${item.detail}`))].join(' | ');
}

function decideItem(
  requirement: Requirement,
  evidence: ValidatedEvidence[],
  attestations: ValidatedAttestation[],
  rejectedMachine: RejectedEvidence[],
  rejectedAttested: RejectedAttestation[],
): ItemDecision {
  const allowsMachine = requirement.evidence !== 'attested';
  const allowsAttested = requirement.evidence !== 'machine';
  // Local check output is a declaration about files in the project. It is never
  // machine evidence and can never make a verdict stricter or looser than the
  // absence of evidence would: the requirement stays missing.
  const machine = evidence.filter((item) => item.classification === 'machine');
  const declarations = evidence.filter((item) => item.classification === 'declaration');

  if (!allowsMachine && (machine.length > 0 || rejectedMachine.length > 0)) {
    return {
      status: 'missing',
      gap: 'machine_invalid',
      reason: 'This requirement needs a named human attestation; machine evidence cannot replace it.',
      evidenceRef: null,
      expiresAt: null,
    };
  }
  if (allowsMachine && machine.length > 0) {
    const best = newestEvidence(machine);
    return {
      status: 'machine',
      gap: 'none',
      reason: `Machine evidence ${best.evidenceRef} is bound to the current artifact.`,
      evidenceRef: best.evidenceRef,
      expiresAt: best.expiresAt,
    };
  }
  if (allowsMachine && rejectedMachine.length > 0) {
    return {
      status: 'missing',
      gap: 'machine_invalid',
      reason: `Machine evidence exists but cannot be used: ${rejectedDetail(rejectedMachine)}`,
      evidenceRef: null,
      expiresAt: null,
    };
  }
  if (allowsAttested && attestations.length > 0) {
    const best = newestAttestation(attestations);
    return {
      status: 'attested',
      gap: 'none',
      reason: `Attestation by ${best.signer.name} (${best.signer.role}) is valid until ${best.expiresAt}.`,
      evidenceRef: best.attestationRef,
      expiresAt: best.expiresAt,
    };
  }
  if (!allowsAttested && (attestations.length > 0 || rejectedAttested.length > 0)) {
    return {
      status: 'missing',
      gap: 'attestation_invalid',
      reason: 'This is a machine-only requirement; a human attestation cannot substitute for machine evidence.',
      evidenceRef: null,
      expiresAt: null,
    };
  }
  if (allowsAttested && rejectedAttested.length > 0) {
    const allExpired = rejectedAttested.every((item) => item.reason === 'expired');
    if (allExpired) {
      return {
        status: 'missing',
        gap: 'attested_expired',
        reason: `Attestation expired and must be renewed: ${rejectedDetail(rejectedAttested)}`,
        evidenceRef: null,
        expiresAt: null,
      };
    }
    return {
      status: 'missing',
      gap: 'attestation_invalid',
      reason: `Attestation exists but is invalid: ${rejectedDetail(rejectedAttested)}`,
      evidenceRef: null,
      expiresAt: null,
    };
  }
  if (declarations.length > 0) {
    const best = newestEvidence(declarations);
    return {
      status: 'declaration',
      gap: requirement.evidence === 'machine' ? 'machine_missing' : 'attested_missing',
      reason: `Only a local declaration (${best.sourceId}) is present; local checks and static project files cannot satisfy this requirement.`,
      evidenceRef: best.evidenceRef,
      expiresAt: best.expiresAt,
    };
  }
  if (requirement.evidence === 'machine') {
    return {
      status: 'missing',
      gap: 'machine_missing',
      reason: 'No machine evidence was supplied for this requirement.',
      evidenceRef: null,
      expiresAt: null,
    };
  }
  return {
    status: 'missing',
    gap: 'attested_missing',
    reason: 'No attestation was supplied for this requirement.',
    evidenceRef: null,
    expiresAt: null,
  };
}

function profileStatus(items: ReleaseItem[]): ReleaseStatus {
  if (items.some((item) => item.gap === 'machine_missing' || item.gap === 'machine_invalid' || item.gap === 'attestation_invalid')) return 'blocked';
  if (items.some((item) => item.gap === 'attested_missing' || item.gap === 'attested_expired')) return 'conditional';
  return 'ready';
}

function counts(items: ReleaseItem[]): { machine: number; attested: number; declaration: number; missing: number } {
  return {
    machine: items.filter((item) => item.status === 'machine').length,
    attested: items.filter((item) => item.status === 'attested').length,
    declaration: items.filter((item) => item.status === 'declaration').length,
    missing: items.filter((item) => item.status === 'missing').length,
  };
}

export function buildReleaseVerdict(options: BuildReleaseVerdictOptions): ReleaseVerdict {
  const requirements = requirementMap(options.common, options.profiles);
  const now = (options.now ?? new Date()).getTime();
  const rejectedEvidence = [...(options.rejectedEvidence ?? [])];
  const rejectedAttestations = [...(options.rejectedAttestations ?? [])];
  const acceptedEvidence: ValidatedEvidence[] = [];
  for (const evidence of options.evidence) {
    if (Date.parse(evidence.expiresAt) <= now) {
      rejectedEvidence.push({
        file: '<collected>',
        id: evidence.id,
        requirementId: evidence.requirementId,
        reason: 'expired',
        detail: `Evidence expired at ${evidence.expiresAt}.`,
      });
      continue;
    }
    acceptedEvidence.push(evidence);
  }
  const acceptedAttestations: ValidatedAttestation[] = [];
  for (const attestation of options.attestations) {
    if (Date.parse(attestation.expiresAt) <= now) {
      rejectedAttestations.push({
        file: '<collected>',
        id: attestation.id,
        requirementId: attestation.requirementId,
        reason: 'expired',
        detail: `Attestation expired at ${attestation.expiresAt}.`,
      });
      continue;
    }
    acceptedAttestations.push(attestation);
  }
  const items: ReleaseItem[] = [];
  for (const requirement of [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const decision = decideItem(
      requirement,
      acceptedEvidence.filter((evidence) => evidence.requirementId === requirement.id),
      acceptedAttestations.filter((attestation) => attestation.requirementId === requirement.id),
      rejectedEvidence.filter((evidence) => evidence.requirementId === requirement.id),
      rejectedAttestations.filter((attestation) => attestation.requirementId === requirement.id),
    );
    items.push({
      id: requirement.id,
      requirement: requirement.title,
      scope: requirement.scope,
      status: decision.status,
      evidenceRef: decision.evidenceRef,
      expiresAt: decision.expiresAt,
      gap: decision.gap,
      reason: decision.reason,
    });
  }

  const blocked = items.some((item) => item.gap === 'machine_missing' || item.gap === 'machine_invalid' || item.gap === 'attestation_invalid');
  const conditional = !blocked && items.some((item) => item.gap === 'attested_missing' || item.gap === 'attested_expired');
  const verdict: ReleaseStatus = blocked ? 'blocked' : conditional ? 'conditional' : 'ready';

  const perProfile: ProfileVerdict[] = [options.common, ...options.profiles].map((profile) => {
    const scoped = items.filter((item) => item.scope === profile.id);
    return {
      profileId: profile.id as RequirementScope,
      name: profile.name,
      status: profileStatus(scoped),
      summary: counts(scoped),
      itemIds: scoped.map((item) => item.id),
    };
  });

  const summary = counts(items);
  const caveats: string[] = [
    'A ready verdict means no objection to the declared release conditions; it does not assert product correctness or operational safety.',
    'Machine evidence is file-backed: this tool validates records and hashes but does not contact external systems.',
    'Local checks and static project files (for example deploy/service.json or api/current.json) are declarations, never machine evidence.',
    'Attestations are accepted only when an injected ledger source confirms a readiness.attestation event binding the exact record; that is a proof format, not cryptographic non-repudiation.',
  ];
  for (const profile of [options.common, ...options.profiles]) {
    if (profile.status !== 'validated') {
      caveats.push(`Profile ${profile.id} (${profile.name}) is defined, not validated against a real project.`);
    }
  }
  if (rejectedEvidence.length > 0) caveats.push(`${rejectedEvidence.length} evidence file(s) were rejected; see item reasons.`);
  if (rejectedAttestations.length > 0) caveats.push(`${rejectedAttestations.length} attestation record(s) were rejected; see item reasons.`);

  const body = {
    schema: 1 as const,
    target: options.target,
    artifactHash: options.artifactHash,
    sourceFingerprint: options.sourceFingerprint ?? null,
    verdict,
    perProfile,
    items,
    summary,
    caveats,
  };
  return { ...body, verdictHash: sha256Canonical(body) };
}

export interface VerifyReleaseOptions {
  target: string;
  artifactHash: string;
  sourceFingerprint?: string;
  common: Profile;
  profiles: Profile[];
  evidenceDirectory: string;
  attestationDirectory: string;
  /**
   * Ledger-backed provenance for attestations. Omitting it is a deny-by-default
   * configuration: every attestation is rejected as unproven.
   */
  attestationProvenance?: AttestationProvenanceSource;
  now?: Date;
  maxRawBytes?: number;
}

export interface VerifyReleaseResult {
  verdict: ReleaseVerdict;
  evidence: CollectEvidenceResult;
  attestations: CollectAttestationResult;
}

/** Convenience orchestration: read both file directories, validate, then compute the verdict. */
export async function verifyRelease(options: VerifyReleaseOptions): Promise<VerifyReleaseResult> {
  const requirements = requirementMap(options.common, options.profiles);
  const evidenceOptions: CollectEvidenceOptions = {
    directory: options.evidenceDirectory,
    requirements,
    currentArtifactHash: options.artifactHash,
    ...(options.sourceFingerprint === undefined ? {} : { currentSourceFingerprint: options.sourceFingerprint }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxRawBytes === undefined ? {} : { maxRawBytes: options.maxRawBytes }),
  };
  const attestationOptions: CollectAttestationOptions = {
    directory: options.attestationDirectory,
    requirements,
    currentArtifactHash: options.artifactHash,
    releaseTarget: options.target,
    ...(options.attestationProvenance === undefined ? {} : { provenance: options.attestationProvenance }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const [evidence, attestations] = await Promise.all([
    collectFileEvidence(evidenceOptions),
    collectFileAttestations(attestationOptions),
  ]);
  const verdict = buildReleaseVerdict({
    target: options.target,
    artifactHash: options.artifactHash,
    sourceFingerprint: options.sourceFingerprint ?? null,
    common: options.common,
    profiles: options.profiles,
    evidence: evidence.accepted,
    rejectedEvidence: evidence.rejected,
    attestations: attestations.accepted,
    rejectedAttestations: attestations.rejected,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { verdict, evidence, attestations };
}
