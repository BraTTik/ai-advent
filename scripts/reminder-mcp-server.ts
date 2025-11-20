import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Tool names
const TOOL_ADD = 'reminder_add_task';
const TOOL_LIST = 'reminder_list_tasks';
const TOOL_COMPLETE = 'reminder_complete_task';
const TOOL_SUMMARY = 'reminder_summary';
const TOOL_FETCH_NOTIFICATION = 'reminder_next_notification';

// Types
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

// Storage paths
async function ensureStorageDirectory(): Promise<string> {
  const home = os.homedir();
  const directory = path.join(home, '.ai_advent');
  if (!existsSync(directory)) {
    await mkdir(directory, { recursive: true });
  }
  return directory;
}

async function defaultStorageFile(): Promise<string> {
  const directory = await ensureStorageDirectory();
  return path.join(directory, 'reminder_tasks.json');
}

async function defaultNotificationFile(): Promise<string> {
  const directory = await ensureStorageDirectory();
  return path.join(directory, 'reminder_notifications.json');
}

// Task Store
class ReminderTaskStore {
  private tasks: ReminderTask[] = [];
  private file: string;
  private mutex: Promise<void>;
  private loadPromise: Promise<void>;

  constructor(file: string) {
    this.file = file;
    this.mutex = Promise.resolve();
    this.loadPromise = this.load();
  }

  private async load(): Promise<void> {
    try {
      if (existsSync(this.file)) {
        const content = await readFile(this.file, 'utf-8');
        this.tasks = JSON.parse(content);
      }
    } catch (error) {
      this.tasks = [];
    }
  }

  private async ensureLoaded(): Promise<void> {
    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.tasks, null, 2), 'utf-8');
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let resolve: () => void;
    this.mutex = new Promise((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  async addTask(
    title: string,
    description?: string,
    dueDate?: string,
    priority?: string,
  ): Promise<ReminderTask> {
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
        completedAt: undefined,
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
        filtered = filtered.filter((t) => t.status.toLowerCase() === status.toLowerCase());
      }
      return filtered.sort((a, b) => {
        if (a.status !== b.status) {
          return a.status.localeCompare(b.status);
        }
        const aDate = a.dueDate || '';
        const bDate = b.dueDate || '';
        if (aDate !== bDate) {
          return aDate.localeCompare(bDate);
        }
        return a.createdAt - b.createdAt;
      });
    });
  }

  async completeTask(taskId: string): Promise<ReminderTask | null> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) {
        return null;
      }
      const updated = { ...task, status: 'done', completedAt: Date.now() };
      this.tasks = this.tasks.map((t) => (t.id === taskId ? updated : t));
      await this.persist();
      return updated;
    });
  }

  async buildSummary(): Promise<ReminderSummary> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const openTasks = this.tasks.filter((t) => t.status === 'open');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];

      const overdue: ReminderTask[] = [];
      const dueToday: ReminderTask[] = [];
      const upcoming: ReminderTask[] = [];

      const upcomingThreshold = new Date(today);
      upcomingThreshold.setDate(upcomingThreshold.getDate() + 7);
      const upcomingThresholdStr = upcomingThreshold.toISOString().split('T')[0];

      for (const task of openTasks) {
        if (!task.dueDate) continue;

        if (task.dueDate < todayStr) {
          overdue.push(task);
        } else if (task.dueDate === todayStr) {
          dueToday.push(task);
        } else if (task.dueDate <= upcomingThresholdStr) {
          upcoming.push(task);
        }
      }

      const lines: string[] = [];
      lines.push('Сводка задач');
      lines.push(`Просрочено: ${overdue.length}`);
      lines.push(`На сегодня: ${dueToday.length}`);
      lines.push(`Ближайшие 7 дней: ${upcoming.length}`);

      if (overdue.length > 0) {
        lines.push('');
        lines.push('Просроченные:');
        overdue.slice(0, 3).forEach((t) => {
          lines.push(`• ${t.title} (до ${t.dueDate})`);
        });
      }

      if (dueToday.length > 0) {
        lines.push('');
        lines.push('Сегодня:');
        dueToday.slice(0, 3).forEach((t) => {
          lines.push(`• ${t.title}`);
        });
      }

      if (upcoming.length > 0) {
        lines.push('');
        lines.push('Скоро:');
        upcoming.slice(0, 3).forEach((t) => {
          lines.push(`• ${t.title} (до ${t.dueDate})`);
        });
      }

      const summaryText = lines.join('\n').trim() || 'Активных задач со сроками нет.';

      return {
        summaryText,
        overdue,
        dueToday,
        upcoming,
      };
    });
  }
}

