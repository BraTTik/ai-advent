import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatMessage } from "./chat-session.ts";
import { OpenAIProvider } from "./providers/openai-provider.ts";
import { HuggingFaceProvider } from "./providers/huggingface-provider.ts";
import type { AIProviderInterface } from "./providers/ai-provider.ts";

export type AIProvider = "openai" | "huggingface";

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
  private providerInstance: AIProviderInterface | null = null;

  constructor(config: AIClientConfig) {
    this.config = config;
    this.updateProviderInstance();
  }

  setProvider(provider: AIProvider) {
    this.config.provider = provider;
    this.updateProviderInstance();
  }

  setModel(model: string) {
    this.config.model = model;
    this.updateProviderInstance();
  }

  /**
   * Создает или обновляет экземпляр провайдера на основе текущей конфигурации
   */
  private updateProviderInstance(): void {
    const { provider, model, apiKey } = this.config;

    if (provider === "openai") {
      this.providerInstance = new OpenAIProvider(
        apiKey,
        model,
        "https://router.huggingface.co/v1"
      );
    } else if (provider === "huggingface") {
      this.providerInstance = new HuggingFaceProvider(apiKey, model);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
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
    if (!this.providerInstance) {
      throw new Error("Provider instance is not initialized");
    }

    // Получаем все инструменты со всех зарегистрированных MCP серверов
    const allTools = await this.getAllTools();

    if (allTools.length === 0) {
      console.warn("No MCP tools available. Make sure to register MCP servers using registerMCP()");
    }

    // Используем провайдер для выполнения чата
    return await this.providerInstance.chat(
      messages,
      allTools,
      (toolName: string) => this.getClientForTool(toolName)
    );
  }

  async summarizeConversation(messages: ChatMessage[]): Promise<string> {
    if (!this.providerInstance) {
      throw new Error("Provider instance is not initialized");
    }

    return await this.providerInstance.summarizeConversation(messages);
  }
}
