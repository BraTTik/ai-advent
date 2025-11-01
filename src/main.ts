const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLInputElement;
const messages = document.getElementById('messages') as HTMLDivElement;

// имитация ответа ИИ
async function askAI(prompt: string): Promise<string> {
  // тут можно подключить реальный API (fetch к своему backend)
  await new Promise(r => setTimeout(r, 500)); // имитация задержки
  return `🤖 Ответ ИИ на: "${prompt}"`;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userMsg = input.value.trim();
  if (!userMsg) return;

  appendMessage('🧑‍💻', userMsg);
  input.value = '';

  const aiReply = await askAI(userMsg);
  appendMessage('🤖', aiReply);
});

function appendMessage(sender: string, text: string) {
  const msg = document.createElement('div');
  msg.className = 'message';
  msg.textContent = `${sender} ${text}`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}
