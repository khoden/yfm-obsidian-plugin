import { mkdir, copyFile } from 'node:fs/promises';
const destination = 'test-vault/.obsidian/plugins/yfm-preview';
await mkdir(destination, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css'])
    await copyFile(file, `${destination}/${file}`);
console.log(`Installed prototype into ${destination}`);
