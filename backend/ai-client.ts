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

interface AIClientConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
  weatherMcpUrl?: string;
  weatherToolName?: string;
  remindesMcpUrl?: string;
}

export class AIClient {
  private config: AIClientConfig;
  private weatherMcpUrl?: string;
  private weatherToolName: string;
  private weatherClient?: McpClient;
  private weatherTransport?: StreamableHTTPClientTransport;

  constructor(config: AIClientConfig) {
    this.config = config;
    this.weatherMcpUrl = config.weatherMcpUrl ?? process.env.WEATHER_MCP_URL;
    this.weatherToolName = config.weatherToolName ?? "current_weather";
  }

  setProvider(provider: AIProvider) {
    this.config.provider = provider;
  }

  setModel(model: string) {
    this.config.model = model;
  }

  async chat(messages: ChatMessage[]): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const { provider, model, apiKey } = this.config;


    const weatherClient = await this.ensureWeatherClient();
    const weatherTools = await weatherClient.listTools();


    if (provider === "openai") {
      const openai = new OpenAI({ apiKey,   baseURL: "https://router.huggingface.co/v1", });
      const completion = await openai.chat.completions.create({
        model,
        messages,
        tools: convertMcpToolsToOpenAITools(weatherTools.tools),
        tool_choice: "auto",
      });
      console.log(completion.choices[0].message.tool_calls)
      return {
        content: completion.choices[0].message.content ?? "",
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0
      };
    }

    if (provider === "huggingface") {
      const hf = new InferenceClient(apiKey);
      try {
        const result = await hf.chatCompletion({
          model,
          messages,
          tools: convertMcpToolsToHfTools(weatherTools.tools)
        });
        // HuggingFace может возвращать информацию о токенах в разных форматах
        // Проверяем наличие usage или других полей
        const inputTokens = (result as any).usage?.prompt_tokens ?? 
                           (result as any).usage?.input_tokens ?? 0;
        const outputTokens = (result as any).usage?.completion_tokens ?? 
                            (result as any).usage?.generated_tokens ?? 0;
        
        return {
          content: result.choices[0]?.message?.content ?? "",
          inputTokens,
          outputTokens
        };
      } catch (e) {
        console.error(e);
        throw e;
      }
    }

    throw new Error("Unknown provider");
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
        messages: summaryPrompt,
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

  private async ensureWeatherClient(): Promise<McpClient> {
    if (!this.weatherMcpUrl) {
      throw new Error("Weather MCP URL is not configured");
    }

    if (this.weatherClient) {
      return this.weatherClient;
    }

    const transport = new StreamableHTTPClientTransport(new URL(this.weatherMcpUrl));
    const client = new McpClient({
      name: "ai-weather-client",
      version: "1.0.0",
    });
    await client.connect(transport);

    this.weatherClient = client;
    this.weatherTransport = transport;
    return client;
  }

  async getWeather(location: string): Promise<{
    summary: string;
    structured?: CallToolResult["structuredContent"];
  }> {
    if (!location.trim()) {
      throw new Error("Location is required");
    }

    const client = await this.ensureWeatherClient();
    const result = (await client.callTool({
      name: this.weatherToolName,
      arguments: { location },
    })) as CallToolResult;

    const content = Array.isArray(result.content) ? result.content : [];

    const summary = content
      .map((chunk) => {
        if (chunk.type === "text") {
          return chunk.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    return {
      summary,
      structured: result.structuredContent ?? undefined,
    };
  }
}
