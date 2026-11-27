import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ReadinessError } from './errors.ts';
import { sha256Canonical } from './hash.ts';
import { parseToml, type TomlTable, type TomlValue } from './toml.ts';
import {
  ALL_SCOPES,
  EVIDENCE_KINDS,
  PROFILE_IDS,
  PROFILE_KINDS,
  PROFILE_STATUSES,
  REQUIREMENT_EVIDENCE,
  type EvidenceKind,
  type Profile,
  type ProfileId,
  type ProfileKind,
  type ProfileStatus,
  type Requirement,
  type RequirementEvidence,
  type RequirementScope,
  type ValidationRecord,
} from './types.ts';

const sha256Pattern = /^[a-f0-9]{64}$/;
const requirementIdPattern = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const checkIdPattern = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const validationDatePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;

const topLevelKeys = new Set(['schema', 'id', 'name', 'kind', 'status', 'schema_hash', 'notes', 'requirements', 'validation']);
const requirementKeys = new Set(['title', 'scope', 'evidence', 'freshness_days', 'check', 'kinds']);
const validationKeys = new Set(['project', 'validated_at', 'verdict_hash']);

const selfCertificationNames = new Set(['agent-nihil-obstat', 'agent nihil obstat', 'nihil obstat', 'ano']);

const maxValidationFileBytes = 64 * 1024;

/**
 * External validation record for a profile.
 *
 * It must be a file supplied from a directory that is independent of the profile
 * bundle (for example a record exported by the external project that ran the
 * flow). In-memory maps or caller-supplied claims are not accepted: they would
 * let the same caller both assert and consume "validated".
 */
const validationFileSchema = z.object({
  schema: z.literal(1),
  profile_id: z.enum(ALL_SCOPES),
  project: z.string().min(1).max(200),
  validated_at: z.string().min(1).max(64),
  verdict_hash: z.string().regex(sha256Pattern),
  profile_schema_hash: z.string().regex(sha256Pattern),
}).strict();
export type ValidationFileRecord = z.infer<typeof validationFileSchema>;

export interface LoadProfileOptions {
  /** Names that cannot be used as the validating project (self-certification guard). */
  selfProjectNames?: readonly string[];
}

export interface LoadProfilesOptions extends LoadProfileOptions {
  /**
   * Directory holding `<profile>.validation.json` records from a real external
   * project. Required for any profile that declares `status = "validated"`.
   * It must not be the profile bundle directory.
   */
  validationDirectory?: string;
}

function invalid(message: string): ReadinessError {
  return new ReadinessError('PROFILE_INVALID', message);
}

function isTable(value: TomlValue | TomlTable): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function table(value: TomlValue | TomlTable | undefined, label: string): TomlTable {
  if (value === undefined) throw invalid(`Missing ${label} table.`);
  if (!isTable(value)) throw invalid(`${label} must be a table.`);
  return value;
}

