const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const input = document.getElementById('chat-input') as HTMLInputElement;
const messages = document.getElementById('messages') as HTMLDivElement;

type Expert = {
  id: string;
  role: string
  content: string;
}

type Reply = {
  experts: Expert[];
  result: string;
}


async function askAI(prompt: string): Promise<Reply> {
  const response = await fetch(`http://localhost:3000/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
    })
  })

  const data = await response.json() as Reply;

  console.log(data);
  return data;
}

function formatReply(reply: Reply) {
  let text = ``;

  for (const expert of reply.experts) {
    text += `
    <div>
      <div>
       <strong>${expert.role}: </strong>
      </div>
      <p>
        ${expert.content}
      </p>
    </div>
    <br />
    `
  }

  text += `
   <div>
      <div>
       <strong>Решение: </strong>
      </div>
      <p>
        ${reply.result}
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
