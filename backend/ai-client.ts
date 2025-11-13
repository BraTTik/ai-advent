import OpenAI from "openai";
import { InferenceClient } from "@huggingface/inference";
import type { ChatMessage } from "./chat-session.ts";

export type AIProvider = "openai" | "huggingface";

interface AIClientConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

export class AIClient {
  private config: AIClientConfig;

  constructor(config: AIClientConfig) {
    this.config = config;
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

    if (provider === "openai") {
      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model,
        messages
      });
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
        temperature: 0.2
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
          temperature: 0.2
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
