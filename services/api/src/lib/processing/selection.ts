export const MOCK_PROCESSOR = { id: 'mock-lidar', version: '1' } as const;
export const CPU_PROCESSOR = { id: 'lidar-cpu', version: '1-contract-v1' } as const;
// Separate from the worker module: API finalization only needs a pinned identity.
export function selectedProcessor(env: Record<string, string | undefined> = process.env) {
  const selection = env.CAPTURE_PROCESSOR ?? 'mock';
  if (selection === 'mock') return MOCK_PROCESSOR;
  if (selection === 'cpu') return CPU_PROCESSOR;
  throw new Error('CAPTURE_PROCESSOR must be mock or cpu');
}
export function processorTimeout(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.CAPTURE_PROCESSOR_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) throw new Error('Invalid CAPTURE_PROCESSOR_TIMEOUT_MS (1..3600000)');
  return value;
}
