import { TcpTransportError, type TcpReplicaKind } from './tcp-frame-codec.ts';

/**
 * T-147 / CV-05 extraction: client request-correlation state.
 *
 * Owns the pending-request table used by `TcpReplicaClient`: timeout timers,
 * AbortSignal cancellation listeners, settlement and fail-all cleanup. It is
 * free of sockets — callers write bytes and settle/reject promises — so the
 * correlation/cancellation rules can be reasoned about (and tested) in
 * isolation. The public transport surface is unchanged because
 * `tcp-transport.ts` consumes this module internally.
 */

/** One in-flight client request tracked for response correlation. */
export interface TcpClientPendingRequest {
  readonly kind: TcpReplicaKind;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: TcpTransportError) => void;
  readonly signal: AbortSignal | undefined;
  timer: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
}

/** Everything the table needs to register one pending request. */
export interface TcpClientPendingRegistration {
  readonly id: string;
  readonly kind: TcpReplicaKind;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: TcpTransportError) => void;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly timeoutError: TcpTransportError;
  /**
   * T-158: invoked when this request is abandoned locally (timeout or abort),
   * so the transport can tell the peer to stop the corresponding work.
   */
  readonly onCancel?: (id: string, kind: TcpReplicaKind) => void;
}

/**
 * Pending-request table. Registration order mirrors the pre-split
 * implementation exactly: timeout timer, cancellation listener, map insert;
 * settlement deletes the entry, clears the timer and releases the listener.
 */
export class TcpClientPendingTable {
  readonly #pending = new Map<string, TcpClientPendingRequest>();

  get size(): number {
    return this.#pending.size;
  }

  /** Number of live request timers (T-158/T-159 watermarks). */
  get timerCount(): number {
    let count = 0;
    for (const pending of this.#pending.values()) {
      if (pending.timer !== null) count += 1;
    }
    return count;
  }

  get(id: string): TcpClientPendingRequest | undefined {
    return this.#pending.get(id);
  }

  register(registration: TcpClientPendingRegistration): TcpClientPendingRequest {
    const pending: TcpClientPendingRequest = {
      kind: registration.kind,
      resolve: registration.resolve,
      reject: registration.reject,
      signal: registration.signal,
      timer: null,
      abortListener: null,
    };
    if (registration.timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        this.#pending.delete(registration.id);
        this.#removeAbortListener(pending);
        registration.onCancel?.(registration.id, registration.kind);
        registration.reject(registration.timeoutError);
      }, registration.timeoutMs);
      pending.timer.unref?.();
    }
    if (registration.signal !== undefined) {
      pending.abortListener = (): void => {
        this.#pending.delete(registration.id);
        if (pending.timer !== null) clearTimeout(pending.timer);
        registration.onCancel?.(registration.id, registration.kind);
        registration.reject(new TcpTransportError('TCP_REQUEST_CANCELLED', `${registration.kind} was cancelled`));
      };
      registration.signal.addEventListener('abort', pending.abortListener, { once: true });
    }
    this.#pending.set(registration.id, pending);
    return pending;
  }

  /** Settle one request: drop it, clear its timer and release its listener. */
  settle(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.#removeAbortListener(pending);
  }

  /** Reject every pending request with the same transport error. */
  failAll(error: TcpTransportError): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.#removeAbortListener(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #removeAbortListener(pending: TcpClientPendingRequest): void {
    if (pending.abortListener !== null && pending.signal !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
  }
}
