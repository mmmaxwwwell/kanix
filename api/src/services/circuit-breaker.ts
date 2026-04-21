// ---------------------------------------------------------------------------
// Simple circuit breaker for external service adapters
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from open → half-open. Default: 30 000. */
  resetTimeoutMs?: number;
}

export interface CircuitBreaker {
  /** Current state of the circuit. */
  state(): CircuitState;
  /** Record a successful call — resets failure count, closes circuit. */
  recordSuccess(): void;
  /** Record a failed call — increments failures, may open circuit. */
  recordFailure(): void;
  /** Returns true if the circuit allows a request through. */
  allowRequest(): boolean;
  /** Reset the circuit breaker to closed state. */
  reset(): void;
  /** Number of consecutive failures recorded. */
  consecutiveFailures(): number;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = opts.failureThreshold ?? 5;
  const resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;

  let _state: CircuitState = "closed";
  let _failures = 0;
  let _lastFailureTime = 0;

  return {
    state() {
      if (_state === "open") {
        // Check if enough time has passed to move to half-open
        if (Date.now() - _lastFailureTime >= resetTimeoutMs) {
          _state = "half-open";
        }
      }
      return _state;
    },

    recordSuccess() {
      _failures = 0;
      _state = "closed";
    },

    recordFailure() {
      _failures++;
      _lastFailureTime = Date.now();
      if (_failures >= failureThreshold) {
        _state = "open";
      }
    },

    allowRequest() {
      const current = this.state(); // triggers open→half-open check
      if (current === "closed") return true;
      if (current === "half-open") return true; // allow one probe
      return false; // open
    },

    reset() {
      _state = "closed";
      _failures = 0;
      _lastFailureTime = 0;
    },

    consecutiveFailures() {
      return _failures;
    },
  };
}
