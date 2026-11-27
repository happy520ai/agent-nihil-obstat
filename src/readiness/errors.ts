export class ReadinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReadinessError';
    this.code = code;
  }
}
