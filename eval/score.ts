import {
  ALL_ERROR_CATEGORIES,
  type ErrorCategory,
  type GoldRecording,
  type RunResult,
} from '../misstep/schemas.js';

export interface MetricCI {
  value: number;
  ci_low: number;
  ci_high: number;
}

export interface CategoryRecallRow {
  category: ErrorCategory;
  gold_count: number;
  category_recall: number;
  detected_any_error_recall: number;
  low_n: boolean;
}

export interface EvalScoreReport {
  system: string;
  recordings: number;
  steps: number;
  precision: MetricCI;
  recall: MetricCI;
  f1: MetricCI;
  covered_f1: MetricCI;
  coverage: MetricCI;
  recording_accuracy: MetricCI;
  recording_f1: MetricCI;
  auroc: MetricCI;
  ece: MetricCI;
  mean_cost_usd: number;
  p90_cost_usd: number;
  mean_latency_s: number;
  p90_latency_s: number;
  per_category: CategoryRecallRow[];
  reliability_bins: Array<{
    bin_index: number;
    range: [number, number];
    count: number;
    mean_conf: number;
    mean_acc: number;
  }>;
  paired_vs_b1?: {
    diff_f1: number;
    ci_low: number;
    ci_high: number;
    significant: boolean;
  };
}

interface RecordingEvalUnit {
  recording_id: string;
  gold_has_error: boolean;
  pred_has_error: boolean;
  cost_usd: number;
  latency_s: number;
  steps: Array<{
    gold_error: boolean;
    gold_categories: ErrorCategory[];
    pred_error: boolean;
    pred_uncertain: boolean;
    pred_categories: ErrorCategory[];
    p_error: number;
  }>;
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

export function computeAuroc(labels: boolean[], scores: number[]): number {
  const nPos = labels.filter(Boolean).length;
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;

  const indexed = scores.map((s, i) => ({ s, y: labels[i] ? 1 : 0 })).sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].s === indexed[i].s) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (indexed[k].y === 1) rankSumPos += avgRank;
    }
    i = j;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function computeEce(
  labels: boolean[],
  probs: number[],
  numBins = 10,
): {
  ece: number;
  bins: Array<{
    bin_index: number;
    range: [number, number];
    count: number;
    mean_conf: number;
    mean_acc: number;
  }>;
} {
  const n = labels.length;
  const bins: Array<{
    bin_index: number;
    range: [number, number];
    count: number;
    mean_conf: number;
    mean_acc: number;
  }> = [];

  let ece = 0;
  for (let b = 0; b < numBins; b++) {
    const lo = b / numBins;
    const hi = (b + 1) / numBins;
    const idxs: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = probs[i];
      if (b === numBins - 1 ? p >= lo && p <= hi : p >= lo && p < hi) {
        idxs.push(i);
      }
    }
    if (idxs.length === 0) {
      bins.push({ bin_index: b, range: [lo, hi], count: 0, mean_conf: 0, mean_acc: 0 });
      continue;
    }
    const meanConf = idxs.reduce((acc, idx) => acc + probs[idx], 0) / idxs.length;
    const meanAcc = idxs.reduce((acc, idx) => acc + (labels[idx] ? 1 : 0), 0) / idxs.length;
    ece += (Math.abs(meanAcc - meanConf) * idxs.length) / Math.max(1, n);
    bins.push({
      bin_index: b,
      range: [lo, hi],
      count: idxs.length,
      mean_conf: Number(meanConf.toFixed(4)),
      mean_acc: Number(meanAcc.toFixed(4)),
    });
  }
  return { ece, bins };
}

