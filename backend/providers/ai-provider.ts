import type { ChatMessage } from "../chat-session.ts";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";

export interface ChatResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIProviderInterface {
  chat(
    messages: ChatMessage[],
    tools: any[],
    getClientForTool: (toolName: string) => McpClient | null
  ): Promise<ChatResult>;

  summarizeConversation(messages: ChatMessage[]): Promise<string>;
}

