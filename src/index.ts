import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { setSelfCommandRunner } from './core/assistant.js';
import { errMsg, log } from './core/log.js';
import { startWhatsApp } from './core/whatsapp.js';
import { connectCustom, stopLlamaServer } from './services/llm.js';
import { loadJobs } from './services/scheduler.js';
import { startCli } from './ui/cli.js';
import { runCommand } from './ui/commands.js';
import { startDashboard } from './web/server.js';

async function main() {
  await mkdir(config.paths.temp, { recursive: true });
  await mkdir(config.paths.data, { recursive: true });

  startCli();
  startDashboard();
  setSelfCommandRunner(runCommand);
  await loadJobs();

  // Custom provider with a .gguf configured: launch it in the background so it's warm for the first reply.
  if (config.AI_PROVIDER === 'custom' && /\.gguf$/i.test(config.CUSTOM_MODEL_PATH)) {
    connectCustom(config.CUSTOM_MODEL_PATH).catch((e) => log.error(`[llm] could not start model: ${errMsg(e)}`));
  }

  await startWhatsApp();
}

const shutdown = () => {
  stopLlamaServer();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log.error(`unhandled: ${errMsg(e)}`));

main().catch((e) => {
  log.error(`fatal: ${errMsg(e)}`);
  process.exit(1);
});
