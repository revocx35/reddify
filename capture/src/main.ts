import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { createServer } from './server.js';

const log = (msg: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
};

const cfg = loadConfig();
const engine = new Engine(cfg, log);
const server = createServer({ cfg, engine, log });

server.listen(cfg.port, cfg.host, () => {
  log(`capture engine listening on ${cfg.host}:${cfg.port} (speaker ${cfg.sinkName}.monitor, ${cfg.rate} Hz ${cfg.channels} ch)`);
});

// Warm the browser up in the background: the first capture then starts with the player already loaded.
void engine
  .ensure()
  .then(() => log('browser started'))
  .catch((e: unknown) => log(`browser did not start yet: ${e instanceof Error ? e.message : String(e)}`));

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  server.close();
  void engine
    .stopBrowser()
    .catch(() => undefined)
    .then(() => process.exit(0));
  setTimeout(() => process.exit(0), 15_000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
