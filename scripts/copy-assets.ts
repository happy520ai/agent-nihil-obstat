import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'readiness', 'profiles');
const destination = join(root, 'dist', 'readiness', 'profiles');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`Copied readiness profiles to ${destination}`);
