import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['projects/pasturepact/source/tests/*.test.ts'], environment: 'node', fileParallelism: false } });
