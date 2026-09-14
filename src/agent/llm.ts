import { config, requireApiKey } from "../config";
import type { ToolCall, ToolSchema } from "../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: ChatUsage;
  finishReason?: string;
}

/**
 * The model boundary. Swapping DeepSeek for another OpenAI-compatible provider
 * (or a local model) means implementing this interface only.
 */
export interface LlmClient {
  chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatResponse>;
}

export interface LlmClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

interface WireResponse {
  choices?: Array<{
    message?: ChatMessage;
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatibleClient implements LlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatResponse> {
    const endpoint = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const body = {
      model: this.options.model,
      messages: messages.map(toWireMessage),
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      temperature: this.options.temperature ?? 0,
      max_tokens: this.options.maxTokens ?? 4096,
      stream: false,
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status} ${response.statusText}): ${text.slice(0, 600)}`);
    }

    let data: WireResponse;
    try {
      data = JSON.parse(text) as WireResponse;
    } catch {
      throw new Error(`LLM returned a non-JSON response: ${text.slice(0, 400)}`);
    }

    if (data.error?.message) throw new Error(`LLM error: ${data.error.message}`);

    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error(`LLM returned no message: ${text.slice(0, 400)}`);

    const message: ChatMessage = {
      role: "assistant",
      content: choice.message.content ?? "",
    };
    if (choice.message.tool_calls?.length) message.tool_calls = choice.message.tool_calls;

    return {
      message,
      finishReason: choice.finish_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}

/** Drop fields the API rejects (e.g. `name` on non-tool messages). */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content ?? "",
      tool_call_id: message.tool_call_id,
    };
  }

  if (message.role === "assistant") {
    const wire: Record<string, unknown> = { role: "assistant", content: message.content ?? "" };
    if (message.tool_calls?.length) wire.tool_calls = message.tool_calls;
    return wire;
  }

  return { role: message.role, content: message.content ?? "" };
}

export function createLlmClient(overrides: Partial<LlmClientOptions> = {}): LlmClient {
  return new OpenAICompatibleClient({
    apiKey: requireApiKey(),
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
    ...overrides,
  });
}