function string(value: TomlValue | TomlTable | undefined, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} must be a quoted string.`);
  if (value.length === 0) throw invalid(`${label} must not be empty.`);
  return value;
}

function optionalString(value: TomlValue | TomlTable | undefined, label: string): string | null {
  if (value === undefined) return null;
  return string(value, label);
}

function integer(value: TomlValue | TomlTable | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(`${label} must be an integer.`);
  return value;
}

function oneOf<T extends string>(value: TomlValue | TomlTable | undefined, allowed: readonly T[], label: string): T {
  const text = string(value, label);
  if (!(allowed as readonly string[]).includes(text)) throw invalid(`${label} must be one of ${allowed.join(', ')}.`);
  return text as T;
}

function assertKnownKeys(record: TomlTable, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`Unknown ${label} field ${JSON.stringify(key)}.`);
  }
}

function parseValidation(value: TomlValue | TomlTable | undefined): ValidationRecord | null {
  if (value === undefined) return null;
  const record = table(value, 'validation');
  assertKnownKeys(record, validationKeys, 'validation');
  const project = string(record.project, 'validation.project');
  const validatedAt = string(record.validated_at, 'validation.validated_at');
  if (!validationDatePattern.test(validatedAt)) throw invalid('validation.validated_at must be an ISO date or timestamp.');
  const verdictHash = string(record.verdict_hash, 'validation.verdict_hash');
  if (!sha256Pattern.test(verdictHash)) throw invalid('validation.verdict_hash must be a sha256 hex digest.');
  return { project, validatedAt, verdictHash };
}

function parseRequirement(id: string, raw: TomlValue | TomlTable, profileScope: RequirementScope): Requirement {
  if (!requirementIdPattern.test(id)) throw invalid(`Invalid requirement id ${JSON.stringify(id)}.`);
  const record = table(raw, `requirements.${id}`);
  assertKnownKeys(record, requirementKeys, `requirement ${id}`);
  const title = string(record.title, `${id}.title`);
  const scope = oneOf(record.scope, ALL_SCOPES, `${id}.scope`);
  if (scope !== profileScope) throw invalid(`Requirement ${id} scope ${scope} does not match profile ${profileScope}.`);
  const expectedPrefix = `${scope.toLowerCase()}.`;
  if (!id.startsWith(expectedPrefix)) throw invalid(`Requirement ${id} must start with ${expectedPrefix}.`);
  const evidence = oneOf(record.evidence, REQUIREMENT_EVIDENCE, `${id}.evidence`) as RequirementEvidence;
  const freshnessDays = integer(record.freshness_days, `${id}.freshness_days`);
  if (freshnessDays < 0 || freshnessDays > 3650) throw invalid(`${id}.freshness_days must be between 0 and 3650.`);
  // A rule without a freshness window is only meaningful for machine evidence,
  // where each record must declare its own positive freshness_days. Attestations
  // have no freshness field of their own, so their life must be bounded by the
  // requirement; otherwise a record could self-report an unlimited validity.
  if (freshnessDays === 0 && evidence !== 'machine') {
    throw invalid(`${id}.freshness_days must be at least 1 when evidence allows attestations.`);
  }
  const check = optionalString(record.check, `${id}.check`);
  if (check !== null && !checkIdPattern.test(check)) throw invalid(`${id}.check is not a valid check id.`);
  const kindsValue = record.kinds;
  let kinds: EvidenceKind[] = [];
  if (kindsValue !== undefined) {
    if (!Array.isArray(kindsValue)) throw invalid(`${id}.kinds must be an array of strings.`);
    for (const entry of kindsValue) {
      if (typeof entry !== 'string') throw invalid(`${id}.kinds must be an array of strings.`);
      if (!(EVIDENCE_KINDS as readonly string[]).includes(entry)) throw invalid(`${id}.kinds contains unknown kind ${entry}.`);
      kinds.push(entry as EvidenceKind);
    }
    kinds = [...new Set(kinds)].sort();
  }
  return { id, title, scope, evidence, freshnessDays, check, kinds };
}

export interface ParsedProfile {
  profile: Profile;
  declaredSchemaHash: string | null;
}

/** Parses and validates profile TOML without enforcing the schema hash (used to compute it). */
export function parseProfileToml(text: string): ParsedProfile {
  const raw = parseToml(text);
  assertKnownKeys(raw, topLevelKeys, 'profile');
  const schema = integer(raw.schema, 'schema');
  if (schema !== 1) throw invalid(`Unsupported profile schema ${schema}.`);
  const id = oneOf(raw.id, ALL_SCOPES, 'id');
  const name = string(raw.name, 'name');
  const kind = oneOf(raw.kind, PROFILE_KINDS, 'kind') as ProfileKind;
  const status = oneOf(raw.status, PROFILE_STATUSES, 'status') as ProfileStatus;
  const schemaHash = optionalString(raw.schema_hash, 'schema_hash');
  if (schemaHash !== null && !sha256Pattern.test(schemaHash)) throw invalid('schema_hash must be a sha256 hex digest.');
  const notes = optionalString(raw.notes, 'notes');
  const validation = parseValidation(raw.validation);
  if (status === 'validated' && validation === null) throw invalid('A validated profile must include a [validation] record.');
  if (status === 'defined' && validation !== null) throw invalid('A [validation] record requires status = "validated".');
  if (id === 'common' && kind !== 'common') throw invalid('The common profile must use kind = "common".');
  if (id !== 'common' && kind === 'common') throw invalid('Only the common profile may use kind = "common".');
  const requirementsTable = table(raw.requirements, 'requirements');
  const ids = Object.keys(requirementsTable);
  if (ids.length === 0) throw invalid('A profile must declare at least one requirement.');
  const requirements = ids.map((requirementId) => parseRequirement(requirementId, requirementsTable[requirementId]!, id));
  requirements.sort((a, b) => a.id.localeCompare(b.id));
  return {
    profile: {
      schema,
      id,
      name,
      kind,
      status,
      schemaHash: schemaHash ?? '',
      requirements,
      notes,
      validation,
    },
    declaredSchemaHash: schemaHash,
  };
}

/** Hash of the requirement schema only: status, notes and validation records do not change it. */
export function computeProfileHash(profile: Pick<Profile, 'schema' | 'id' | 'name' | 'kind' | 'requirements'>): string {
  return sha256Canonical({
    schema: profile.schema,
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    requirements: [...profile.requirements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        scope: requirement.scope,
        evidence: requirement.evidence,
        freshness_days: requirement.freshnessDays,
        check: requirement.check,
        kinds: [...requirement.kinds].sort(),
      })),
  });
}

function assertValidatedClaim(profile: Profile, record: ValidationFileRecord | null, options: LoadProfileOptions): void {
  if (profile.status !== 'validated') return;
  if (record === null) {
    throw new ReadinessError(
      'PROFILE_SELF_CERTIFICATION',
      `Profile ${profile.id} declares status validated without an external validation file. In-memory validation claims are not accepted.`,
    );
  }
  if (record.profile_id !== profile.id) {
    throw new ReadinessError('PROFILE_VALIDATION_MISMATCH', `Validation record is for profile ${record.profile_id}, not ${profile.id}.`);
  }
  const expectedHash = computeProfileHash(profile);
  if (record.profile_schema_hash !== expectedHash) {
    throw new ReadinessError('PROFILE_VALIDATION_MISMATCH', `Validation record for profile ${profile.id} pins a different schema hash.`);
  }
  const project = record.project.trim().toLowerCase();
  if (project.length === 0) throw new ReadinessError('PROFILE_SELF_CERTIFICATION', 'Validation record has no project name.');
  const forbidden = new Set([...selfCertificationNames, ...(options.selfProjectNames ?? []).map((name) => name.toLowerCase())]);
  if (project.includes('nihil obstat') || project.includes('agent-nihil-obstat') || forbidden.has(project)) {
    throw new ReadinessError('PROFILE_SELF_CERTIFICATION', 'A project cannot validate its own readiness profile.');
  }
  if (profile.validation === null) {
    throw new ReadinessError('PROFILE_INVALID', `Profile ${profile.id} has no [validation] section to match the external record.`);
  }
  if (record.validated_at !== profile.validation.validatedAt) {
    throw new ReadinessError('PROFILE_VALIDATION_MISMATCH', `Validation record date for profile ${profile.id} does not match the profile.`);
  }
}

/** Parses a profile and verifies its pinned schema hash. Validation claims are checked separately. */
function parseAndHashProfile(text: string): Profile {
  const { profile, declaredSchemaHash } = parseProfileToml(text);
  const computed = computeProfileHash(profile);
  if (declaredSchemaHash === null) {
    throw new ReadinessError('PROFILE_HASH_MISSING', `Profile ${profile.id} does not pin schema_hash.`);
  }
  if (declaredSchemaHash !== computed) {
    throw new ReadinessError(
      'PROFILE_HASH_MISMATCH',
      `Profile ${profile.id} schema_hash does not match its contents (expected ${computed}).`,
    );
  }
  return { ...profile, schemaHash: computed };
}

function loadProfile(text: string, record: ValidationFileRecord | null, options: LoadProfileOptions): Profile {
  const loaded = parseAndHashProfile(text);
  assertValidatedClaim(loaded, record, options);
  return loaded;
}

/** Loads profile text without external validation. A `validated` claim is always rejected. */
export function loadProfileText(text: string, options: LoadProfileOptions = {}): Profile {
  return loadProfile(text, null, options);
}

export interface ReadinessProfiles {
  common: Profile;
  profiles: Profile[];
}

/**
 * Profiles ship next to the compiled module: `src/readiness/profiles` in a source
 * checkout and `dist/readiness/profiles` in a package (the build must copy the
 * TOML assets there). We deliberately do not probe the process CWD or `../../src`,
 * so an installed tool can never read the host project's sources or an arbitrary
 * profile directory. Callers that need another location pass it explicitly.
 */
export function defaultProfilesDirectory(): string {
  return fileURLToPath(new URL('./profiles/', import.meta.url));
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function readValidationRecord(directory: string, profileId: RequirementScope): Promise<ValidationFileRecord | null> {
  const absolute = join(directory, `${profileId}.validation.json`);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ReadinessError('PROFILE_VALIDATION_INVALID', `Validation record must be a regular file: ${absolute}`);
  }
  if (info.size > maxValidationFileBytes) {
    throw new ReadinessError('PROFILE_VALIDATION_INVALID', `Validation record is too large (${info.size} bytes): ${absolute}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
  } catch (error) {
    throw new ReadinessError('PROFILE_VALIDATION_INVALID', `Validation record is not valid JSON: ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = validationFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '<record>'}: ${issue.message}`).join('; ');
    throw new ReadinessError('PROFILE_VALIDATION_INVALID', `Validation record is malformed: ${absolute}: ${detail}`);
  }
  if (result.data.profile_id !== profileId) {
    throw new ReadinessError('PROFILE_VALIDATION_MISMATCH', `Validation record ${absolute} is for profile ${result.data.profile_id}, not ${profileId}.`);
  }
  return result.data;
}

