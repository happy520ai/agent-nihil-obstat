export class ConnectError extends Error {
  readonly code: string = 'CONNECT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectError';
  }
}

/** The configured source is missing, malformed, changing, or outside the authorized root. */
export class ConnectSourceError extends ConnectError {
  override readonly code = 'CONNECT_SOURCE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConnectSourceError';
  }
}

/** A size/count guard was exceeded. Never a silent truncation. */
export class ConnectLimitError extends ConnectError {
  override readonly code = 'CONNECT_LIMIT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConnectLimitError';
  }
}

/** The .ano/connect store is missing expected pieces or cannot be parsed. */
export class ConnectStoreError extends ConnectError {
  override readonly code: string = 'CONNECT_STORE';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectStoreError';
  }
}

/** Stored bytes do not match their recorded SHA-256. Fail closed. */
export class ConnectTamperError extends ConnectStoreError {
  override readonly code: string = 'CONNECT_TAMPER';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectTamperError';
  }
}
