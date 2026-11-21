import fs from 'node:fs';
import path from 'node:path';
import {
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  type ContentListUnion,
  type Part,
  type Schema,
} from '@google/genai';
import { computeCacheKey, hashFileSha256, readCache, writeCache } from './cache.js';
import { assertWithinBudget, recordSpend, type UsageInfo } from './cost.js';
import { getEnvSettings } from './settings.js';

export function appendDebugLog(msg: string): void {
  try {
    const runsDir = getEnvSettings().runsDir;
    fs.mkdirSync(runsDir, { recursive: true });
    fs.appendFileSync(path.join(runsDir, 'eval_debug.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {
    // ignore logging failure
  }
}

class AsyncSemaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

let semaphoreInstance: AsyncSemaphore | null = null;
function getSemaphore(): AsyncSemaphore {
  if (!semaphoreInstance) {
    semaphoreInstance = new AsyncSemaphore(getEnvSettings().concurrency);
  }
  return semaphoreInstance;
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) {
    throw new Error(
      'GEMINI_API_KEY is not configured in the server environment. Configure it in Settings > Secrets.',
    );
  }
  return key;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function createStandardClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getApiKey(),
    httpOptions: {
      timeout: 180_000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function createUploadClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getApiKey(),
    httpOptions: {
      timeout: 900_000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function createDecisionsClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getApiKey(),
    apiVersion: 'v1beta',
    httpOptions: {
      timeout: 300_000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return false;
  }
  if (status === 429 || status === 500 || status === 503 || status === 504) {
    return true;
  }
  return (
    /429|500|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ETIMEDOUT|ECONNRESET|timeout/i.test(
      msg,
    ) && !/400|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND/i.test(msg)
  );
}

const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!isRetryableError(err) || attempt === BACKOFF_MS.length) {
        if (!isRetryableError(err)) {
          console.error(`[gemini] non-retryable error in ${label}:`, err);
        }
        appendDebugLog(`[gemini] FAIL ${label} (attempt ${attempt + 1}): ${errMsg}`);
        throw err;
      }
      const waitMs = BACKOFF_MS[attempt];
      console.warn(`[gemini] retry ${attempt + 1}/${BACKOFF_MS.length} for ${label} in ${waitMs}ms`);
      appendDebugLog(`[gemini] RETRY ${label} (${attempt + 1}/${BACKOFF_MS.length}) in ${waitMs}ms: ${errMsg}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function mapThinkingLevel(level?: string | null): ThinkingLevel | undefined {
  if (!level) return undefined;
  switch (level.toLowerCase()) {
    case 'low':
      return ThinkingLevel.LOW;
    case 'medium':
      return ThinkingLevel.MEDIUM;
    case 'high':
      return ThinkingLevel.HIGH;
    case 'xhigh':
      return ThinkingLevel.XHIGH;
    default:
      return undefined;
  }
}

function mapMediaResolution(res?: string | null): MediaResolution | undefined {
  if (!res) return undefined;
  switch (res.toLowerCase()) {
    case 'low':
      return MediaResolution.MEDIA_RESOLUTION_LOW;
    case 'medium':
      return MediaResolution.MEDIA_RESOLUTION_MEDIUM;
    case 'high':
      return MediaResolution.MEDIA_RESOLUTION_HIGH;
    default:
      return undefined;
  }
}

function extractUsage(usageMetadata: unknown): UsageInfo {
  if (!usageMetadata || typeof usageMetadata !== 'object') return {};
  const u = usageMetadata as Record<string, unknown>;
  return {
    inputTokens: Number(u.promptTokenCount ?? u.total_input_tokens ?? u.inputTokens ?? 0) || 0,
    cachedInputTokens: Number(u.cachedContentTokenCount ?? 0) || 0,
    outputTokens: Number(u.candidatesTokenCount ?? u.total_output_tokens ?? u.outputTokens ?? 0) || 0,
    thinkingTokens: Number(u.thoughtsTokenCount ?? 0) || 0,
  };
}

export interface GenerateJsonOptions {
  model: string;
  parts: Part[];
  schema: Schema;
  thinkingLevel?: 'low' | 'medium' | 'high' | 'xhigh' | null;
  mediaResolution?: 'low' | 'medium' | 'high' | null;
  system?: string | null;
  skipCache?: boolean;
}

export interface GenerateJsonResult<T = unknown> {
  data: T;
  usage: UsageInfo;
  costUsd: number;
  cached: boolean;
  rawText: string;
}

export async function generateJson<T = unknown>(
  opts: GenerateJsonOptions,
): Promise<GenerateJsonResult<T>> {
  const cachePayload = {
    parts: opts.parts,
    schema: opts.schema,
    thinkingLevel: opts.thinkingLevel ?? null,
    mediaResolution: opts.mediaResolution ?? null,
    system: opts.system ?? null,
  };
  const cacheKey = computeCacheKey(opts.model, cachePayload);
  if (!opts.skipCache) {
    const hit = readCache<{ data: T; usage: UsageInfo; rawText: string }>(opts.model, cacheKey);
    if (hit) {
      return {
        data: hit.data,
        usage: hit.usage,
        costUsd: 0,
        cached: true,
        rawText: hit.rawText,
      };
    }
  }

  assertWithinBudget();
  const t0 = Date.now();
  appendDebugLog(`[generateJson] START ${opts.model} mediaRes=${opts.mediaResolution ?? 'default'} thinking=${opts.thinkingLevel ?? 'default'}`);

  const res = await getSemaphore().run(() =>
    withRetry(async () => {
      const ai = createStandardClient();
      const thinkingLvl = mapThinkingLevel(opts.thinkingLevel);
      const mediaRes = mapMediaResolution(opts.mediaResolution);

      const response = await ai.models.generateContent({
        model: opts.model,
        contents: opts.parts as ContentListUnion,
        config: {
          responseMimeType: 'application/json',
          responseSchema: opts.schema,
          ...(opts.system ? { systemInstruction: opts.system } : {}),
          ...(thinkingLvl ? { thinkingConfig: { thinkingLevel: thinkingLvl } } : {}),
          ...(mediaRes ? { mediaResolution: mediaRes } : {}),
        },
      });
      return response;
    }, `generateJson:${opts.model}`),
  );

  const rawText = (res.text ?? '').trim();
  if (!rawText) {
    throw new Error(`Model ${opts.model} returned empty JSON response`);
  }
  const parsed = JSON.parse(rawText) as T;
  const usage = extractUsage(res.usageMetadata);
  const costUsd = recordSpend(opts.model, usage);
  appendDebugLog(`[generateJson] DONE ${opts.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s cost=$${costUsd.toFixed(4)}`);

  writeCache(opts.model, cacheKey, { data: parsed, usage, rawText });
  return {
    data: parsed,
    usage,
    costUsd,
    cached: false,
    rawText,
  };
}

export interface DecisionNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true_description: string;
    false_description: string;
  };
}

export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion =
  | DecisionNoulQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;

export type DecisionInputBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string; resolution?: 'low' | 'medium' | 'high' | 'ultra_high' }
  | { type: 'image'; uri: string; mime_type?: string; resolution?: 'low' | 'medium' | 'high' | 'ultra_high' }
  | { type: 'video'; uri: string; mime_type?: string; resolution?: 'low' | 'medium' | 'high' }
  | { type: 'video'; data: string; mime_type: string; resolution?: 'low' | 'medium' | 'high' }
  | { type: 'document'; data: string; mime_type: 'application/pdf' }
  | { type: 'document'; uri: string; mime_type: 'application/pdf' };

export interface DecisionAnswerNoul {
  type: 'noul';
  noul: number;
  confidence: number;
}

export interface DecisionAnswerChoice {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface DecisionAnswerScore {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer =
  | DecisionAnswerNoul
  | DecisionAnswerChoice
  | DecisionAnswerScore;

export interface DecideResult {
  answers: Record<string, DecisionAnswer>;
  usage: UsageInfo;
  costUsd: number;
  cached: boolean;
}

export async function decide(
  inputBlocks: DecisionInputBlock[],
  questions: Record<string, DecisionQuestion>,
  skipCache = false,
): Promise<DecideResult> {
  const model = 'gemini-decision-1';
  const cacheKey = computeCacheKey(model, { inputBlocks, questions });

  if (!skipCache) {
    const hit = readCache<{ answers: Record<string, DecisionAnswer>; usage: UsageInfo }>(model, cacheKey);
    if (hit) {
      return { answers: hit.answers, usage: hit.usage, costUsd: 0, cached: true };
    }
  }

  assertWithinBudget();
  const t0 = Date.now();
  const qCount = Object.keys(questions).length;
  appendDebugLog(`[decide] START qCount=${qCount}`);

  const response = await getSemaphore().run(() =>
    withRetry(async () => {
      const decisionsAi = createDecisionsClient();
      return await decisionsAi.decisions.create({
        model,
        input: inputBlocks as never,
        questions: questions as never,
      });
    }, 'decide'),
  );

  const answers = (response.answers ?? {}) as unknown as Record<string, DecisionAnswer>;
  if (!response.answers) {
    throw new Error(
      `Decisions API returned no answers (prompt_feedback: ${JSON.stringify(
        (response as { prompt_feedback?: unknown }).prompt_feedback ?? null,
      )})`,
    );
  }

  const rawUsage = (response.usage ?? {}) as Record<string, unknown>;
  const usage: UsageInfo = {
    inputTokens: Number(rawUsage.total_input_tokens ?? rawUsage.input_tokens ?? 0) || 0,
    outputTokens: 0,
  };
  const costUsd = recordSpend(model, usage);
  appendDebugLog(`[decide] DONE qCount=${qCount} in ${((Date.now() - t0) / 1000).toFixed(1)}s cost=$${costUsd.toFixed(4)}`);
  writeCache(model, cacheKey, { answers, usage });

  return { answers, usage, costUsd, cached: false };
}

export async function uploadFile(filePath: string, mimeType = 'video/mp4'): Promise<string> {
  const absPath = path.resolve(filePath);
  const sizeMb = (fs.statSync(absPath).size / (1024 * 1024)).toFixed(2);
  const fileHash = hashFileSha256(absPath);
  const cacheKey = computeCacheKey('files-api', { fileHash, mimeType });
  const hit = readCache<{ uri: string; name: string }>('files-api', cacheKey);

  const ai = createUploadClient();
  if (hit?.name) {
    try {
      const existing = await ai.files.get({ name: hit.name });
      if (existing.state === 'ACTIVE' && existing.uri) {
        appendDebugLog(`[uploadFile] cache hit ACTIVE ${path.basename(absPath)} -> ${existing.uri}`);
        return existing.uri;
      }
    } catch {
      // expired or deleted; re-upload below
    }
  }

  appendDebugLog(`[uploadFile] START ${path.basename(absPath)} (${sizeMb} MB)`);
  const t0 = Date.now();
  const uploaded = await getSemaphore().run(() =>
    withRetry(
      async () =>
        await ai.files.upload({
          file: absPath,
          config: { mimeType },
        }),
      `uploadFile:${path.basename(absPath)}`,
    ),
  );
  appendDebugLog(
    `[uploadFile] UPLOADED ${path.basename(absPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s name=${uploaded.name} state=${uploaded.state}`,
  );

  let current = uploaded;
  const started = Date.now();
  while (current.state === 'PROCESSING') {
    if (Date.now() - started > 300_000) {
      throw new Error(`Timed out waiting for uploaded file ${current.name} to become ACTIVE`);
    }
    await new Promise((r) => setTimeout(r, 2000));
    current = await ai.files.get({ name: current.name! });
  }

  if (current.state !== 'ACTIVE' || !current.uri) {
    throw new Error(`Uploaded file ${current.name} failed with state=${current.state}`);
  }

  appendDebugLog(`[uploadFile] ACTIVE ${path.basename(absPath)} -> ${current.uri}`);
  writeCache('files-api', cacheKey, { uri: current.uri, name: current.name });
  return current.uri;
}

export async function tts(
  text: string,
  voice = 'Kore',
  model = 'gemini-3.8-flash-tts',
): Promise<Buffer> {
  const cacheKey = computeCacheKey(model, { text, voice });
  const hit = readCache<{ audioBase64: string; usage: UsageInfo }>(model, cacheKey);
  if (hit?.audioBase64) {
    return Buffer.from(hit.audioBase64, 'base64');
  }

  assertWithinBudget();

  const res = await getSemaphore().run(() =>
    withRetry(async () => {
      const ai = createDecisionsClient();
      return await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text }],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voice || 'Kore',
              },
            },
          },
        },
      });
    }, `tts:${model}`),
  );

  const b64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    throw new Error('TTS model returned no inlineData audio bytes');
  }
  const usage = extractUsage(res.usageMetadata);
  recordSpend(model, usage);
  writeCache(model, cacheKey, { audioBase64: b64, usage });
  return Buffer.from(b64, 'base64');
}

export async function agentInteraction(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertWithinBudget();
  const res = await getSemaphore().run(() =>
    withRetry(async () => {
      const ai = createDecisionsClient();
      return await ai.interactions.create(params as never, { timeout: 300_000 } as never);
    }, 'agentInteraction'),
  );
  const rec = res as unknown as Record<string, unknown>;
  const usage = extractUsage(rec.usage);
  const agentModel =
    (params.agent_config as { model?: string } | undefined)?.model || 'antigravity-preview-09-2026';
  if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) {
    recordSpend(agentModel, usage);
  }
  return rec;
}
