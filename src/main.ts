import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true
});
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLInputElement;
const messages = document.getElementById('messages') as HTMLDivElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const clearSessionBtn = document.getElementById('clear-session-btn') as HTMLButtonElement;

type Reply = {
  model: string;
  chat: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
}

// Генерируем sessionId при загрузке страницы или получаем из localStorage
let currentSessionId = localStorage.getItem('chatSessionId') || 
  `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
localStorage.setItem('chatSessionId', currentSessionId);


const modelList = ["Qwen/Qwen2.5-7B-Instruct:together"]

modelList.forEach(m => {
  const opt = document.createElement("option");
  opt.value = m;
  opt.textContent = m;
  modelSelect.appendChild(opt);
});

async function askAI(prompt: string): Promise<Reply> {
  const response = await fetch(`http://localhost:3000/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      model: modelSelect.value,
      sessionId: currentSessionId
    })
  })

  const data = await response.json() as Reply;
  
  // Обновляем sessionId если сервер вернул новый
  if (data.sessionId) {
    currentSessionId = data.sessionId;
    localStorage.setItem('chatSessionId', currentSessionId);
  }

  return data;
}

function formatReply(reply: Reply) {
  const markdownHtml = marked.parse(reply.chat, { async: false }) as string;

  return `
   <div class="ai-reply">
      <div class="ai-reply__header">
       <strong>${reply.model}: </strong>
      </div>
      <div class="ai-reply__content">
        ${markdownHtml}
      </div>

      <p class="ai-reply__meta" style="text-align:right;">
        <small>Входные токены: ${reply.inputTokens}</small><br />
        <small>Выходные токены: ${reply.outputTokens}</small><br />
      </p>
   </div>
  `;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userMsg = input.value.trim();
  if (!userMsg) return;

  appendMessage('🧑‍💻', userMsg);
  input.value = '';

  const aiReply = await askAI(userMsg);


  appendMessage('🤖', formatReply(aiReply), true);
});

function appendMessage(sender: string, text: string, isHtml: boolean = false) {
  const msg = document.createElement('div');
  msg.className = 'message';

  if (isHtml) {
    msg.innerHTML = DOMPurify.sanitize(`${sender} ${text}`);
  } else {
    msg.textContent = `${sender} ${text}`;
  }

  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

// Функция для очистки сессии
async function clearSession() {
  try {
    await fetch(`http://localhost:3000/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId })
    });
    
    // Генерируем новый sessionId
    currentSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    localStorage.setItem('chatSessionId', currentSessionId);
    
    // Очищаем сообщения на экране
    messages.innerHTML = '';
  } catch (e) {
    console.error('Ошибка при очистке сессии:', e);
  }
}

clearSessionBtn.addEventListener('click', clearSession);


