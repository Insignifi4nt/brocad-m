import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { WeightedShardSequencer } from './scripts/unit-test-shards.ts';

// Pure geometry/planning suites need no DOM or browser-storage coordination shim.
const pureDomainTests = [
  'src/domain/{compensation,execution-plan,path-editor,path-intel,simulation}/**/*.{test,spec}.{ts,tsx}',
  // CAD geometry, expression and schema suites have no DOM dependencies.
  // CAD storage suites live outside this directory and keep the browser adapter.
  'src/domain/cad/__tests__/**/*.{test,spec}.{ts,tsx}',
  // The precision policy and its ordering are plain numbers.
  'src/domain/precision/**/*.{test,spec}.{ts,tsx}'
];

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    globals: true,
    // Many-core hosts otherwise run dozens of jsdom/native-kernel workers at
    // once and starve real serialization/cancellation checks of their time budget.
    maxWorkers: Math.min(4, availableParallelism()),
    // --shard splits by measured file time (scripts/unit-test-shard-weights.json), not by path hash.
    sequence: { sequencer: WeightedShardSequencer },
    projects: [
      {
        extends: true,
        test: { name: 'pure-domain', environment: 'node', include: pureDomainTests, setupFiles: [] }
      },
      {
        extends: true,
        test: {
          name: 'browser',
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: pureDomainTests,
          setupFiles: ['./src/testSetup.ts']
        }
      }
    ]
  }
});
