import { packager } from '@electron/packager';
import { cp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, '.cache/package-app');
await mkdir(staging, { recursive: true });
for (const folder of ['desktop','public','server']) await cp(join(root, folder), join(staging, folder), { recursive: true });
const source = JSON.parse(await readFile(join(root,'package.json'), 'utf8'));
for (const dependency of Object.keys(source.dependencies || {})) {
  await cp(join(root, 'node_modules', dependency), join(staging, 'node_modules', dependency), { recursive: true });
}
const zipDir = join(root, '.cache/electron-zips');
let localZip = false;
try { await access(join(zipDir, 'electron-v' + source.devDependencies.electron + '-win32-x64.zip')); localZip = true; } catch {}
await writeFile(join(staging,'package.json'), JSON.stringify({
  name: 'album-wall', version: source.version, productName: '唱片墙', type: 'module',
  main: 'desktop/main.mjs', description: source.description, author: 'Album Wall', dependencies: source.dependencies
}, null, 2));

const paths = await packager({
  dir: staging, name: 'Album Wall', platform: 'win32', arch: 'x64',
  electronVersion: source.devDependencies.electron,
  ...(localZip ? { electronZipDir: zipDir } : {}),
  out: join(root, 'dist'), overwrite: true, asar: true,
  icon: join(root,'desktop/icon.ico'),
  appVersion: source.version, appCopyright: 'Album Wall',
  win32metadata: { ProductName: '唱片墙 · Album Wall', FileDescription: '唱片墙', CompanyName: 'Album Wall' }
});
console.log('Packaged application:', paths[0]);
