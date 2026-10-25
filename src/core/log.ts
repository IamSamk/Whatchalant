import { EventEmitter } from 'node:events';

export type LogLevel = 'info' | 'warn' | 'error' | 'event' | 'draft';
export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const MAX = 300;
const entries: LogEntry[] = [];
export const logEvents = new EventEmitter();

const colors: Record<LogLevel, string> = {
  info: '\x1b[37m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  event: '\x1b[36m',
  draft: '\x1b[35m',
};

/** The CLI swaps this in so log lines don't trample the prompt. */
let writer: (line: string) => void = (line) => console.log(line);
export function setLogWriter(fn: (line: string) => void) {
  writer = fn;
}

function push(level: LogLevel, msg: string) {
  const entry = { ts: Date.now(), level, msg };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  const time = new Date(entry.ts).toLocaleTimeString();
  writer(`\x1b[90m${time}\x1b[0m ${colors[level]}${msg}\x1b[0m`);
  logEvents.emit('log', entry);
}

export const log = {
  info: (m: string) => push('info', m),
  warn: (m: string) => push('warn', m),
  error: (m: string) => push('error', m),
  event: (m: string) => push('event', m),
  draft: (m: string) => push('draft', m),
  recent: (n = 100) => entries.slice(-n),
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
