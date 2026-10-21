/**
 * The environment variable eve reads each model connection's API key from.
 * The host sandbox strips every one of these from commands, so keep new model
 * credentials here.
 */
export const MODEL_API_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "ai-gateway-key": "AI_GATEWAY_API_KEY",
} as const;
