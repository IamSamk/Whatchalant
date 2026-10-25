import readline from 'node:readline';
import { state } from '../config.js';
import { setLogWriter } from '../core/log.js';
import { runCommandSafe, statusText } from './commands.js';

/** Interactive console. Log lines print above the prompt without clobbering what you're typing. */
export function startCli() {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  const prompt = () => `\x1b[90m[${state.connection}]\x1b[0m wa> `;
  rl.setPrompt(prompt());

  setLogWriter((line) => {
    if (!interactive) return void console.log(line);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(line);
    rl.setPrompt(prompt());
    rl.prompt(true);
  });

  state.on('change', () => rl.setPrompt(prompt()));

  rl.on('line', async (line) => {
    if (line.trim()) {
      const out = await runCommandSafe(line);
      if (out) console.log(out.startsWith('error:') ? `\x1b[31m${out}\x1b[0m` : out);
    }
    rl.prompt();
  });

  // Without a terminal (e.g. run in the background) stdin may close immediately; keep the app running.
  rl.on('close', () => {
    if (interactive) process.exit(0);
  });

  console.log(statusText());
  console.log('Type :help for commands.\n');
  rl.prompt();
}
