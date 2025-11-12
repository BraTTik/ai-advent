export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class ChatSessionManager {
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
   * Удалить старые сессии (опционально, для очистки памяти)
   */
  clearOldSessions(olderThanHours: number = 24): void {
    // Простая реализация - можно улучшить, добавив метаданные о времени создания
    // Для простоты оставляем все сессии в памяти
  }
}

