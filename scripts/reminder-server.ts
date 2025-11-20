import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/* -------------------------------------------------------------------------------------------
 * 1. STORAGE + SCHEDULER (не менял логику из второго сервера)
 * -----------------------------------------------------------------------------------------*/

interface ReminderTask {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  priority?: string;
  status: string;
  createdAt: number;
  completedAt?: number;
}

interface ReminderSummary {
  summaryText: string;
  overdue: ReminderTask[];
  dueToday: ReminderTask[];
  upcoming: ReminderTask[];
}

interface ReminderNotification {
  id: string;
  text: string;
  structured: Record<string, any>;
  createdAt: number;
}

async function ensureStorageDirectory(): Promise<string> {
  const home = os.homedir();
  const directory = path.join(home, '.ai_advent');
  if (!existsSync(directory)) {
    await mkdir(directory, { recursive: true });
  }
  return directory;
}

async function defaultStorageFile(): Promise<string> {
  const dir = await ensureStorageDirectory();
  return path.join(dir, 'reminder_tasks.json');
}

async function defaultNotificationFile(): Promise<string> {
  const dir = await ensureStorageDirectory();
  return path.join(dir, 'reminder_notifications.json');
}

class ReminderTaskStore {
  private tasks: ReminderTask[] = [];
  private file: string;
  private loadPromise: Promise<void>;
  private mutex = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    this.loadPromise = this.load();
  }

  private async load() {
    try {
      if (existsSync(this.file)) {
        this.tasks = JSON.parse(await readFile(this.file, 'utf-8'));
      }
    } catch {
      this.tasks = [];
    }
  }

  private async ensureLoaded() {
    await this.loadPromise;
  }

  private async persist() {
    await writeFile(this.file, JSON.stringify(this.tasks, null, 2), 'utf-8');
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let nextResolve;
    this.mutex = new Promise((r) => (nextResolve = r));
    await prev;
    try {
      return await fn();
    } finally {
      nextResolve();
    }
  }

  async addTask(title: string, description?: string, dueDate?: string, priority?: string) {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const task: ReminderTask = {
        id: randomUUID(),
        title,
        description,
        dueDate,
        priority,
        status: 'open',
        createdAt: Date.now(),
      };
      this.tasks.push(task);
      await this.persist();
      return task;
    });
  }

  async listTasks(status?: string): Promise<ReminderTask[]> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      let filtered = this.tasks;
      if (status) {
        filtered = filtered.filter((t) => t.status === status);
      }
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  async completeTask(taskId: string) {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      task.status = 'done';
      task.completedAt = Date.now();
      await this.persist();
      return task;
    });
  }

  async buildSummary(): Promise<ReminderSummary> {
    await this.ensureLoaded();

    return this.withLock(async () => {
      const open = this.tasks.filter((t) => t.status === 'open');

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];

      const overdue = open.filter((t) => t.dueDate && t.dueDate < todayStr);
      const dueToday = open.filter((t) => t.dueDate === todayStr);

      const upcomingThreshold = new Date(today);
      upcomingThreshold.setDate(today.getDate() + 7);
      const upcomingStr = upcomingThreshold.toISOString().split('T')[0];
      const upcoming = open.filter((t) => t.dueDate && t.dueDate > todayStr && t.dueDate <= upcomingStr);

      const lines = [
        'Сводка задач',
        `Просрочено: ${overdue.length}`,
        `На сегодня: ${dueToday.length}`,
        `Ближайшие 7 дней: ${upcoming.length}`,
      ];

      return {
        summaryText: lines.join('\n'),
        overdue,
        dueToday,
        upcoming,
      };
    });
  }
}

class ReminderNotificationStore {
  private notifications: ReminderNotification[] = [];
  private file: string;
  private loadPromise: Promise<void>;
  private mutex = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    this.loadPromise = this.load();
  }

  private async load() {
    try {
      if (existsSync(this.file)) {
        this.notifications = JSON.parse(await readFile(this.file, 'utf-8'));
      }
    } catch {
      this.notifications = [];
    }
  }

  private async ensureLoaded() {
    await this.loadPromise;
  }

  private async persist() {
    await writeFile(this.file, JSON.stringify(this.notifications, null, 2), 'utf-8');
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let nextResolve;
    this.mutex = new Promise((r) => (nextResolve = r));
    await prev;
    try {
      return await fn();
    } finally {
      nextResolve();
    }
  }

  async enqueue(summary: ReminderSummary) {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const n: ReminderNotification = {
        id: randomUUID(),
        text: summary.summaryText,
        structured: summary,
        createdAt: Date.now(),
      };
      this.notifications.push(n);
      await this.persist();
      return n;
    });
  }

  async popNext() {
    await this.ensureLoaded();
    return this.withLock(async () => {
      if (this.notifications.length === 0) return null;
      const next = this.notifications.shift();
      await this.persist();
      return next;
    });
  }
}

