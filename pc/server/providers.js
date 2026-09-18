/**
 * pc/server/providers.js
 * ------------------------------------------------------------
 * Provider catalogue + model resolution. Mirrors the mobile app's
 * provider families (see src/modules/providers in the app repo):
 * anthropic, openai, google, xai, openrouter, ollama and any
 * OpenAI-compatible endpoint (LM Studio, vLLM, …).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOllama } from "ollama-ai-provider-v2";

import { getConfig, getProviderApiKey } from "./store.js";

export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    family: "anthropic",
    requiresKey: true,
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    keyHint: "sk-ant-…",
    docs: "https://console.anthropic.com/settings/keys",
    suggestedModels: [
      "claude-sonnet-4-5",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-20250514",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    requiresKey: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.2",
    keyHint: "sk-…",
    docs: "https://platform.openai.com/api-keys",
    suggestedModels: ["gpt-5.2", "gpt-5.2-mini", "gpt-5.1", "o4-mini"],
  },
  {
    id: "google",
    label: "Google AI Studio",
    family: "google",
    requiresKey: true,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-pro",
    keyHint: "AIza…",
    docs: "https://aistudio.google.com/apikey",
    suggestedModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  {
    id: "xai",
    label: "xAI",
    family: "xai",
    requiresKey: true,
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    keyHint: "xai-…",
    docs: "https://console.x.ai",
    suggestedModels: ["grok-4", "grok-4-fast", "grok-3-mini"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "openaiCompatible",
    requiresKey: true,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    keyHint: "sk-or-…",
    docs: "https://openrouter.ai/keys",
    suggestedModels: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.2",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1",
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    family: "ollama",
    requiresKey: false,
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: null,
    docs: "https://ollama.com/download",
    suggestedModels: [],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    family: "openaiCompatible",
    requiresKey: false,
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: null,
    docs: "https://lmstudio.ai",
    suggestedModels: [],
  },
  {
    id: "custom",
    label: "OpenAI-compatible (custom)",
    family: "openaiCompatible",
    requiresKey: false,
    defaultBaseUrl: "",
    defaultModel: null,
    docs: "",
    suggestedModels: [],
  },
];

export function getProviderDef(providerId) {
  return PROVIDERS.find((p) => p.id === providerId) ?? null;
}

export function providerReady(providerId) {
  const def = getProviderDef(providerId);
  if (!def) return false;
  if (def.requiresKey && !getProviderApiKey(providerId)) return false;
  if (def.family === "openaiCompatible") {
    const baseUrl = getConfig().providers[providerId]?.baseUrl?.trim();
    return !!baseUrl;
  }
  return true;
}

/** List providers with readiness for the settings screen. */
export function describeProviders() {
  return PROVIDERS.map((def) => {
    const stored = getConfig().providers[def.id] ?? {};
    return {
      id: def.id,
      label: def.label,
      family: def.family,
      requiresKey: def.requiresKey,
      keyHint: def.keyHint ?? null,
      docs: def.docs || null,
      defaultBaseUrl: def.defaultBaseUrl,
      suggestedModels: def.suggestedModels,
      configured: providerReady(def.id),
      hasKey: !!stored.apiKey,
      baseUrl: stored.baseUrl ?? "",
    };
  });
}

/**
 * Resolve a provider id + model id into a LanguageModel for the AI SDK.
 * Follows the same construction patterns as the mobile app's
 * src/modules/runtime/model-runtime.ts.
 */
export function resolveModel(providerId, modelId) {
  const def = getProviderDef(providerId);
  if (!def) throw new Error(`Unknown provider "${providerId}".`);
  const stored = getConfig().providers[providerId] ?? {};
  const baseUrl = stored.baseUrl?.trim() || def.defaultBaseUrl;

  switch (def.family) {
    case "anthropic": {
      const apiKey = getProviderApiKey(providerId);
      if (!apiKey) throw new Error("Missing Anthropic API key. Add one in Settings → Providers.");
      const provider = createAnthropic({ apiKey, baseURL: baseUrl });
      return provider.languageModel(modelId);
    }
    case "google": {
      const apiKey = getProviderApiKey(providerId);
      if (!apiKey) throw new Error("Missing Google AI Studio API key. Add one in Settings → Providers.");
      const provider = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl });
      return provider.languageModel(modelId);
    }
    case "xai": {
      const apiKey = getProviderApiKey(providerId);
      if (!apiKey) throw new Error("Missing xAI API key. Add one in Settings → Providers.");
      const provider = createXai({ apiKey, baseURL: baseUrl });
      return provider.languageModel(modelId);
    }
    case "openai": {
      const apiKey = getProviderApiKey(providerId);
      if (!apiKey) throw new Error("Missing OpenAI API key. Add one in Settings → Providers.");
      const provider = createOpenAI({ apiKey, baseURL: baseUrl });
      return provider.chat(modelId);
    }
    case "ollama": {
      const ollamaBase = (baseUrl || "http://localhost:11434")
        .replace(/\/(?:api|v1)\/?$/, "")
        .replace(/\/$/, "");
      const provider = createOllama({ baseURL: `${ollamaBase}/api` });
      return provider.chat(modelId);
    }
    case "openaiCompatible": {
      if (!baseUrl) {
        throw new Error(`Set a base URL for ${def.label} in Settings → Providers.`);
      }
      const apiKey = getProviderApiKey(providerId) ?? "not-needed";
      const provider = createOpenAICompatible({
        name: providerId,
        baseURL: baseUrl,
        apiKey,
      });
      return provider.chatModel(modelId);
    }
    default:
      throw new Error(`Unsupported provider family "${def.family}".`);
  }
}

/** Fetch the model list for endpoints that expose one (ollama, openai-compatible). */
export async function fetchRemoteModels(providerId) {
  const def = getProviderDef(providerId);
  if (!def) throw new Error(`Unknown provider "${providerId}".`);
  const stored = getConfig().providers[providerId] ?? {};

  if (def.family === "ollama") {
    const base = (stored.baseUrl?.trim() || def.defaultBaseUrl)
      .replace(/\/(?:api|v1)\/?$/, "")
      .replace(/\/$/, "");
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}. Is it running?`);
    const json = await res.json();
    return (json.models ?? []).map((m) => m.name).filter(Boolean);
  }

  if (def.family === "openaiCompatible") {
    const baseUrl = stored.baseUrl?.trim();
    if (!baseUrl) throw new Error("Set a base URL first.");
    const headers = { Accept: "application/json" };
    const apiKey = getProviderApiKey(providerId);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Endpoint responded ${res.status}.`);
    const json = await res.json();
    return (json.data ?? []).map((m) => m.id).filter(Boolean);
  }

  // Curated providers ship a static suggestion list.
  return def.suggestedModels;
}
