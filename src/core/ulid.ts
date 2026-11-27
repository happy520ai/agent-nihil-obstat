import { randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('ULID timestamp must be a nonnegative safe integer');
  if (random.length !== 10) throw new Error('ULID requires 80 bits of randomness');
  let time = BigInt(now);
  let prefix = '';
  for (let index = 0; index < 10; index += 1) {
    prefix = alphabet[Number(time % 32n)] + prefix;
    time /= 32n;
  }
  let value = 0n;
  for (const byte of random) value = value * 256n + BigInt(byte);
  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix = alphabet[Number(value % 32n)] + suffix;
    value /= 32n;
  }
  return prefix + suffix;
}