export async function loadReadinessProfiles(
  directory: string = defaultProfilesDirectory(),
  options: LoadProfilesOptions = {},
): Promise<ReadinessProfiles> {
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new ReadinessError(
        'PROFILE_DIR_MISSING',
        `Readiness profile assets are missing at ${directory}. The build must copy src/readiness/profiles/*.toml next to the compiled module.`,
      );
    }
    throw error;
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new ReadinessError('PROFILE_DIR_MISSING', `Readiness profile assets are not a plain directory: ${directory}`);
  }
  if (options.validationDirectory !== undefined) {
    const profilesPath = resolve(directory);
    const validationPath = resolve(options.validationDirectory);
    if (validationPath === profilesPath || isInsidePath(profilesPath, validationPath)) {
      throw new ReadinessError(
        'PROFILE_SELF_CERTIFICATION',
        'Validation records must come from a directory independent of the profile bundle.',
      );
    }
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.toml')).map((entry) => entry.name).sort();
  if (files.some((file) => !entryIsKnown(file))) {
    const unknown = files.filter((file) => !entryIsKnown(file));
    throw new ReadinessError('PROFILE_UNKNOWN_FILE', `Unknown profile files: ${unknown.join(', ')}.`);
  }
  const expected = ['common.toml', ...PROFILE_IDS.map((id) => `${id}.toml`)];
  for (const file of expected) {
    if (!files.includes(file)) throw new ReadinessError('PROFILE_MISSING', `Missing profile file ${file}.`);
  }
  const loaded = new Map<RequirementScope, Profile>();
  for (const file of expected) {
    const expectedId: RequirementScope = file === 'common.toml' ? 'common' : (file.slice(0, 1) as RequirementScope);
    const record = options.validationDirectory === undefined
      ? null
      : await readValidationRecord(options.validationDirectory, expectedId);
    const profile = loadProfile(await readFile(join(directory, file), 'utf8'), record, options);
    if (profile.id !== expectedId) {
      throw new ReadinessError('PROFILE_INVALID', `Profile ${file} declares id ${profile.id}.`);
    }
    if (loaded.has(profile.id)) throw new ReadinessError('PROFILE_DUPLICATE', `Duplicate profile id ${profile.id}.`);
    loaded.set(profile.id, profile);
  }
  const common = loaded.get('common');
  if (common === undefined) throw new ReadinessError('PROFILE_MISSING', 'Missing common profile.');
  if (common.requirements.some((requirement) => requirement.scope !== 'common')) {
    throw new ReadinessError('PROFILE_INVALID', 'Common profile requirements must all use scope = "common".');
  }
  const profiles: Profile[] = [];
  for (const id of PROFILE_IDS) {
    const profile = loaded.get(id);
    if (profile === undefined) throw new ReadinessError('PROFILE_MISSING', `Missing profile ${id}.`);
    if (profile.requirements.some((requirement) => requirement.scope !== id)) {
      throw new ReadinessError('PROFILE_INVALID', `Profile ${id} contains a requirement for another scope.`);
    }
    profiles.push(profile);
  }
  return { common, profiles };
}

function entryIsKnown(file: string): boolean {
  return file === 'common.toml' || PROFILE_IDS.some((id) => file === `${id}.toml`);
}

/** Only profiles validated against a real external project may be advertised as supported. */
export function validatedProfiles(profiles: readonly Profile[]): ProfileId[] {
  return profiles.filter((profile): profile is Profile & { id: ProfileId } => profile.id !== 'common' && profile.status === 'validated').map((profile) => profile.id);
}

export function definedProfiles(profiles: readonly Profile[]): Profile[] {
  return profiles.filter((profile) => profile.status === 'defined');
}