// Notification Store
class ReminderNotificationStore {
  private notifications: ReminderNotification[] = [];
  private file: string;
  private mutex: Promise<void>;
  private loadPromise: Promise<void>;

  constructor(file: string) {
    this.file = file;
    this.mutex = Promise.resolve();
    this.loadPromise = this.load();
  }

  private async load(): Promise<void> {
    try {
      if (existsSync(this.file)) {
        const content = await readFile(this.file, 'utf-8');
        this.notifications = JSON.parse(content);
      }
    } catch (error) {
      this.notifications = [];
    }
  }

  private async ensureLoaded(): Promise<void> {
    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.notifications, null, 2), 'utf-8');
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let resolve: () => void;
    this.mutex = new Promise((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  async enqueue(summary: ReminderSummary): Promise<ReminderNotification> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const notification: ReminderNotification = {
        id: randomUUID(),
        text: summary.summaryText,
        structured: {
          summary: summary.summaryText,
          overdue: summary.overdue,
          dueToday: summary.dueToday,
          upcoming: summary.upcoming,
        },
        createdAt: Date.now(),
      };
      this.notifications.push(notification);
      await this.persist();
      return notification;
    });
  }

  async popNext(): Promise<ReminderNotification | null> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      if (this.notifications.length === 0) {
        return null;
      }
      const next = this.notifications.shift()!;
      await this.persist();
      return next;
    });
  }
}

// Notification Scheduler
class ReminderNotificationScheduler {
  private storage: ReminderTaskStore;
  private notificationStore: ReminderNotificationStore;
  private timezone: string;
  private targetHour: number;
  private periodicIntervalMinutes?: number;
  private testDelayMinutes?: number;
  private running: boolean = false;

  constructor(
    storage: ReminderTaskStore,
    notificationStore: ReminderNotificationStore,
    timezone: string = 'Europe/Moscow',
    targetHour?: number,
    periodicIntervalMinutes?: number,
    testDelayMinutes?: number,
  ) {
    this.storage = storage;
    this.notificationStore = notificationStore;
    this.timezone = timezone;
    this.targetHour = targetHour ?? this.getReminderSummaryHour();
    this.periodicIntervalMinutes = periodicIntervalMinutes ?? this.getReminderIntervalMinutes();
    this.testDelayMinutes = testDelayMinutes ?? this.getReminderTestDelayMinutes();
  }

  private getReminderIntervalMinutes(): number | undefined {
    const prop = process.env.AI_ADVENT_REMINDER_INTERVAL_MINUTES;
    if (prop) {
      const val = parseInt(prop, 10);
      if (!isNaN(val)) return val;
    }
    return undefined;
  }

  private getReminderSummaryHour(): number {
    const prop = process.env.AI_ADVENT_REMINDER_SUMMARY_HOUR;
    if (prop) {
      const val = parseInt(prop, 10);
      if (!isNaN(val) && val >= 0 && val <= 23) return val;
    }
    return 20;
  }

