import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

const compiler = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit' });
const code = await new Promise(resolve => compiler.on('exit', resolve));
if (code) process.exit(code);
const server = await createServer();
await server.listen();
server.printUrls();
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: true });
let ending = false;
async function shutdown(code = 0) {
  if (ending) return;
  ending = true;
  child.kill();
  await server.close();
  process.exit(code || 0);
}
child.on('exit', shutdown);
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
