import fs from 'node:fs';
import path from 'node:path';
import { getEnvSettings } from './settings.js';

export class BudgetExceededError extends Error {
  constructor(public currentUsd: number, public maxUsd: number) {
    super(`Budget exceeded: $${currentUsd.toFixed(4)} >= MISSTEP_MAX_USD ($${maxUsd.toFixed(2)})`);
    this.name = 'BudgetExceededError';
  }
}

export interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

// Verified prices from PLAN.md section 2.1 & 2.3 (USD per 1M tokens)
export const PRICE_TABLE: Record<string, ModelPrice> = {
  'gemini-4-hydrogen': { inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 7.5 },
  'gemini-4-neon': { inputPerMillion: 3.0, cachedInputPerMillion: 0.15, outputPerMillion: 15.0 },
  'gemini-4-carbon': { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 10.0 },
  'gemini-4-argon': { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 10.0 },
  'gemini-decision-1': { inputPerMillion: 0.1, cachedInputPerMillion: 0.1, outputPerMillion: 0.0 },
  'gemini-3.8-flash-tts': { inputPerMillion: 1.0, cachedInputPerMillion: 0.1, outputPerMillion: 10.0 },
  'gemini-3.8-flash-lite-tts': { inputPerMillion: 0.5, cachedInputPerMillion: 0.05, outputPerMillion: 5.0 },
  'antigravity-preview-09-2026': { inputPerMillion: 3.0, cachedInputPerMillion: 0.15, outputPerMillion: 15.0 },
};

export interface UsageInfo {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

export interface SpendLedger {
  total_usd: number;
  by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number; usd: number }>;
  updated_at: string;
}

function getSpendPath(): string {
  const { runsDir } = getEnvSettings();
  return path.join(runsDir, 'spend.json');
}

export function readSpendLedger(): SpendLedger {
  const p = getSpendPath();
  if (!fs.existsSync(p)) {
    return { total_usd: 0, by_model: {}, updated_at: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SpendLedger;
  } catch {
    return { total_usd: 0, by_model: {}, updated_at: new Date().toISOString() };
  }
}

export function computeCallCostUsd(model: string, usage: UsageInfo): number {
  const price = PRICE_TABLE[model] ?? PRICE_TABLE['gemini-4-neon'];
  const totalIn = usage.inputTokens ?? 0;
  const cachedIn = Math.min(totalIn, usage.cachedInputTokens ?? 0);
  const uncachedIn = Math.max(0, totalIn - cachedIn);
  const out = (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0);
  return (
    (uncachedIn / 1_000_000) * price.inputPerMillion +
    (cachedIn / 1_000_000) * price.cachedInputPerMillion +
    (out / 1_000_000) * price.outputPerMillion
  );
}

export function assertWithinBudget(): void {
  const { maxUsd } = getEnvSettings();
  const ledger = readSpendLedger();
  if (ledger.total_usd >= maxUsd) {
    throw new BudgetExceededError(ledger.total_usd, maxUsd);
  }
}

export function recordSpend(model: string, usage: UsageInfo): number {
  const cost = computeCallCostUsd(model, usage);
  const ledger = readSpendLedger();
  ledger.total_usd = Number((ledger.total_usd + cost).toFixed(6));
  const existing = ledger.by_model[model] ?? { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
  existing.calls += 1;
  existing.input_tokens += usage.inputTokens ?? 0;
  existing.output_tokens += (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0);
  existing.usd = Number((existing.usd + cost).toFixed(6));
  ledger.by_model[model] = existing;
  ledger.updated_at = new Date().toISOString();

  const p = getSpendPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
  return cost;
}
