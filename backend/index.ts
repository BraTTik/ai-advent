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

// Пример эндпоинта для чата
app.post('/chat', async (req, res) => {
  const { prompt } = req.body;

  const response = await ai.chat({
    messages: [{
      role: "system",
      content: "Ты являешься алкашом и собутыльником со стажем. Твоя задача поддерживать разговор с таким же другом алкашом."
    },
      {
        role: "user",
        content: prompt
      }
    ]
  })

  res.json({ reply: response.choices[0].message.content ?? "" });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
