export interface HlcTimestamp { physical: number; logical: number; actor: string }
export class Hlc {
  #physical = 0;
  #logical = 0;
  readonly actor: string;
  constructor(actor: string) { this.actor = actor; }
  tick(now = Date.now()): HlcTimestamp {
    if (now > this.#physical) { this.#physical = now; this.#logical = 0; }
    else this.#logical += 1;
    return this.timestamp();
  }
  receive(message: HlcTimestamp, now = Date.now()): HlcTimestamp {
    const physical = Math.max(this.#physical, message.physical, now);
    this.#logical = physical === this.#physical && physical === message.physical
      ? Math.max(this.#logical, message.logical) + 1
      : physical === this.#physical ? this.#logical + 1
        : physical === message.physical ? message.logical + 1 : 0;
    this.#physical = physical;
    return this.timestamp();
  }
  timestamp(): HlcTimestamp { return { physical: this.#physical, logical: this.#logical, actor: this.actor }; }
}
function textOrder(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  return a.physical - b.physical || a.logical - b.logical || textOrder(a.actor, b.actor);
}
