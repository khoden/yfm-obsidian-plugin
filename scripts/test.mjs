import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({
    entryPoints: ['src/cache.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: '.test/cache.cjs',
});
await build({
    entryPoints: ['src/images.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: '.test/images.cjs',
});
await build({
    entryPoints: ['src/localization.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: '.test/localization.cjs',
});
const { options } = await import('./build.mjs');
await build(options);
const result = spawnSync(
    process.execPath,
    ['--test', 'tests/cache.test.cjs', 'tests/lifecycle.test.cjs', 'tests/localization.test.cjs'],
    { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
