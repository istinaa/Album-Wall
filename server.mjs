import { createApp } from './server/app.mjs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 的整数');
const server = createApp({ cacheDir: fileURLToPath(new URL('./.cache/covers/', import.meta.url)) });
server.listen(port, host, () => console.log(`Album Wall: http://${host}:${port}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请调整 PORT。` : error.message);
  process.exitCode = 1;
});
