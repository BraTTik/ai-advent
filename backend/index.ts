import express from 'express';
import cors from 'cors';
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GigaChat } from "gigachat";

process.env.NODE_EXTRA_CA_CERTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../russian_cert/russiantrustedca2024.pem');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

const API_KEY = process.env.API_KEY;
const scope = 'GIGACHAT_API_PERS';

const ai = new GigaChat({
  credentials: API_KEY,
  scope,
  model: "GigaChat"
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
    const { prompt } = req.body;

    // 1. Мета-агент планирует экспертов
    const plannerPrompt = `
    Ты - координатор совета экспертов. 
    Тебе дают логическую задачу.

    1) Определи, какие эксперты нужны для обсуждения (от 1 до 6).
    2) Описывай экспертов нестандартно, можно смешно, можно абсурдно, но чтобы роли были понятны.
    3) Не решай задачу сам.

    Верни EДИНСТВЕННЫЙ валидный JSON:
    {
      "experts": [
        { "id": "string", "role": "string", "description": "string" }
      ]
    }
    `;

    const planResponse = await ai.chat({
      messages: [
        { role: "system", content: plannerPrompt },
        { role: "user", content: prompt }
      ]
    });

    const plan = JSON.parse(planResponse.choices[0].message.content as string);

    console.log(plan);
    // 2. Запускаем каждого эксперта
    const expertResults = [];
    for (const expert of plan.experts) {
      const expertPrompt = `
      Ты эксперт: ${expert.role}.
      Описание: ${expert.description}.
      Твоя задача — рассуждать и комментировать решение задачи.
      Не давай итогового ответа, только свои мысли.
      Верни просто текст размышлений.
      `;

      const expertResponse = await ai.chat({
        messages: [
          { role: "system", content: expertPrompt },
          { role: "user", content: prompt }
        ]
      });

      expertResults.push({
        id: expert.id,
        role: expert.role,
        content: expertResponse.choices[0].message.content
      });
    }

    // 3. Финальный агент — собирает вывод
    const finalPrompt = `
    Ты получаешь рассуждения экспертов.
    Проанализируй их и сделай итоговое решение задачи.
    `;

    const finalResponse = await ai.chat({
      messages: [
        { role: "system", content: finalPrompt },
        { role: "user", content: JSON.stringify(expertResults) }
      ]
    });


    const final = { experts: expertResults, result: finalResponse.choices[0].message.content }
    console.log(final)
    res.json(final);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка при обработке запроса" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
