import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

interface SessionData {
  messages: ChatMessage[];
  systemPrompt?: string;
}

export class ChatSessionManager {
  private readonly compressionThreshold = 30;
  private readonly recentMessagesToKeep = 10;
  private readonly summaryPrefix = "Краткое резюме предыдущего диалога:";
  private readonly sessionsDir: string;

  private sessions: Map<string, ChatMessage[]> = new Map();
  private systemPrompts: Map<string, string> = new Map();
  private initialized: Promise<void>;

  constructor() {
    // Определяем путь к папке sessions относительно текущего файла
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.sessionsDir = path.join(__dirname, "sessions");
    
    // Инициализация: создание папки и загрузка сессий
    this.initialized = this.initialize();
  }

  /**
   * Инициализация: создание папки и загрузка всех сессий
   */
  private async initialize(): Promise<void> {
    try {
      // Создаем папку sessions, если её нет
      await fs.mkdir(this.sessionsDir, { recursive: true });
      
      // Загружаем все существующие сессии
      await this.loadAllSessions();
    } catch (error) {
      console.error("Ошибка при инициализации ChatSessionManager:", error);
    }
  }

  /**
   * Дождаться завершения инициализации
   */
  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }

  /**
   * Получить путь к файлу сессии
   */
  private getSessionFilePath(sessionId: string): string {
    // Очищаем sessionId от недопустимых символов для имени файла
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.sessionsDir, `${safeSessionId}.json`);
  }

  /**
   * Сохранить сессию на диск
   */
  private async saveSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    
    const messages = this.sessions.get(sessionId);
    const systemPrompt = this.systemPrompts.get(sessionId);
    
    if (!messages) {
      return;
    }

    const sessionData: SessionData = {
      messages,
      systemPrompt
    };

    const filePath = this.getSessionFilePath(sessionId);
    
    try {
      await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), "utf-8");
    } catch (error) {
      console.error(`Ошибка при сохранении сессии ${sessionId}:`, error);
    }
  }

  /**
   * Загрузить сессию с диска
   */
  private async loadSession(sessionId: string): Promise<boolean> {
    
    const filePath = this.getSessionFilePath(sessionId);
    
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const sessionData: SessionData = JSON.parse(data);

      this.sessions.set(sessionId, sessionData.messages);
      if (sessionData.systemPrompt) {
        this.systemPrompts.set(sessionId, sessionData.systemPrompt);
      }
      
      return true;
    } catch (error) {
      // Файл не существует или ошибка чтения - это нормально для новых сессий
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Ошибка при загрузке сессии ${sessionId}:`, error);
      }
      return false;
    }
  }

  /**
   * Загрузить все сессии с диска
   */
  private async loadAllSessions(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const jsonFiles = files.filter(file => file.endsWith(".json"));

      for (const file of jsonFiles) {
        const sessionId = path.basename(file, ".json");
        await this.loadSession(sessionId);
      }
      
      console.log(`Загружено ${jsonFiles.length} сессий с диска`);
    } catch (error) {
      console.error("Ошибка при загрузке сессий:", error);
    }
  }

  /**
   * Удалить файл сессии с диска
   */
  private async deleteSessionFile(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    
    const filePath = this.getSessionFilePath(sessionId);
    
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Файл не существует - это нормально
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Ошибка при удалении файла сессии ${sessionId}:`, error);
      }
    }
  }

  /**
   * Получить или создать сессию
   */
  async getSession(sessionId: string, systemPrompt?: string): Promise<ChatMessage[]> {
    await this.ensureInitialized();

    if (!this.sessions.has(sessionId)) {
      // Пытаемся загрузить с диска
      const loaded = await this.loadSession(sessionId);
      
      if (!loaded) {
        // Создаем новую сессию
        const messages: ChatMessage[] = [];
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
          this.systemPrompts.set(sessionId, systemPrompt);
        }
        this.sessions.set(sessionId, messages);
        await this.saveSession(sessionId);
      } else if (systemPrompt && !this.systemPrompts.has(sessionId)) {
        // Если загрузили с диска, но нет system prompt, добавляем его
        const messages = this.sessions.get(sessionId)!;
        if (messages.length === 0 || messages[0].role !== "system") {
          messages.unshift({ role: "system", content: systemPrompt });
          this.systemPrompts.set(sessionId, systemPrompt);
          await this.saveSession(sessionId);
        }
      }
    } else if (systemPrompt && !this.systemPrompts.has(sessionId)) {
      // Если сессия существует, но нет system prompt, добавляем его в начало
      const messages = this.sessions.get(sessionId)!;
      if (messages.length === 0 || messages[0].role !== "system") {
        messages.unshift({ role: "system", content: systemPrompt });
        this.systemPrompts.set(sessionId, systemPrompt);
        await this.saveSession(sessionId);
      }
    }
    return this.sessions.get(sessionId)!;
  }

  /**
   * Добавить сообщение пользователя в сессию
   */
  async addUserMessage(sessionId: string, content: string): Promise<void> {
    const messages = await this.getSession(sessionId);
    messages.push({ role: "user", content });
    await this.saveSession(sessionId);
  }

  /**
   * Добавить системное сообщение в сессию
   */
  async addSystemMessage(sessionId: string, content: string): Promise<void> {
    const messages = await this.getSession(sessionId);
    messages.push({ role: "system", content });
    await this.saveSession(sessionId);
  }

  /**
   * Добавить сообщение ассистента в сессию
   */
  async addAssistantMessage(sessionId: string, content: string): Promise<void> {
    const messages = await this.getSession(sessionId);
    messages.push({ role: "assistant", content });
    await this.saveSession(sessionId);
  }

  /**
   * Получить все сообщения сессии
   */
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return await this.getSession(sessionId);
  }

  /**
   * Очистить сессию
   */
  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.systemPrompts.delete(sessionId);
    await this.deleteSessionFile(sessionId);
  }

  /**
   * Сжать историю, если накопилось достаточно сообщений
   */
  async compressIfNeeded(
    sessionId: string,
    compressor: (messages: ChatMessage[]) => Promise<string>
  ): Promise<boolean> {
    const sessionMessages = this.sessions.get(sessionId);
    if (!sessionMessages) {
      return false;
    }

    const systemPrompt = this.systemPrompts.get(sessionId);

    // Удаляем предыдущие резюме, чтобы не копить их
    const cleanedMessages = sessionMessages.filter(
      (message, index) =>
        !(
          message.role === "system" &&
          message.content.startsWith(this.summaryPrefix) &&
          (!systemPrompt || index > 0)
        )
    );

    const startIndex = systemPrompt ? 1 : 0;
    const conversationMessages = cleanedMessages.slice(startIndex);

    if (conversationMessages.length < this.compressionThreshold) {
      this.sessions.set(sessionId, cleanedMessages);
      return false;
    }

    const cutoffIndex = Math.max(
      conversationMessages.length - this.recentMessagesToKeep,
      0
    );

    const messagesForCompression = conversationMessages.slice(0, cutoffIndex);
    const recentMessages = conversationMessages.slice(cutoffIndex);

    if (messagesForCompression.length === 0) {
      this.sessions.set(sessionId, cleanedMessages);
      return false;
    }

    const summary = await compressor(messagesForCompression);
    const updatedMessages: ChatMessage[] = [];

    if (systemPrompt) {
      updatedMessages.push({ role: "system", content: systemPrompt });
    }

    if (summary) {
      updatedMessages.push({
        role: "system",
        content: `${this.summaryPrefix}\n${summary}`
      });
    }

    updatedMessages.push(...recentMessages);
    this.sessions.set(sessionId, updatedMessages);
    await this.saveSession(sessionId);
    return true;
  }

  /**
   * Удалить старые сессии (опционально, для очистки памяти)
   */
  clearOldSessions(olderThanHours: number = 24): void {
    // Простая реализация - можно улучшить, добавив метаданные о времени создания
    // Для простоты оставляем все сессии в памяти
  }
}

