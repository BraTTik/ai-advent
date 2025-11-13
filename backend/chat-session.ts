export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class ChatSessionManager {
  private readonly compressionThreshold = 10;
  private readonly recentMessagesToKeep = 6;
  private readonly summaryPrefix = "Краткое резюме предыдущего диалога:";

  private sessions: Map<string, ChatMessage[]> = new Map();
  private systemPrompts: Map<string, string> = new Map();

  /**
   * Получить или создать сессию
   */
  getSession(sessionId: string, systemPrompt?: string): ChatMessage[] {
    if (!this.sessions.has(sessionId)) {
      const messages: ChatMessage[] = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
        this.systemPrompts.set(sessionId, systemPrompt);
      }
      this.sessions.set(sessionId, messages);
    } else if (systemPrompt && !this.systemPrompts.has(sessionId)) {
      // Если сессия существует, но нет system prompt, добавляем его в начало
      const messages = this.sessions.get(sessionId)!;
      if (messages.length === 0 || messages[0].role !== "system") {
        messages.unshift({ role: "system", content: systemPrompt });
        this.systemPrompts.set(sessionId, systemPrompt);
      }
    }
    return this.sessions.get(sessionId)!;
  }

  /**
   * Добавить сообщение пользователя в сессию
   */
  addUserMessage(sessionId: string, content: string): void {
    const messages = this.getSession(sessionId);
    messages.push({ role: "user", content });
  }

  /**
   * Добавить сообщение ассистента в сессию
   */
  addAssistantMessage(sessionId: string, content: string): void {
    const messages = this.getSession(sessionId);
    messages.push({ role: "assistant", content });
  }

  /**
   * Получить все сообщения сессии
   */
  getMessages(sessionId: string): ChatMessage[] {
    return this.getSession(sessionId);
  }

  /**
   * Очистить сессию
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.systemPrompts.delete(sessionId);
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

