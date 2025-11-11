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
    const { prompt, temperature = 0.7 } = req.body;

    const finalPrompt = `
     Ты личный помощник.
    `;

    const finalResponse = await ai.chat({
      temperature,
      messages: [
        { role: "system", content: finalPrompt },
        { role: "user", content: prompt },
      ]
    });


    const final = { result: finalResponse.choices[0].message.content }
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
