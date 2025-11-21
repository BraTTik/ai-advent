import OpenAI from "openai";
import type { ChatMessage } from "../chat-session.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { AIProviderInterface, ChatResult } from "./ai-provider.ts";

function convertChatMessageToOpenAI(msg: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === "system") {
    return {
      role: "system",
      content: msg.content,
    };
  }
  
  if (msg.role === "user") {
    return {
      role: "user",
      content: msg.content,
    };
  }
  
  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      tool_call_id: msg.tool_call_id!,
    };
  }
  
  // assistant
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
  }
  
  return {
    role: "assistant",
    content: msg.content,
  };
}

function convertMcpToolsToOpenAITools(mcpTools: any[]): any[] {
  return mcpTools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {}
      }
    }
  }));
}

export class OpenAIProvider implements AIProviderInterface {
  private apiKey: string;
  private model: string;
  private baseURL?: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = baseURL;
  }

  async chat(
    messages: ChatMessage[],
    tools: any[],
    getClientForTool: (toolName: string) => McpClient | null
  ): Promise<ChatResult> {
    const openai = new OpenAI({ 
      apiKey: this.apiKey, 
      baseURL: this.baseURL || "https://router.huggingface.co/v1",
    });

    let currentMessages = [...messages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const maxToolCallIterations = 10;
    let iterations = 0;

    console.log(`[Initial Request] Sending with ${currentMessages.length} messages and ${tools.length} available tools`);

    const callChatWithToolCalls = async () => {
      return await openai.chat.completions.create({
        model: this.model,
        messages: currentMessages.map(convertChatMessageToOpenAI),
        tools: tools.length > 0 ? convertMcpToolsToOpenAITools(tools) : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
      });
    }

    let response = await callChatWithToolCalls();

    console.log("RESPONSE", response);

    totalInputTokens += response.usage?.prompt_tokens ?? 0;
    totalOutputTokens += response.usage?.completion_tokens ?? 0;

    const finishReason = response.choices[0]?.finish_reason;
    console.log(`[Initial Response] finish_reason: ${finishReason}`);

    // Если finish_reason не "tool_calls", возвращаем ответ сразу
    if (finishReason !== "tool_calls") {
      const finalContent = response.choices[0].message.content?.trim() || "Sorry, I couldn't generate a response.";
      return {
        content: finalContent,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    }

    // Цикл tool chaining: продолжаем пока finish_reason === "tool_calls"
    let currentFinishReason: string | null = finishReason || null;
    let assistantMessage = response.choices[0].message;
    let toolCalls = assistantMessage.tool_calls || [];
    while (currentFinishReason === "tool_calls" && iterations < maxToolCallIterations) {
      iterations++;
      console.log(`=== Tool Call Chain Iteration ${iterations} ===`);


      
      // Проверяем наличие tool calls
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // Нет tool calls - выходим из цикла
        currentFinishReason = null;
        break;
      }
      
      // Добавляем сообщение ассистента с tool calls в историю
      const toolCallsForMessage = assistantMessage.tool_calls
          .filter((tc) => tc.type === "function" && "function" in tc)
          .map((tc) => {
            const toolCall = tc as any as { 
              id: string; 
              type: "function"; 
              function: { name: string; arguments: string | object } 
            };
            const func = toolCall.function;
            return {
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: func.name,
                arguments: typeof func.arguments === "string" 
                  ? func.arguments 
                  : JSON.stringify(func.arguments),
              },
            };
          });

      currentMessages.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: toolCallsForMessage,
      });

      console.log(`Processing ${toolCalls.length} tool call(s)`);

      // Выполняем все tool calls последовательно
      for (const toolCall of toolCalls) {
          // Проверяем, что это function tool call
          if (toolCall.type !== "function" || !("function" in toolCall)) {
            continue;
          }

          try {
            const toolName = toolCall.function.name;
            const argumentsStr = typeof toolCall.function.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments);
            
            const toolArgs = typeof toolCall.function.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;

            console.log(`  Calling tool: ${toolName}`);
            console.log(`  Arguments: ${argumentsStr}`);

            // Находим клиент для этого инструмента
            const client = getClientForTool(toolName);
            if (!client) {
              throw new Error(`Tool "${toolName}" is not registered in any MCP server`);
            }

            const toolResult = await client.callTool({
              name: toolName,
              arguments: toolArgs,
            }) as CallToolResult;

            // Формируем текстовый ответ из результата
            let content = Array.isArray(toolResult.content)
              ? toolResult.content
                  .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
                  .filter(Boolean)
                  .join("\n")
              : "";


            // Специальная обработка для find_files - добавляем подсказку о следующем шаге
            if (toolName === "find_files" && toolResult.structuredContent) {
              const structured = toolResult.structuredContent as any;
              if (structured.items && Array.isArray(structured.items)) {
                const files = structured.items.filter((item: any) => item.type === "file");
                if (files.length > 0) {
                  const filePaths = files.map((f: any) => f.path).join(", ");
                  content = `${content}\n\nНайдено ${files.length} файл(ов). Для чтения содержимого используйте инструмент read_file с параметром filePath. Примеры путей: ${filePaths}`;
                }
              }
            }

            // Если есть structuredContent, добавляем его в более читаемом формате
            if (toolResult.structuredContent && !content) {
              content = JSON.stringify(toolResult.structuredContent, null, 2);
            } else if (toolResult.structuredContent && content && toolName !== "find_files") {
              // Добавляем structuredContent как дополнительную информацию (кроме find_files, там уже обработано)
              const structured = JSON.stringify(toolResult.structuredContent, null, 2);
              content = `${content}\n\n[Structured Data]\n${structured}`;
            }

            // Если контент пустой, используем structuredContent
            if (!content && toolResult.structuredContent) {
              content = JSON.stringify(toolResult.structuredContent, null, 2);
            }

            console.log(`[Tool Result] ${toolName} - Content length: ${content.length} chars`);

            // Добавляем результат вызова инструмента
            currentMessages.push({
              role: "tool",
              content: content || "No content returned",
              tool_call_id: toolCall.id,
            });
            console.log("content", content)
            // Вызываем API после каждого tool call для получения новых tool calls, если они нужны
            console.log(`Sending follow-up request after tool call with ${currentMessages.length} messages`);
            response = await callChatWithToolCalls();
            currentMessages.push({
                role: "assistant",
                content: response.choices[0].message.content ?? "",
                tool_call_id: toolCall.id,
            });
            response = await callChatWithToolCalls();

            console.log("RESPONSE", response.choices[0].message.tool_calls)
            console.log("ROLE", response.choices[0].message.role)
            console.log("CONTENT", response.choices[0].message.content)

            totalInputTokens += response.usage?.prompt_tokens ?? 0;
            totalOutputTokens += response.usage?.completion_tokens ?? 0;

            currentFinishReason = response.choices[0]?.finish_reason;
            console.log(`Follow-up response finish_reason: ${currentFinishReason}`);

            // Обновляем toolCalls из нового ответа для следующей итерации
            const newAssistantMessage = response.choices[0].message;
            if (newAssistantMessage.tool_calls && newAssistantMessage.tool_calls.length > 0) {
              // Добавляем новое сообщение ассистента с tool calls
              const newToolCallsForMessage = newAssistantMessage.tool_calls
                .filter((tc) => tc.type === "function" && "function" in tc)
                .map((tc) => {
                  const toolCall = tc as any as { 
                    id: string; 
                    type: "function"; 
                    function: { name: string; arguments: string | object } 
                  };
                  const func = toolCall.function;
                  return {
                    id: toolCall.id,
                    type: "function" as const,
                    function: {
                      name: func.name,
                      arguments: typeof func.arguments === "string" 
                        ? func.arguments 
                        : JSON.stringify(func.arguments),
                    },
                  };
                });

              currentMessages.push({
                role: "assistant",
                content: newAssistantMessage.content ?? "",
                tool_calls: newToolCallsForMessage,
              });

              assistantMessage = response.choices[0].message;
              toolCalls = newAssistantMessage.tool_calls || [];
            } else {
              // Нет новых tool calls - выходим из обоих циклов
              currentFinishReason = null;
              break;
            }
          } catch (error) {
            console.error(`[Tool Error] ${toolCall.function.name}:`, error);
            // Добавляем сообщение об ошибке
            currentMessages.push({
              role: "tool",
              content: `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
              tool_call_id: toolCall.id,
            });
          }
      }

      // Если после обработки всех tool calls finish_reason не "tool_calls", выходим из while цикла
      if (currentFinishReason !== "tool_calls") {
        break;
      }
    }

      // Проверяем, не достигли ли максимума итераций
      if (iterations >= maxToolCallIterations) {
        console.log(`WARNING: Reached maximum iterations (${maxToolCallIterations}) in tool call chain`);
      }

      // Получаем финальный ответ (после выхода из цикла)
      const finalMessage = response.choices[0]?.message;
      const finalContent = finalMessage?.content?.trim() || "Sorry, I couldn't generate a response.";

      console.log(`=== Final Response ===`);
      console.log(`Total iterations: ${iterations}`);
      console.log(`Final content length: ${finalContent.length}`);

      return {
        content: finalContent,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
  }

  async summarizeConversation(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) {
      return "";
    }

    const conversationText = messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");

    const summaryPrompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "Ты — помощник, который сжимает историю диалога в краткое резюме. Сохрани ключевые факты, действующих лиц и договорённости. Ответь на русском языке, не упоминай, что это резюме."
      },
      {
        role: "user",
        content: `Суммаризируй следующий диалог:\n\n${conversationText}`
      }
    ];

    const openai = new OpenAI({ apiKey: this.apiKey });
    const completion = await openai.chat.completions.create({
      model: this.model,
      messages: summaryPrompt.map(convertChatMessageToOpenAI),
      max_tokens: 256,
      temperature: 0,
    });

    return completion.choices[0].message.content?.trim() ?? "";
  }
}

