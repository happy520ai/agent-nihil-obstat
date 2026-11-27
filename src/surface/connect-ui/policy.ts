import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * Shared security policy and response primitives for the Connect wizard.
 *
 * The wizard is loopback-only and scriptless: every response carries the fixed
 * CSP below, and the server binds exactly `CONNECT_UI_HOST`.
 */
export const CONNECT_UI_HOST = '127.0.0.1';

export const CONNECT_UI_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const MAX_URL_LENGTH = 2048;
export const MAX_BODY_BYTES = 8192;
export const MAX_TASK_ROWS = 50;

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Host must be exactly the bound loopback address and the actual bound port.
 * This refuses DNS-rebinding names (`localhost`, decimal/IPv6 aliases) and
 * requests whose Host points at another local port.
 */
export function isConnectHostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(host);
  if (!match) return false;
  const portText = match[1];
  if (portText === undefined) return false;
  const candidate = Number(portText);
  return Number.isInteger(candidate) && candidate === port;
}

/** Constant-time token comparison: normalize lengths with SHA-256 first. */
export function connectTokenEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CONNECT_UI_CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

export function respondText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function respondHtml(response: ServerResponse, status: number, body: string): void {
  const buffer = Buffer.from(body);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buffer.length,
  });
  response.end(buffer);
}

export function respondJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
