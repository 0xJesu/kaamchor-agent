// Neurons per million tokens. Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
// native = supports `tools` param on Workers AI (verified in model docs, Nov 2026).
export const MODELS: Record<string, { in: number; out: number; native: boolean }> = {
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 4625, out: 30475, native: true },
  "@cf/zai-org/glm-4.7-flash": { in: 5500, out: 36400, native: true },
  "@cf/google/gemma-4-26b-a4b-it": { in: 9091, out: 27273, native: true },
  "@cf/openai/gpt-oss-20b": { in: 18182, out: 27273, native: true },
  "@cf/openai/gpt-oss-120b": { in: 31818, out: 68182, native: true },
  "@cf/qwen/qwen2.5-coder-32b-instruct": { in: 60000, out: 90909, native: false },
};
const DEFAULT = { in: 18182, out: 30475, native: false }; // unknown model: assume pricey, JSON protocol
export const modelInfo = (id: string) => MODELS[id] ?? DEFAULT;
export const neuronCost = (id: string, inTok: number, outTok: number, factor: number) =>
  ((inTok * modelInfo(id).in + outTok * modelInfo(id).out) / 1e6) * factor;
