/**
 * Map over items with bounded concurrency, preserving input order.
 * Each item is processed by `fn`; if `fn` returns null, that slot stays null.
 * Workers pull from a shared index counter so at most `concurrency` items
 * are in-flight simultaneously.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R | null>,
  concurrency: number,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        // results[i] stays null (callers should catch internally, but guard here to avoid abandoning remaining items)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
