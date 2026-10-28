import { parentPort, workerData } from 'node:worker_threads';
import { CronEngine } from './engine.js';

const port = parentPort!;
const engine = new CronEngine(workerData.directory);
const timer = setInterval(() => {
  try { engine.tick(); }
  catch (error) {
    clearInterval(timer);
    port.postMessage({ type: 'fatal', error: String(error) });
  }
}, 1000);

port.on('message', ({ id, command, args }) => {
  try {
    let result: unknown;
    switch (command) {
      case 'create': result = engine.create(args); break;
      case 'cancel': result = engine.cancel(args); break;
      case 'list': result = engine.list(); break;
      case 'take': result = engine.take(); break;
      case 'finish': result = engine.finish(args); break;
      case 'stop': clearInterval(timer); engine.close(); break;
      default: throw new Error(`未知 cron 操作：${command}`);
    }
    port.postMessage({ type: 'response', id, result });
    if (command === 'stop') port.close();
  } catch (error) {
    port.postMessage({ type: 'response', id, error: error instanceof Error ? error.message : String(error) });
  }
});
port.postMessage({ type: 'ready' });
