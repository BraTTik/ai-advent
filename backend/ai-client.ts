import OpenAI from "openai";
import { InferenceClient } from "@huggingface/inference";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChatMessage } from "./chat-session.ts";

export type AIProvider = "openai" | "huggingface";

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

interface AIClientConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

export interface McpServerConfig {
  url: string;
  name?: string;
}

interface McpServerEntry {
  client: McpClient;
  transport: StreamableHTTPClientTransport;
  name: string;
  url: string;
}

export class AIClient {
  private config: AIClientConfig;
  private mcpServers: Map<string, McpServerEntry> = new Map();
  private toolToServerMap: Map<string, string> = new Map(); // tool name -> server name

  constructor(config: AIClientConfig) {
    this.config = config;
  }

  setProvider(provider: AIProvider) {
    this.config.provider = provider;
  }

  setModel(model: string) {
    this.config.model = model;
  }

  /**
   * Регистрирует MCP сервер и инициализирует подключение
   * @param config Конфигурация MCP сервера
   * @returns Promise, который разрешается после успешной регистрации
   */
  async registerMCP(config: McpServerConfig): Promise<void> {
    const serverName = config.name || `mcp-server-${this.mcpServers.size + 1}`;
    
    if (this.mcpServers.has(serverName)) {
      throw new Error(`MCP server with name "${serverName}" is already registered`);
    }

    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      const client = new McpClient({
        name: `ai-mcp-client-${serverName}`,
        version: "1.0.0",
      });
      
      await client.connect(transport);

      // Получаем список инструментов для создания маппинга
      const tools = await client.listTools();
      tools.tools.forEach(tool => {
        this.toolToServerMap.set(tool.name, serverName);
      });

      this.mcpServers.set(serverName, {
        client,
        transport,
        name: serverName,
        url: config.url,
      });

      console.log(`MCP server "${serverName}" registered successfully with ${tools.tools.length} tools`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to register MCP server "${serverName}": ${errorMessage}`);
    }
  }

  /**
   * Получает все инструменты со всех зарегистрированных MCP серверов
   * Обновляет маппинг инструментов к серверам
   */
  private async getAllTools(): Promise<any[]> {
    const allTools: any[] = [];
    
    // Очищаем старый маппинг и создаем новый
    this.toolToServerMap.clear();
    
    for (const [serverName, entry] of this.mcpServers.entries()) {
      try {
        const tools = await entry.client.listTools();
        tools.tools.forEach(tool => {
          this.toolToServerMap.set(tool.name, serverName);
        });
        allTools.push(...tools.tools);
      } catch (error) {
        console.error(`Failed to get tools from MCP server "${serverName}":`, error);
      }
    }
    
    return allTools;
  }

  /**
   * Находит MCP клиент для указанного инструмента
   */
  private getClientForTool(toolName: string): McpClient | null {
    const serverName = this.toolToServerMap.get(toolName);
    if (!serverName) {
      return null;
    }
    
    const entry = this.mcpServers.get(serverName);
    return entry?.client || null;
  }

  async chat(messages: ChatMessage[]): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const { provider, model, apiKey } = this.config;

    // Получаем все инструменты со всех зарегистрированных MCP серверов
    const allTools = await this.getAllTools();

    if (allTools.length === 0) {
      console.warn("No MCP tools available. Make sure to register MCP servers using registerMCP()");
    }

    let currentMessages = [...messages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const maxToolCallIterations = 10; // Защита от бесконечного цикла
    let iterations = 0;

    if (provider === "openai") {
      const openai = new OpenAI({ 
        apiKey, 
        baseURL: "https://router.huggingface.co/v1",
      });

      console.log(`[Initial Request] Sending with ${currentMessages.length} messages and ${allTools.length} available tools`);
      
      let response = await openai.chat.completions.create({
        model,
        messages: currentMessages.map(convertChatMessageToOpenAI),
        tools: allTools.length > 0 ? convertMcpToolsToOpenAITools(allTools) : undefined,
        tool_choice: allTools.length > 0 ? "auto" : undefined,
      });

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
      while (currentFinishReason === "tool_calls" && iterations < maxToolCallIterations) {
        iterations++;
        console.log(`=== Tool Call Chain Iteration ${iterations} ===`);

        const assistantMessage = response.choices[0].message;
        
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

        const toolCalls = assistantMessage.tool_calls || [];
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
              const client = this.getClientForTool(toolName);
              if (!client) {
                throw new Error(`Tool "${toolName}" is not registered in any MCP server`);
              }

              const result = await client.callTool({
                name: toolName,
                arguments: toolArgs,
              }) as CallToolResult;

              // Формируем текстовый ответ из результата
              let content = Array.isArray(result.content)
                ? result.content
                    .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
                    .filter(Boolean)
                    .join("\n")
                : "";


              // Специальная обработка для find_files - добавляем подсказку о следующем шаге
              if (toolName === "find_files" && result.structuredContent) {
                const structured = result.structuredContent as any;
                if (structured.items && Array.isArray(structured.items)) {
                  const files = structured.items.filter((item: any) => item.type === "file");
                  if (files.length > 0) {
                    const filePaths = files.map((f: any) => f.path).join(", ");
                    content = `${content}\n\nНайдено ${files.length} файл(ов). Для чтения содержимого используйте инструмент read_file с параметром filePath. Примеры путей: ${filePaths}`;
                  }
                }
              }

              // Если есть structuredContent, добавляем его в более читаемом формате
              if (result.structuredContent && !content) {
                content = JSON.stringify(result.structuredContent, null, 2);
              } else if (result.structuredContent && content && toolName !== "find_files") {
                // Добавляем structuredContent как дополнительную информацию (кроме find_files, там уже обработано)
                const structured = JSON.stringify(result.structuredContent, null, 2);
                content = `${content}\n\n[Structured Data]\n${structured}`;
              }

              // Если контент пустой, используем structuredContent
              if (!content && result.structuredContent) {
                content = JSON.stringify(result.structuredContent, null, 2);
              }

              console.log(`[Tool Result] ${toolName} - Content length: ${content.length} chars`);

              // Добавляем результат вызова инструмента
              currentMessages.push({
                role: "tool",
                content: content || "No content returned",
                tool_call_id: toolCall.id,
              });
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

        // Отправляем follow-up запрос с обновленной историей
        console.log(`Sending follow-up request with ${currentMessages.length} messages`);
        console.log(`Tools will be included: ${allTools.length > 0}`);
        
        response = await openai.chat.completions.create({
          model,
          messages: currentMessages.map(convertChatMessageToOpenAI),
          tools: allTools.length > 0 ? convertMcpToolsToOpenAITools(allTools) : undefined,
          tool_choice: allTools.length > 0 ? "auto" : undefined,
        });

        totalInputTokens += response.usage?.prompt_tokens ?? 0;
        totalOutputTokens += response.usage?.completion_tokens ?? 0;

        currentFinishReason = response.choices[0]?.finish_reason;
        console.log(`Follow-up response finish_reason: ${currentFinishReason}`);

        // Цикл продолжается автоматически, если currentFinishReason === "tool_calls"
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
    } else if (provider === "huggingface") {
        const hf = new InferenceClient(apiKey);
        try {
          console.log(`[Initial Request] HuggingFace: Sending with ${currentMessages.length} messages and ${allTools.length} available tools`);
          
          let result = await hf.chatCompletion({
            model,
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
            tools: allTools.length > 0 ? convertMcpToolsToHfTools(allTools) : undefined,
          });

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
          while (hasToolCalls && iterations < maxToolCallIterations) {
            iterations++;
            console.log(`=== HuggingFace Tool Call Chain Iteration ${iterations} ===`);

            // Проверяем наличие tool calls (формат может отличаться)
            const toolCalls = (message as any).tool_calls;
            if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
              hasToolCalls = false;
              break;
            }
            console.log(`[Iteration ${iterations}] HuggingFace: Processing ${toolCalls.length} tool call(s)`);
            
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
                const client = this.getClientForTool(toolName);
                if (!client) {
                  throw new Error(`Tool "${toolName}" is not registered in any MCP server`);
                }

                const result = await client.callTool({
                  name: toolName,
                  arguments: toolArgs,
                }) as CallToolResult;

                // Формируем текстовый ответ из результата
                let content = Array.isArray(result.content)
                  ? result.content
                      .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
                      .filter(Boolean)
                      .join("\n")
                  : "";

                // Специальная обработка для find_files - добавляем подсказку о следующем шаге
                if (toolName === "find_files" && result.structuredContent) {
                  const structured = result.structuredContent as any;
                  if (structured.items && Array.isArray(structured.items)) {
                    const files = structured.items.filter((item: any) => item.type === "file");
                    if (files.length > 0) {
                      const filePaths = files.map((f: any) => f.path).join(", ");
                      content = `${content}\n\nНайдено ${files.length} файл(ов). Для чтения содержимого используйте инструмент read_file с параметром filePath. Примеры путей: ${filePaths}`;
                    }
                  }
                }

                // Если есть structuredContent, добавляем его в более читаемом формате
                if (result.structuredContent && !content) {
                  content = JSON.stringify(result.structuredContent, null, 2);
                } else if (result.structuredContent && content && toolName !== "find_files") {
                  const structured = JSON.stringify(result.structuredContent, null, 2);
                  content = `${content}\n\n[Structured Data]\n${structured}`;
                }

                // Если контент пустой, используем structuredContent
                if (!content && result.structuredContent) {
                  content = JSON.stringify(result.structuredContent, null, 2);
                }

                console.log(`[Tool Result] ${toolName} - Content length: ${content.length} chars`);

                currentMessages.push({
                  role: "tool",
                  content: content || "No content returned",
                  tool_call_id: toolCall.id || `call_${Date.now()}_${Math.random()}`,
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
              model,
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
              tools: allTools.length > 0 ? convertMcpToolsToHfTools(allTools) : undefined,
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
      } else {
        throw new Error("Unknown provider");
      }
  }

  async summarizeConversation(messages: ChatMessage[]): Promise<string> {
    const { provider, model, apiKey } = this.config;

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

    if (provider === "openai") {
      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model,
        messages: summaryPrompt.map(convertChatMessageToOpenAI),
        max_tokens: 256,
        temperature: 0,
      });

      return completion.choices[0].message.content?.trim() ?? "";
    }

    if (provider === "huggingface") {
      const hf = new InferenceClient(apiKey);
      try {
        const result = await hf.chatCompletion({
          model,
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

    throw new Error("Unknown provider");
  }
}
