const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLInputElement;
const messages = document.getElementById('messages') as HTMLDivElement;

type Reply = {
  level: number;
  speech: string;
}

function setMoodLevel(level: number) {
  const bar = document.getElementById("mood-bar");
  if (!bar) return;
  bar.style.height = level + "%";
}


async function askAI(prompt: string): Promise<string> {
  const response = await fetch(`http://localhost:3000/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
    })
  })

  const data = await response.json();

  return data.reply;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userMsg = input.value.trim();
  if (!userMsg) return;

  appendMessage('🧑‍💻', userMsg);
  input.value = '';

  const aiReply = await askAI(userMsg);
  console.log(aiReply);
  const reply = JSON.parse(aiReply) as Reply;
  setMoodLevel(reply.level)
  appendMessage('🤖', reply.speech);
});

function appendMessage(sender: string, text: string) {
  const msg = document.createElement('div');
  msg.className = 'message';
  msg.textContent = `${sender} ${text}`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}
