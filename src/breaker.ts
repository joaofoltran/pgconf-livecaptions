export type Route = "preferred" | "probe" | "fallback";

// Opens after `threshold` failures within `windowMs` and routes everything to
// the fallback for `openMs`. Then it is half-open: one probe goes to the
// preferred provider while the rest stay on the fallback until the probe
// succeeds (close) or fails (reopen).
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly threshold = 2,
    private readonly windowMs = 15_000,
    private readonly openMs = 45_000
  ) {}

  route(now = Date.now()): Route {
    if (!this.openUntil) return "preferred";
    if (now < this.openUntil || this.probing) return "fallback";
    this.probing = true;
    return "probe";
  }

  // Returns true when this failure opens the breaker.
  fail(now = Date.now()): boolean {
    if (this.openUntil) {
      if (now < this.openUntil) return false;
      this.open(now);
      return true;
    }
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length < this.threshold) return false;
    this.open(now);
    return true;
  }

  succeed(now = Date.now()): void {
    if (!this.openUntil || now < this.openUntil) return;
    this.openUntil = 0;
    this.probing = false;
    this.failures = [];
  }

  // The probe ended without a verdict, for example because its caller aborted it.
  release(): void {
    this.probing = false;
  }

  private open(now: number): void {
    this.openUntil = now + this.openMs;
    this.failures = [];
    this.probing = false;
  }
}
