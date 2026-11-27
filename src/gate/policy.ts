import { z } from 'zod';
import type { CoveragePolicy } from './blast.ts';

export const policySchema = z.object({
  minimum: z.enum(['T0', 'T1']),
  unknown: z.enum(['strict', 'advisory']),
}).strict();
export const defaultPolicy: CoveragePolicy = { minimum: 'T1', unknown: 'strict' };