  private getReminderTestDelayMinutes(): number | undefined {
    const prop = process.env.AI_ADVENT_REMINDER_SUMMARY_TEST_DELAY_MINUTES;
    if (prop) {
      const val = parseInt(prop, 10);
      if (!isNaN(val)) return val;
    }
    return undefined;
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const waitDuration = this.nextWaitDuration();
      await this.sleep(waitDuration);

      if (!this.running) break;

      try {
        const summary = await this.storage.buildSummary();
        await this.notificationStore.enqueue(summary);
      } catch (error) {
        console.error(`[ReminderServer] Failed to enqueue summary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private nextWaitDuration(): number {
    // Periodic interval mode
    if (this.periodicIntervalMinutes) {
      return Math.max(1, this.periodicIntervalMinutes) * 60 * 1000;
    }

    // Test delay mode
    if (this.testDelayMinutes) {
      return Math.max(1, this.testDelayMinutes) * 60 * 1000;
    }

    // Daily at target hour mode
    const now = new Date();
    const today = new Date(now);
    today.setHours(this.targetHour, 0, 0, 0);

    let targetInstant = today.getTime();
    if (targetInstant <= now.getTime()) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      targetInstant = tomorrow.getTime();
    }

    const diffMillis = Math.max(0, targetInstant - now.getTime());
    return diffMillis;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main server setup
async function runReminderServer() {
  const storageFile = await defaultStorageFile();
  const notificationFile = await defaultNotificationFile();
  const storage = new ReminderTaskStore(storageFile);
  const notificationStore = new ReminderNotificationStore(notificationFile);
  const notifier = new ReminderNotificationScheduler(storage, notificationStore);

  // Start notification scheduler in background
  const notifierPromise = notifier.run().catch((error) => {
    console.error(`[ReminderServer] Notification scheduler error: ${error instanceof Error ? error.message : String(error)}`);
  });

  const server = new McpServer(
    {
      name: 'reminder',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
    },
  );

  // Register tools
  server.registerTool(
    TOOL_ADD,
    {
      title: 'Добавить задачу',
      description: 'Добавляет новую задачу в список напоминаний.',
      inputSchema: z.object({
        title: z.string().describe('Название задачи'),
        description: z.string().optional().describe('Опциональное описание'),
        dueDate: z.string().optional().describe('Срок в формате YYYY-MM-DD'),
        priority: z.enum(['low', 'normal', 'high']).optional().describe('Приоритет (low, normal, high)'),
      }),
    },
    async (request) => {
      const { title, description, dueDate, priority } = request;
      if (!title || title.trim() === '') {
        return {
          content: [{ type: 'text', text: "Поле 'title' обязательно." }],
          isError: true,
        };
      }

      const task = await storage.addTask(title.trim(), description, dueDate, priority);
      return {
        content: [{ type: 'text', text: `Добавлена задача '${task.title}' (id=${task.id}).` }],
        structuredContent: task as unknown as { [x: string]: unknown; },
      };
    },
  );

  server.registerTool(
    TOOL_LIST,
    {
      title: 'Список задач',
      description: 'Возвращает задачи с возможностью фильтрации по статусу.',
      inputSchema: z.object({
        status: z.enum(['open', 'done']).optional().describe('Фильтр по статусу (open/done)'),
        limit: z.number().int().min(1).max(100).optional().describe('Максимальное количество задач (1..100)'),
      }),
    },
    async (request) => {
      const { status, limit } = request;
      let tasks = await storage.listTasks(status);

      if (limit) {
        tasks = tasks.slice(0, limit);
      }

      let body: string;
      if (tasks.length === 0) {
        body = 'Список задач пуст.';
      } else {
        const lines = [`Задачи (${tasks.length}):`];
        tasks.forEach((task, index) => {
          const dueDateStr = task.dueDate ? ` — срок до ${task.dueDate}` : '';
          lines.push(`${index + 1}. ${task.title} [${task.status}]${dueDateStr}`);
        });
        body = lines.join('\n');
      }

      return {
        content: [{ type: 'text', text: body }],
        structuredContent: { tasks },
      };
    },
  );

  server.registerTool(
    TOOL_COMPLETE,
    {
      title: 'Завершить задачу',
      description: 'Помечает задачу как выполненную.',
      inputSchema: z.object({
        taskId: z.string().describe('Идентификатор задачи'),
      }),
    },
    async (request) => {
      const { taskId } = request;
      if (!taskId || taskId.trim() === '') {
        return {
          content: [{ type: 'text', text: "Поле 'taskId' обязательно." }],
          isError: true,
        };
      }

      const result = await storage.completeTask(taskId.trim());
      if (!result) {
        return {
          content: [{ type: 'text', text: `Задача ${taskId} не найдена.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: `Задача '${result.title}' завершена.` }],
      };
    },
  );

  server.registerTool(
    TOOL_SUMMARY,
    {
      title: 'Сводка по задачам',
      description: 'Возвращает краткую сводку по активным напоминаниям.',
      inputSchema: z.object({}),
    },
    async () => {
      const summary = await storage.buildSummary();
      return {
        content: [{ type: 'text', text: summary.summaryText }],
        structuredContent: {
          summary: summary.summaryText,
          overdue: summary.overdue,
          dueToday: summary.dueToday,
          upcoming: summary.upcoming,
        },
      };
    },
  );

  server.registerTool(
    TOOL_FETCH_NOTIFICATION,
    {
      title: 'Получить новое уведомление',
      description: 'Возвращает следующее автоматическое уведомление Reminder (если есть).',
      inputSchema: z.object({}),
    },
    async () => {
      const next = await notificationStore.popNext();
      if (!next) {
        return {
          content: [{ type: 'text', text: 'Новых уведомлений нет.' }],
        };
      }

      return {
        content: [{ type: 'text', text: next.text }],
        structuredContent: {
          id: next.id,
          text: next.text,
          createdAt: next.createdAt,
          structured: next.structured,
        },
      };
    },
  );

  // Connect to stdio transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);

  // Handle shutdown
  const shutdown = async () => {
    notifier.stop();
    await notifierPromise.catch(() => {});
    await server.close();
    await transport.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run the server
runReminderServer().catch((error) => {
  console.error('Failed to start reminder server:', error);
  process.exit(1);
});

