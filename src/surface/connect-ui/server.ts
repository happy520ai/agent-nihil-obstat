import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveRoot } from '../../connect/paths.ts';
import { handle, type ConnectContext } from './http.ts';
import { CONNECT_UI_HOST, newToken, setSecurityHeaders } from './policy.ts';

export interface ConnectServerOptions {
  root: string;
  port?: number;
  host?: string;
}

export interface ConnectServerHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the one-key local Connect wizard.
 *
 * `root` is resolved and validated once, before listening; no `.ano` directory
 * is created by startup or by any GET. The root is never taken from the request.
 * The returned `url` already carries the per-process session credential, so the
 * CLI can print it directly and every native form/navigation keeps that path.
 */
export async function startConnectServer(options: ConnectServerOptions): Promise<ConnectServerHandle> {
  if (options.host !== undefined && options.host !== CONNECT_UI_HOST) {
    throw new Error(`Connect UI must bind ${CONNECT_UI_HOST}; refusing ${options.host}`);
  }
  // Validates the directory (and follows one symlink) without creating .ano.
  const root = resolveRoot(options.root);
  const ctx: ConnectContext = {
    root,
    port: 0,
    sessionToken: newToken(),
    csrf: newToken(),
    exportToken: newToken(),
  };
  const server = createServer((request, response) => {
    void handle(ctx, request, response).catch(() => {
      if (!response.headersSent) setSecurityHeaders(response);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal error\n');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const listeningAddress = server.address() as AddressInfo | null;
      if (listeningAddress) ctx.port = listeningAddress.port;
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 0, CONNECT_UI_HOST);
  });

  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('Connect UI server did not expose an address');
  ctx.port = address.port;

  return {
    server,
    port: ctx.port,
    url: `http://${CONNECT_UI_HOST}:${ctx.port}/session/${ctx.sessionToken}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
