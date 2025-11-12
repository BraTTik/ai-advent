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
  model: "moonshotai/Kimi-K2-Thinking:novita"
})

const sessionManager = new ChatSessionManager();


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// const messages = [
//   {
//   role: "system",
//   content: `
//       Тебе будет приходит задания на логику. Твоя задача решить её при помощи совета, состоящей из компании алкашей - физик,
//       грузчика и Basic-программиста. При это ты должен прислать рассуждения каждого члена при решении задания. Не надо давать советы по решению задания.
//       Ответ нужно вернуть ввиде валидного-JSON:
//         {
//           "persons": [
//             {
//               "id": "fizruk" // id физрука,
//               "content": "string" // рассуждения физрука при решении задания
//             },
//             {
//               "id": "loader" // id грузчика,
//               "content": "string" // рассуждения грузчика при решении задания
//             },
//             {
//               "id": "programmer" // id программиста,
//               "content": "string" // рассуждения программиста при решении задания
//             },
//           ],
//           "result": "string" // решение задания
//         }
//
//       Важно! Строго! Перед отправкой убедись, что JSON валидный и что все двойные кавычки на своих местах!.
//       `
//   },
// ]

// Пример эндпоинта для чата
app.post('/chat', async (req, res) => {
  try {
    const { 
      prompt, 
      model = "moonshotai/Kimi-K2-Thinking:novita",
      sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    } = req.body;

    // System prompt для ассистента
    const plannerPrompt = `
      Ты личный помощник. Отвечай на русском языке.
    `;

    // Получаем или создаем сессию с системным промптом
    sessionManager.getSession(sessionId, plannerPrompt);
    
    // Добавляем сообщение пользователя в историю
    sessionManager.addUserMessage(sessionId, prompt);

    // Получаем всю историю сообщений для контекста
    const messages = sessionManager.getMessages(sessionId);

    ai.setModel(model);
    const response = await ai.chat(messages);

    // Добавляем ответ ассистента в историю
    sessionManager.addAssistantMessage(sessionId, response.content);

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
app.post('/chat/clear', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId обязателен" });
    }
    sessionManager.clearSession(sessionId);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка при очистке сессии" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