function prf(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function buildRecordingUnits(
  golds: GoldRecording[],
  results: RunResult[],
): RecordingEvalUnit[] {
  const resByRec = new Map(results.map((r) => [r.recording_id, r]));
  const units: RecordingEvalUnit[] = [];

  for (const g of golds) {
    const r = resByRec.get(g.recording_id);
    if (!r) continue;
    const vByStep = new Map(r.verdicts.map((v) => [v.step_id, v]));
    const stepUnits = g.steps.map((gs) => {
      const v = vByStep.get(gs.step_id);
      const predError = v?.status === 'error';
      const predUncertain = v?.status === 'uncertain';
      return {
        gold_error: gs.has_error,
        gold_categories: gs.categories,
        pred_error: predError,
        pred_uncertain: predUncertain,
        pred_categories: v?.categories ?? [],
        p_error: v?.p_error ?? 0,
      };
    });
    units.push({
      recording_id: g.recording_id,
      gold_has_error: g.is_error,
      pred_has_error: stepUnits.some((s) => s.pred_error),
      cost_usd: r.cost_usd,
      latency_s: r.latency_s,
      steps: stepUnits,
    });
  }
  return units;
}

function computeScalarMetrics(units: RecordingEvalUnit[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  let covTp = 0;
  let covFp = 0;
  let covFn = 0;
  let coveredCount = 0;
  let totalSteps = 0;

  let recTp = 0;
  let recFp = 0;
  let recFn = 0;
  let recCorrect = 0;

  const labels: boolean[] = [];
  const probs: number[] = [];

  for (const u of units) {
    if (u.gold_has_error === u.pred_has_error) recCorrect += 1;
    if (u.pred_has_error && u.gold_has_error) recTp += 1;
    else if (u.pred_has_error && !u.gold_has_error) recFp += 1;
    else if (!u.pred_has_error && u.gold_has_error) recFn += 1;

    for (const s of u.steps) {
      totalSteps += 1;
      labels.push(s.gold_error);
      probs.push(s.p_error);

      if (s.pred_error && s.gold_error) tp += 1;
      else if (s.pred_error && !s.gold_error) fp += 1;
      else if (!s.pred_error && s.gold_error) fn += 1;

      if (!s.pred_uncertain) {
        coveredCount += 1;
        if (s.pred_error && s.gold_error) covTp += 1;
        else if (s.pred_error && !s.gold_error) covFp += 1;
        else if (!s.pred_error && s.gold_error) covFn += 1;
      }
    }
  }

  const main = prf(tp, fp, fn);
  const cov = prf(covTp, covFp, covFn);
  const rec = prf(recTp, recFp, recFn);
  const coverage = totalSteps > 0 ? coveredCount / totalSteps : 1;
  const recAcc = units.length > 0 ? recCorrect / units.length : 0;
  const auroc = computeAuroc(labels, probs);
  const { ece, bins } = computeEce(labels, probs, 10);

  return {
    precision: main.precision,
    recall: main.recall,
    f1: main.f1,
    covered_f1: cov.f1,
    coverage,
    recording_accuracy: recAcc,
    recording_f1: rec.f1,
    auroc,
    ece,
    bins,
    totalSteps,
  };
}

function percentile90(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)));
  return sorted[idx];
}

function quantileCI(samples: number[], point: number): MetricCI {
  if (samples.length === 0) return { value: point, ci_low: point, ci_high: point };
  const sorted = [...samples].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.025 * (sorted.length - 1))];
  const hi = sorted[Math.floor(0.975 * (sorted.length - 1))];
  return {
    value: Number(point.toFixed(4)),
    ci_low: Number(lo.toFixed(4)),
    ci_high: Number(hi.toFixed(4)),
  };
}

