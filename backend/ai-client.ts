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

  async chat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
    const { provider, model, apiKey } = this.config;

    if (provider === "openai") {
      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model,
        messages
      });
      return completion.choices[0].message.content ?? "";
    }

    if (provider === "huggingface") {
      const hf = new InferenceClient(apiKey);
      try {
        const result = await hf.chatCompletion({
          model,
          messages,
          max_tokens: 200
        });
        return result.choices[0]?.message?.content ?? "";
      } catch (e) {
        console.error(e);
      }

    }

    throw new Error("Unknown provider");
  }
}
