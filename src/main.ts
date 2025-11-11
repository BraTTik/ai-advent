const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLInputElement;
const messages = document.getElementById('messages') as HTMLDivElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;

type Reply = {
  model: string;
  chat: string;
}


const modelList = ["MiniMaxAI/MiniMax-M2:novita", "meta-llama/Llama-3.1-8B-Instruct:novita", "HuggingFaceTB/SmolLM3-3B:hf-inference"]

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
      model: modelSelect.value
    })
  })

  const data = await response.json() as Reply;

  return data;
}

function formatReply(reply: Reply) {
  let text = "";

  text += `
   <div>
      <div>
       <strong>${reply.model}: </strong>
      </div>
      <p>
        ${reply.chat}
      </p>
   </div>
  `
  return text;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userMsg = input.value.trim();
  if (!userMsg) return;

  appendMessage('🧑‍💻', userMsg);
  input.value = '';

  const aiReply = await askAI(userMsg);


  appendMessage('🤖', formatReply(aiReply));
});

function appendMessage(sender: string, text: string) {
  const msg = document.createElement('div');
  msg.className = 'message';
  msg.innerHTML = `${sender} ${text}`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}


