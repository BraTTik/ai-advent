import OpenAI from "openai";
import { InferenceClient } from "@huggingface/inference";

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

  async chat(messages: { role: "system" | "user" | "assistant"; content: string }[]): Promise<{
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
}
