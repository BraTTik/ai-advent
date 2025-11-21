import express from 'express';
import cors from 'cors';
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { AIClient } from "./ai-client.ts";
import { ChatSessionManager } from "./chat-session.ts";

process.env.NODE_EXTRA_CA_CERTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../russian_cert/russiantrustedca2024.pem');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

// const API_KEY = process.env.API_KEY;
// const scope = 'GIGACHAT_API_PERS';

const ai = new AIClient({
  apiKey: process.env.HF_API_KEY!,
  provider: "huggingface",
  model: "Qwen/Qwen2.5-7B-Instruct:together",
});

// Регистрируем MCP серверы
(async () => {
  try {
    // Регистрируем weather MCP сервер
    if (process.env.WEATHER_MCP_URL) {
      const weatherPort = process.env.WEATHER_MCP_PORT ?? 3333;
      await ai.registerMCP({
        url: `${process.env.WEATHER_MCP_URL}:${weatherPort}/mcp`,
        name: "weather",
      });
    }
    // Регистрируем filesystem MCP сервер
    const filesystemPort = process.env.FILESYSTEM_MCP_PORT ?? 3334;
    if (process.env.FILESYSTEM_MCP_URL) {
      await ai.registerMCP({
        url: `${process.env.FILESYSTEM_MCP_URL}:${filesystemPort}/mcp`,
        name: "filesystem",
      });
    }

    // Регистрируем reminder MCP сервер (если нужен)
    // if (process.env.REMINDER_MCP_URL) {
    //   await ai.registerMCP({
    //     url: process.env.REMINDER_MCP_URL,
    //     name: "reminder",
    //   });
    // }
  } catch (error) {
    console.error("Ошибка при регистрации MCP серверов:", error);
  }
})();

const sessionManager = new ChatSessionManager();


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


const weatherRegex = /(?:погода|weather)/i;

function isWeather(input: string): boolean {
  return weatherRegex.test(input);
}

// Пример эндпоинта для чата
app.post('/chat', async (req, res) => {
  try {
    const { 
      prompt, 
      model = "CohereLabs/c4ai-command-r7b-arabic-02-2025:cohere",
      sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    } = req.body;

    // System prompt для ассистента
    const plannerPrompt = `
      Ты личный помощник. Для ответов ВСЕГДА проверяй, можешь ли ты использовать доступные тебе инструменты. Если можешь, используй их. Отвечай на русском языке.
    `;

    // Получаем или создаем сессию с системным промптом
    await sessionManager.getSession(sessionId, plannerPrompt);
    
    // Добавляем сообщение пользователя в историю
    await sessionManager.addUserMessage(sessionId, prompt);

    // Получаем всю историю сообщений для контекста
    const messages = await sessionManager.getMessages(sessionId);

    // ai.setModel(model);
    console.log("chat")
    const response = await ai.chat(messages);

    // Добавляем ответ ассистента в историю
    await sessionManager.addAssistantMessage(sessionId, response.content);

    await sessionManager.compressIfNeeded(sessionId, (history) =>
      ai.summarizeConversation(history)
    );

    res.json({ 
      chat: response.content, 
      model,
      sessionId,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка при обработке запроса" });
  }
});

// Эндпоинт для очистки сессии
app.post('/chat/clear', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId обязателен" });
    }
    await sessionManager.clearSession(sessionId);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка при очистке сессии" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
