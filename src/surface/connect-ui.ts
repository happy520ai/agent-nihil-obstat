/**
 * Loopback-only, no-script Connect wizard.
 *
 * Independent from the legacy read-only `surface/ui.ts`: it never imports it and
 * keeps its own CSP (forms need `form-action 'self'`). The server root is fixed
 * at construction time and can never be overridden by query, path or body.
 *
 * Every route lives under a per-process random session path
 * (`/session/<token>/...`). The bare root only returns a static 401 page, so an
 * unauthorized request never sees the root, project, tokens or source data.
 *
 * Implementation is split across `connect-ui/`:
 * - `policy.ts`: host/CSP constants, escaping, token comparison, responders
 * - `render.ts`: shell/page HTML rendering
 * - `http.ts`: request authorization, body reading and route dispatch
 * - `server.ts`: listener lifecycle and public `startConnectServer`
 */

export { CONNECT_UI_HOST, CONNECT_UI_CSP, connectTokenEquals, escapeHtml, isConnectHostAllowed } from './connect-ui/policy.ts';
export { renderConnectPage, renderConnectResultPage } from './connect-ui/render.ts';
export type { ConnectPageData, ConnectResultPageData, ConnectShellMeta } from './connect-ui/render.ts';
export { startConnectServer } from './connect-ui/server.ts';
export type { ConnectServerHandle, ConnectServerOptions } from './connect-ui/server.ts';
