import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { errMsg, log } from '../core/log.js';
import { dispatcher } from '../core/queue.js';
import { getSocket, isConnected } from '../core/socket.js';

export interface ScheduledJob {
  id: number;
  jid: string;
  message: string;
  kind: 'cron' | 'once';
  /** cron expression for "cron", ISO time for "once". */
  when: string;
  createdAt: number;
  lastRunAt?: number;
}

const FILE = path.join(config.paths.data, 'schedules.json');
const jobs = new Map<number, ScheduledJob>();
const tasks = new Map<number, ScheduledTask>();
let nextId = 1;
let ticker: NodeJS.Timeout | null = null;

async function persist() {
  await mkdir(config.paths.data, { recursive: true });
  await writeFile(FILE, JSON.stringify([...jobs.values()], null, 2));
}

async function dispatch(job: ScheduledJob, sock?: WASocket) {
  const s = sock ?? getSocket();
  job.lastRunAt = Date.now();
  log.event(`[scheduler] job #${job.id} firing → ${job.jid}`);
  await dispatcher.enqueue(s, job.jid, job.message, { label: `scheduled #${job.id} → ${job.jid}` });
}

function arm(job: ScheduledJob) {
  if (job.kind === 'cron') {
    const task = cron.schedule(job.when, () => {
      if (!isConnected()) {
        log.warn(`[scheduler] job #${job.id} skipped: WhatsApp not connected`);
        return;
      }
      void dispatch(job)
        .then(persist)
        .catch((e) => log.error(`[scheduler] job #${job.id} failed: ${errMsg(e)}`));
    });
    tasks.set(job.id, task);
  }
  ensureTicker();
}

/** One-off jobs are checked every 15s (robust to sleep/long delays, unlike a giant setTimeout). */
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.kind !== 'once' || Date.parse(job.when) > now) continue;
      if (!isConnected()) continue; // wait until we're back online, then send
      jobs.delete(job.id);
      void dispatch(job)
        .catch((e) => log.error(`[scheduler] job #${job.id} failed: ${errMsg(e)}`))
        .finally(() => void persist());
    }
  }, 15_000);
  ticker.unref();
}

/** Recurring message on a cron schedule, e.g. "0 9 * * 1-5" = weekdays at 9:00. */
export function scheduleMessage(sock: WASocket | null, jid: string, message: string, cronExpr: string): ScheduledJob {
  void sock; // dispatch always uses the live socket so jobs survive reconnects
  if (!cron.validate(cronExpr)) throw new Error(`invalid cron expression: "${cronExpr}"`);
  if (!message.trim()) throw new Error('message is empty');
  const job: ScheduledJob = { id: nextId++, jid, message, kind: 'cron', when: cronExpr, createdAt: Date.now() };
  jobs.set(job.id, job);
  arm(job);
  void persist();
  log.info(`[scheduler] job #${job.id} scheduled (${cronExpr}) → ${jid}`);
  return job;
}

/**
 * Parse "+10m", "+2h", "+1d", "+30s", "18:30" (next occurrence) or any Date-parsable string.
 */
export function parseWhen(input: string, now = new Date()): Date {
  const rel = input.match(/^\+(\d+)\s*([smhd])$/i);
  if (rel) {
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return new Date(now.getTime() + Number(rel[1]) * mult);
  }
  const hm = input.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`can't understand time "${input}" (try +10m, 18:30 or 2026-12-31T09:00)`);
  return d;
}

/** One-off future message. */
export function scheduleOnce(jid: string, message: string, when: Date): ScheduledJob {
  if (when.getTime() <= Date.now()) throw new Error('that time is in the past');
  if (!message.trim()) throw new Error('message is empty');
  const job: ScheduledJob = { id: nextId++, jid, message, kind: 'once', when: when.toISOString(), createdAt: Date.now() };
  jobs.set(job.id, job);
  arm(job);
  void persist();
  log.info(`[scheduler] job #${job.id} will send at ${when.toLocaleString()} → ${jid}`);
  return job;
}

export function listJobs(): ScheduledJob[] {
  return [...jobs.values()].sort((a, b) => a.id - b.id);
}

export function cancelJob(id: number): boolean {
  const existed = jobs.delete(id);
  tasks.get(id)?.stop();
  tasks.delete(id);
  if (existed) void persist();
  return existed;
}

/** Restore saved jobs on startup. */
export async function loadJobs() {
  let saved: ScheduledJob[] = [];
  try {
    saved = JSON.parse(await readFile(FILE, 'utf8')) as ScheduledJob[];
  } catch {
    return;
  }
  for (const job of saved) {
    if (job.kind === 'cron' && !cron.validate(job.when)) continue;
    jobs.set(job.id, job);
    nextId = Math.max(nextId, job.id + 1);
    arm(job);
  }
  if (saved.length) log.info(`[scheduler] restored ${jobs.size} scheduled job(s)`);
}
