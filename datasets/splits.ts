import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ERROR_CATEGORIES, type ErrorCategory, type GoldRecording } from '../misstep/schemas.js';
import { getEnvSettings } from '../misstep/settings.js';
import { loadGold, readGoldJsonl } from './cc4d.js';

export interface SplitFile {
  seed: number;
  dev: string[];
  test: string[];
  dev_recipes: string[];
  test_recipes: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickBalanced(pool: GoldRecording[], targetCount: number, rng: () => number): GoldRecording[] {
  const under15 = pool.filter((r) => r.duration_s <= 900);
  const over15 = pool.filter((r) => r.duration_s > 900);
  const ordered = [...shuffleWithSeed(under15, rng), ...shuffleWithSeed(over15, rng)];

  const errPool = ordered.filter((r) => r.is_error);
  const cleanPool = ordered.filter((r) => !r.is_error);
  const half = Math.floor(targetCount / 2);

  const chosen = [...errPool.slice(0, half), ...cleanPool.slice(0, targetCount - half)];
  if (chosen.length < targetCount) {
    const chosenIds = new Set(chosen.map((r) => r.recording_id));
    for (const r of ordered) {
      if (chosen.length >= targetCount) break;
      if (!chosenIds.has(r.recording_id)) {
        chosen.push(r);
        chosenIds.add(r.recording_id);
      }
    }
  }
  return chosen;
}

export function buildSplits(seed = 20261121): SplitFile {
  let gold = readGoldJsonl();
  if (gold.length === 0) {
    gold = loadGold(true);
  }
  if (gold.length === 0) {
    throw new Error('No gold recordings found. Clone CaptainCook4D annotations into data/cc4d_annotations first.');
  }

  const rng = mulberry32(seed);
  const byActivity = new Map<string, GoldRecording[]>();
  for (const rec of gold) {
    const list = byActivity.get(rec.activity_id) ?? [];
    list.push(rec);
    byActivity.set(rec.activity_id, list);
  }

  const activities = shuffleWithSeed(Array.from(byActivity.keys()), rng);
  const testRecipes = activities.slice(0, Math.min(6, Math.max(1, Math.floor(activities.length / 3))));
  const testRecipeSet = new Set(testRecipes);

  const testPool = gold.filter((r) => testRecipeSet.has(r.activity_id));
  const testRecs = pickBalanced(testPool, Math.min(40, testPool.length), rng);

  const devPool = gold.filter((r) => !testRecipeSet.has(r.activity_id));
  const devRecs = pickBalanced(devPool, Math.min(16, devPool.length), rng);
  const devRecipes = Array.from(new Set(devRecs.map((r) => r.activity_id)));

  // Assert recipe disjointness
  for (const r of devRecipes) {
    assert.ok(!testRecipeSet.has(r), `Recipe ${r} leaked into both dev and test splits!`);
  }

  const split: SplitFile = {
    seed,
    dev: devRecs.map((r) => r.recording_id),
    test: testRecs.map((r) => r.recording_id),
    dev_recipes: devRecipes,
    test_recipes: testRecipes,
  };

  const outPath = path.join(getEnvSettings().dataDir, 'splits.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(split, null, 2), 'utf-8');
  return split;
}

export function readSplits(): SplitFile {
  const splitPath = path.join(getEnvSettings().dataDir, 'splits.json');
  if (!fs.existsSync(splitPath)) {
    throw new Error(`splits.json not found at ${splitPath}`);
  }
  return JSON.parse(fs.readFileSync(splitPath, 'utf-8')) as SplitFile;
}

export function summarizeSplit(
  splitName: string,
  ids: string[],
  goldById: Map<string, GoldRecording>,
): {
  split: string;
  recordings: number;
  steps: number;
  error_steps: number;
  hours: number;
  by_category: Record<ErrorCategory, number>;
  low_n_categories: ErrorCategory[];
} {
  const byCat = Object.fromEntries(ALL_ERROR_CATEGORIES.map((c) => [c, 0])) as Record<
    ErrorCategory,
    number
  >;
  let steps = 0;
  let errorSteps = 0;
  let totalSec = 0;
  let count = 0;

  for (const id of ids) {
    const rec = goldById.get(id);
    if (!rec) continue;
    count += 1;
    totalSec += rec.duration_s;
    for (const s of rec.steps) {
      steps += 1;
      if (s.has_error) {
        errorSteps += 1;
        for (const c of s.categories) {
          byCat[c] = (byCat[c] ?? 0) + 1;
        }
      }
    }
  }

  const lowN = ALL_ERROR_CATEGORIES.filter((c) => byCat[c] < 5);
  return {
    split: splitName,
    recordings: count,
    steps,
    error_steps: errorSteps,
    hours: Number((totalSec / 3600).toFixed(2)),
    by_category: byCat,
    low_n_categories: lowN,
  };
}
