import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The e2e builds a Go binary, bootstraps a schema and pairs a real bot.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One worker: the e2e binds loopback ports and owns a Postgres schema, and
    // two copies of it racing is not a test of anything.
    fileParallelism: false,
  },
});