class ReminderNotificationScheduler {
  constructor(
    private store: ReminderTaskStore,
    private notifs: ReminderNotificationStore,
    private intervalMin = 1
  ) {}

  private running = true;

  async run() {
    while (this.running) {
      await new Promise((r) => setTimeout(r, this.intervalMin * 60 * 1000));
      try {
        const summary = await this.store.buildSummary();
        await this.notifs.enqueue(summary);
      } catch (e) {
        console.error('Scheduler error', e);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

async function createReminderServer() {
  const storage = new ReminderTaskStore(await defaultStorageFile());
  const notifications = new ReminderNotificationStore(await defaultNotificationFile());
  const scheduler = new ReminderNotificationScheduler(storage, notifications);
  scheduler.run().catch(console.error);

  const server = new McpServer(
    { name: 'reminder', version: '1.0.0' },
    { capabilities: { logging: {}, tools: { listChanged: true } } }
  );

  server.registerTool(
    'reminder_add_task',
    {
      title: 'Добавить задачу',
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        dueDate: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      }),
    },
    async ({ title, description, dueDate, priority }) => {
      const task = await storage.addTask(title, description, dueDate, priority);
      return { content: [{ type: 'text', text: `Добавлена задача '${task.title}'.` }], structuredContent: task as unknown as { [x: string]: unknown; } };
    }
  );

  server.registerTool(
    'reminder_list_tasks',
    {
      title: 'Список задач',
      inputSchema: z.object({
        status: z.enum(['open', 'done']).optional(),
      }),
    },
    async ({ status }) => {
      const tasks = await storage.listTasks(status);
      const lines = tasks.map((t) => `• ${t.title} [${t.status}]${t.dueDate ? ' — ' + t.dueDate : ''}`).join('\n');
      return {
        content: [{ type: 'text', text: lines || 'Пусто.' }],
        structuredContent: { tasks },
      };
    }
  );

  server.registerTool(
    'reminder_complete_task',
    {
      title: 'Завершить задачу',
      inputSchema: z.object({ taskId: z.string() }),
    },
    async ({ taskId }) => {
      const t = await storage.completeTask(taskId);
      if (!t) return { content: [{ type: 'text', text: 'Задача не найдена.' }], isError: true };
      return { content: [{ type: 'text', text: `Задача '${t.title}' завершена.` }] };
    }
  );

  server.registerTool(
    'reminder_summary',
    { title: 'Сводка', inputSchema: z.object({}) },
    async () => {
      const s = await storage.buildSummary();
      return { content: [{ type: 'text', text: s.summaryText }], structuredContent: s as unknown as { [x: string]: unknown; } };
    }
  );

  server.registerTool(
    'reminder_next_notification',
    { title: 'Уведомление', inputSchema: z.object({}) },
    async () => {
      const n = await notifications.popNext();
      if (!n) return { content: [{ type: 'text', text: 'Нет новых.' }] };
      return { content: [{ type: 'text', text: n.text }], structuredContent: n as unknown as { [x: string]: unknown; } };
    }
  );

  return server;
}


type SessionEntry = { server: McpServer; transport: StreamableHTTPServerTransport };
const activeSessions = new Map<string, SessionEntry>();

function cleanupSession(id?: string) {
  if (!id) return;
  const e = activeSessions.get(id);
  if (!e) return;
  e.transport.close().catch(() => {});
  e.server.close().catch(() => {});
  activeSessions.delete(id);
}

async function ensureSession(req: Request, res: Response) {
  const raw = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;

  if (sessionId && activeSessions.has(sessionId)) {
    return activeSessions.get(sessionId)!;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Initialization required' },
      id: null,
    });
    return null;
  }

  const server = await createReminderServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => activeSessions.set(id, { server, transport }),
    onsessionclosed: (id) => cleanupSession(id),
  });

  transport.onclose = () => cleanupSession(transport.sessionId);

  await server.connect(transport);

  return { server, transport };
}

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'mcp-session-id'] }));

app.post('/mcp', async (req, res) => {
  const entry = await ensureSession(req, res);
  if (!entry) return;
  await entry.transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const id = (req.headers['mcp-session-id'] as string) || '';
  if (!activeSessions.has(id)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid session ID' },
      id: null,
    });
    return;
  }
  const entry = activeSessions.get(id)!;
  await entry.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const id = req.headers['mcp-session-id'] as string;
  cleanupSession(id);
  res.json({ status: 'closed' });
});

app.get('/', (req, res) => res.json({ ok: true, message: 'Reminder MCP Server running' }));

app.listen(4000, () => console.log(`Reminder MCP HTTP server on http://localhost:4000`));