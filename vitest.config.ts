import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The flow tests drive a whole flow on the fake harness (git, clones, bundles): ~4s alone, past vitest's default
  // 5s once the machine is busy. A hang still fails, just later.
  test: { include: ['test/**/*.test.ts'], env: { AGENTIC_NO_FSYNC: '1' }, testTimeout: 30_000 },
});
