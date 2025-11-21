import { InferenceClient } from "@huggingface/inference";
import type { ChatMessage } from "../chat-session.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { AIProviderInterface, ChatResult } from "./ai-provider.ts";

function convertMcpToolsToHfTools(mcpTools: any[]) {
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

export class HuggingFaceProvider implements AIProviderInterface {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(
    messages: ChatMessage[],
    tools: any[],
    getClientForTool: (toolName: string) => McpClient | null
  ): Promise<ChatResult> {
    const hf = new InferenceClient(this.apiKey);
    
    console.log("HUGGINGFACE PROVIDER");
    let currentMessages = [...messages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const maxToolCallIterations = 10;
    let iterations = 0;

    const callChatWithToolCalls = async () => {
        return await hf.chatCompletion({
        model: this.model,
        messages: currentMessages.map(msg => {
          const base: any = {
            role: msg.role,
            content: msg.content,
          };
          
          if (msg.tool_calls) {
            base.tool_calls = msg.tool_calls;
          }
          
          if (msg.tool_call_id) {
            base.tool_call_id = msg.tool_call_id;
          }
          
          return base;
        }),
        tools: tools.length > 0 ? convertMcpToolsToHfTools(tools) : undefined,
      });
    }

    try {
      console.log(`[Initial Request] HuggingFace: Sending with ${currentMessages.length} messages and ${tools.length} available tools`);
      
      let result = await callChatWithToolCalls()

      let message = result.choices[0]?.message;
      if (!message) {
        throw new Error("No message in response");
      }

      let inputTokens = (result as any).usage?.prompt_tokens ?? 
                       (result as any).usage?.input_tokens ?? 0;
      let outputTokens = (result as any).usage?.completion_tokens ?? 
                        (result as any).usage?.generated_tokens ?? 0;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // Цикл tool chaining для HuggingFace
      let hasToolCalls = true;
      let toolCalls = (message as any).tool_calls;
      while (hasToolCalls && iterations < maxToolCallIterations) {
        iterations++;
        console.log(`=== HuggingFace Tool Call Chain Iteration ${iterations} ===`);

        // Проверяем наличие tool calls (формат может отличаться)

        if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
          hasToolCalls = false;
          break;
        }

        // Добавляем сообщение ассистента с tool calls
        currentMessages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: toolCalls.map((tc: any) => ({
            id: tc.id || `call_${Date.now()}_${Math.random()}`,
            type: tc.type || "function",
            function: {
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
            },
          })),
        });


        // Вызываем каждый инструмент последовательно
        for (const toolCall of toolCalls) {
          try {
            const toolName = toolCall.function?.name || toolCall.name;
            const toolArgs = typeof toolCall.function?.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : (toolCall.function?.arguments || toolCall.arguments || {});

            console.log(`[Tool Call] ${toolName}`, JSON.stringify(toolArgs, null, 2));

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
              const structured = JSON.stringify(toolResult.structuredContent, null, 2);
              content = `${content}\n\n[Structured Data]\n${structured}`;
            }

            // Если контент пустой, используем structuredContent
            if (!content && toolResult.structuredContent) {
              content = JSON.stringify(toolResult.structuredContent, null, 2);
            }

            console.log(`[Tool Result] ${toolName} - Content length: ${content.length} chars`);

            currentMessages.push({
              role: "tool",
              content: content || "No content returned",
              tool_call_id: toolCall.id || `call_${Date.now()}_${Math.random()}`,
            });

            console.log("MESSAGES", currentMessages)
            result = await callChatWithToolCalls();

            console.log("RESULT", result)
           
            toolCalls = (message as any).tool_calls;
            // Обновляем toolCalls
            currentMessages.push({
              role: "assistant",
              content: message.content ?? "",
              tool_calls: toolCalls.map((tc: any) => ({
                id: tc.id || `call_${Date.now()}_${Math.random()}`,
                type: tc.type || "function",
              })),
            });
            
          } catch (error) {
            console.error(`[Tool Error] ${toolCall.function?.name || toolCall.name}:`, error);
            currentMessages.push({
              role: "tool",
              content: `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
              tool_call_id: toolCall.id || `call_${Date.now()}_${Math.random()}`,
            });
          }
        }

        console.log(`Sending follow-up request with ${currentMessages.length} messages`);
        
        // Отправляем follow-up запрос
        result = await hf.chatCompletion({
          model: this.model,
          messages: currentMessages.map(msg => {
            const base: any = {
              role: msg.role,
              content: msg.content,
            };
            
            if (msg.tool_calls) {
              base.tool_calls = msg.tool_calls;
            }
            
            if (msg.tool_call_id) {
              base.tool_call_id = msg.tool_call_id;
            }
            
            return base;
          }),
          tools: tools.length > 0 ? convertMcpToolsToHfTools(tools) : undefined,
        });

        message = result.choices[0]?.message;
        if (!message) {
          hasToolCalls = false;
          break;
        }

        inputTokens = (result as any).usage?.prompt_tokens ?? 
                     (result as any).usage?.input_tokens ?? 0;
        outputTokens = (result as any).usage?.completion_tokens ?? 
                      (result as any).usage?.generated_tokens ?? 0;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;

        // Проверяем, есть ли еще tool calls для следующей итерации
        const nextToolCalls = (message as any).tool_calls;
        if (!nextToolCalls || !Array.isArray(nextToolCalls) || nextToolCalls.length === 0) {
          hasToolCalls = false;
        }
      }

      // Проверяем, не достигли ли максимума итераций
      if (iterations >= maxToolCallIterations) {
        console.log(`WARNING: Reached maximum iterations (${maxToolCallIterations}) in tool call chain`);
      }

      // Получаем финальный ответ
      const finalContent = message?.content?.trim() || "Sorry, I couldn't generate a response.";

      console.log(`=== Final Response (HuggingFace) ===`);
      console.log(`Total iterations: ${iterations}`);
      console.log(`Final content length: ${finalContent.length}`);

      return {
        content: finalContent,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    } catch (e) {
      console.error(e);
      throw e;
    }
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

    const hf = new InferenceClient(this.apiKey);
    try {
      const result = await hf.chatCompletion({
        model: this.model,
        messages: summaryPrompt,
        max_tokens: 256,
        temperature: 0.2,
      });

      return result.choices[0]?.message?.content?.trim() ?? "";
    } catch (e) {
      console.error("Ошибка при сжатии истории чата:", e);
      throw e;
    }
  }
}

