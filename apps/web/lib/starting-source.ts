/**
 * Where a conversation starts (there's no source picker: the agent reads every source the person can):
 * the source the page or conversation names, when the person can ask it; else their own data before the sample; else
 * the sample. The analyst reads the others when a question needs them, and each step says which it read.
 */
export function startingSource<S extends { id: string; sample?: boolean }>(
  sources: S[],
  preferred?: string | null,
): string | null {
  if (preferred && sources.some((s) => s.id === preferred)) return preferred;
  return (sources.find((s) => !s.sample) ?? sources[0])?.id ?? null;
}