export function scoreSystem(
  system: string,
  golds: GoldRecording[],
  results: RunResult[],
  baselineB1Results?: RunResult[],
  bootstrapIterations = 1000,
  seed = 20261121,
): EvalScoreReport {
  const units = buildRecordingUnits(golds, results);
  const point = computeScalarMetrics(units);

  const rng = mulberry32(seed);
  const bootPrec: number[] = [];
  const bootRec: number[] = [];
  const bootF1: number[] = [];
  const bootCovF1: number[] = [];
  const bootCoverage: number[] = [];
  const bootRecAcc: number[] = [];
  const bootRecF1: number[] = [];
  const bootAuroc: number[] = [];
  const bootEce: number[] = [];
  const bootDiffVsB1: number[] = [];

  const b1UnitsByRec = baselineB1Results
    ? new Map(buildRecordingUnits(golds, baselineB1Results).map((u) => [u.recording_id, u]))
    : null;

  for (let b = 0; b < bootstrapIterations; b++) {
    if (units.length === 0) break;
    const sample: RecordingEvalUnit[] = [];
    const sampleB1: RecordingEvalUnit[] = [];
    for (let i = 0; i < units.length; i++) {
      const idx = Math.floor(rng() * units.length);
      const u = units[idx];
      sample.push(u);
      if (b1UnitsByRec) {
        const b1u = b1UnitsByRec.get(u.recording_id);
        if (b1u) sampleB1.push(b1u);
      }
    }
    const m = computeScalarMetrics(sample);
    bootPrec.push(m.precision);
    bootRec.push(m.recall);
    bootF1.push(m.f1);
    bootCovF1.push(m.covered_f1);
    bootCoverage.push(m.coverage);
    bootRecAcc.push(m.recording_accuracy);
    bootRecF1.push(m.recording_f1);
    bootAuroc.push(m.auroc);
    bootEce.push(m.ece);

    if (b1UnitsByRec && sampleB1.length > 0) {
      const mB1 = computeScalarMetrics(sampleB1);
      bootDiffVsB1.push(m.f1 - mB1.f1);
    }
  }

  // Per-category recall
  const perCategory: CategoryRecallRow[] = ALL_ERROR_CATEGORIES.map((cat) => {
    let goldCount = 0;
    let exactCatHits = 0;
    let anyErrHits = 0;
    for (const u of units) {
      for (const s of u.steps) {
        if (s.gold_error && s.gold_categories.includes(cat)) {
          goldCount += 1;
          if (s.pred_error) {
            anyErrHits += 1;
            if (s.pred_categories.includes(cat)) {
              exactCatHits += 1;
            }
          }
        }
      }
    }
    return {
      category: cat,
      gold_count: goldCount,
      category_recall: goldCount > 0 ? Number((exactCatHits / goldCount).toFixed(4)) : 0,
      detected_any_error_recall: goldCount > 0 ? Number((anyErrHits / goldCount).toFixed(4)) : 0,
      low_n: goldCount < 5,
    };
  });

  const costs = units.map((u) => u.cost_usd);
  const latencies = units.map((u) => u.latency_s);
  const meanCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
  const meanLatency =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  let pairedVsB1: EvalScoreReport['paired_vs_b1'];
  if (b1UnitsByRec && bootDiffVsB1.length > 0) {
    const b1Point = computeScalarMetrics(Array.from(b1UnitsByRec.values()));
    const diffPoint = point.f1 - b1Point.f1;
    const diffCI = quantileCI(bootDiffVsB1, diffPoint);
    pairedVsB1 = {
      diff_f1: diffCI.value,
      ci_low: diffCI.ci_low,
      ci_high: diffCI.ci_high,
      significant: diffCI.ci_low > 0 || diffCI.ci_high < 0,
    };
  }

  return {
    system,
    recordings: units.length,
    steps: point.totalSteps,
    precision: quantileCI(bootPrec, point.precision),
    recall: quantileCI(bootRec, point.recall),
    f1: quantileCI(bootF1, point.f1),
    covered_f1: quantileCI(bootCovF1, point.covered_f1),
    coverage: quantileCI(bootCoverage, point.coverage),
    recording_accuracy: quantileCI(bootRecAcc, point.recording_accuracy),
    recording_f1: quantileCI(bootRecF1, point.recording_f1),
    auroc: quantileCI(bootAuroc, point.auroc),
    ece: quantileCI(bootEce, point.ece),
    mean_cost_usd: Number(meanCost.toFixed(4)),
    p90_cost_usd: Number(percentile90(costs).toFixed(4)),
    mean_latency_s: Number(meanLatency.toFixed(2)),
    p90_latency_s: Number(percentile90(latencies).toFixed(2)),
    per_category: perCategory,
    reliability_bins: point.bins,
    ...(pairedVsB1 ? { paired_vs_b1: pairedVsB1 } : {}),
  };
}
