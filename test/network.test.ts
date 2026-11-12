import { describe, expect, it } from 'vitest';
import { probeNetwork } from '../src/orchestrator/network.js';

describe('probeNetwork', () => {
  it('a host nobody answers on is down', async () => {
    expect(await probeNetwork('https://127.0.0.1:1')).toBe('down');
  });
});
