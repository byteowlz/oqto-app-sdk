/**
 * Let queued MessagePort traffic drain.
 *
 * The bridge is a real MessageChannel even in tests, so events and suspension
 * notices arrive as macrotasks. Awaiting a microtask is not enough.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
