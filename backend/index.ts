import express from 'express';
import cors from 'cors';
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { AIClient } from "./ai-client.ts";

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
    const { prompt, model = "moonshotai/Kimi-K2-Thinking:novita" } = req.body;

    // 1. Мета-агент планирует экспертов
    const plannerPrompt = `
      Ты личный помощник. Отвечай на русском языке.
    `;

    ai.setModel(model);
    const response = await ai.chat([
        { role: "system", content: plannerPrompt },
        { role: "user", content: prompt }
      ]
    );

    res.json({ chat: response, model });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка при обработке запроса" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
