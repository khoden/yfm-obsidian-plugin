import { build, context } from 'esbuild';
export const options = {
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'es2022',
    format: 'cjs',
    external: [
        'obsidian',
        'electron',
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
    ],
    outfile: 'main.js',
    loader: { '.css': 'text' },
    plugins: [
        {
            name: 'runtime-as-text',
            setup(build) {
                build.onLoad({ filter: /[\/]dist[\/]js[\/]yfm\.js$/ }, async ({ path }) => ({
                    contents: await (await import('node:fs/promises')).readFile(path, 'utf8'),
                    loader: 'text',
                }));
            },
        },
    ],
};
if (process.argv[1]?.endsWith('build.mjs') && process.argv.includes('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('Watching plugin sources; run pnpm run install:test-vault after rebuilding.');
} else if (process.argv[1]?.endsWith('build.mjs')) await build(options);
