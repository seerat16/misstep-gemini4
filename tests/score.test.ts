import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreSystem } from '../eval/score.js';
import type { GoldRecording, RunResult } from '../misstep/schemas.js';

test('scoreSystem computes precision, recall, F1, covered F1, coverage, AUROC, ECE, per-category, and paired diff', () => {
  const golds: GoldRecording[] = [
    {
      recording_id: 'r1',
      activity_id: 'a1',
      is_error: true,
      duration_s: 60,
      steps: [
        { step_id: 's1', has_error: true, categories: ['measurement'], start_s: 5, end_s: 10, description: '' },
        { step_id: 's2', has_error: false, categories: [], start_s: 15, end_s: 25, description: '' },
      ],
    },
    {
      recording_id: 'r2',
      activity_id: 'a1',
      is_error: true,
      duration_s: 60,
      steps: [
        { step_id: 's1', has_error: false, categories: [], start_s: 5, end_s: 12, description: '' },
        { step_id: 's2', has_error: true, categories: ['missing_step'], start_s: null, end_s: null, description: '' },
      ],
    },
    {
      recording_id: 'r3',
      activity_id: 'a2',
      is_error: false,
      duration_s: 50,
      steps: [
        { step_id: 's1', has_error: false, categories: [], start_s: 4, end_s: 10, description: '' },
        { step_id: 's2', has_error: false, categories: [], start_s: 12, end_s: 20, description: '' },
      ],
    },
  ];

  // Misstep: r1.s1 TP (measurement), r1.s2 ok TN, r2.s1 ok TN, r2.s2 uncertain (counts as FN for main F1, excluded from covered F1),
  // r3.s1 FP (false alarm), r3.s2 ok TN
  // Main counts: TP=1, FP=1, FN=1 -> Precision=0.5, Recall=0.5, F1=0.5
  // Covered (5 of 6 steps = 0.8333): TP=1, FP=1, FN=0 -> Covered Precision=0.5, Recall=1.0, Covered F1=0.6667
  const misstepRuns: RunResult[] = [
    {
      run_id: 'm1',
      system: 'misstep',
      config_version: 'v1',
      recording_id: 'r1',
      procedure_id: 'a1',
      windows: [],
      checks: [],
      verdicts: [
        { step_id: 's1', status: 'error', categories: ['measurement'], p_error: 0.9, decided_by: 'rules', evidence: [] },
        { step_id: 's2', status: 'ok', categories: [], p_error: 0.1, decided_by: 'rules', evidence: [] },
      ],
      cost_usd: 0.02,
      latency_s: 3.0,
      errors: [],
    },
    {
      run_id: 'm2',
      system: 'misstep',
      config_version: 'v1',
      recording_id: 'r2',
      procedure_id: 'a1',
      windows: [],
      checks: [],
      verdicts: [
        { step_id: 's1', status: 'ok', categories: [], p_error: 0.15, decided_by: 'rules', evidence: [] },
        { step_id: 's2', status: 'uncertain', categories: [], p_error: 0.5, decided_by: 'rules', evidence: [] },
      ],
      cost_usd: 0.03,
      latency_s: 4.0,
      errors: [],
    },
    {
      run_id: 'm3',
      system: 'misstep',
      config_version: 'v1',
      recording_id: 'r3',
      procedure_id: 'a2',
      windows: [],
      checks: [],
      verdicts: [
        { step_id: 's1', status: 'error', categories: ['technique'], p_error: 0.8, decided_by: 'rules', evidence: [] },
        { step_id: 's2', status: 'ok', categories: [], p_error: 0.05, decided_by: 'rules', evidence: [] },
      ],
      cost_usd: 0.01,
      latency_s: 2.0,
      errors: [],
    },
  ];

  // B1: predicts all ok (F1 = 0)
  const b1Runs: RunResult[] = golds.map((g, i) => ({
    run_id: `b${i}`,
    system: 'B1',
    config_version: 'v1',
    recording_id: g.recording_id,
    procedure_id: g.activity_id,
    windows: [],
    checks: [],
    verdicts: g.steps.map((s) => ({
      step_id: s.step_id,
      status: 'ok' as const,
      categories: [],
      p_error: 0.2,
      decided_by: 'rules' as const,
      evidence: [],
    })),
    cost_usd: 0.01,
    latency_s: 1.5,
    errors: [],
  }));

  const report = scoreSystem('misstep', golds, misstepRuns, b1Runs, 200);
  assert.equal(report.recordings, 3);
  assert.equal(report.steps, 6);
  assert.equal(report.precision.value, 0.5);
  assert.equal(report.recall.value, 0.5);
  assert.equal(report.f1.value, 0.5);
  assert.ok(Math.abs(report.covered_f1.value - 2 / 3) < 0.002);
  assert.ok(Math.abs(report.coverage.value - 5 / 6) < 0.002);
  assert.ok(report.auroc.value > 0.8);
  assert.ok(report.ece.value >= 0 && report.ece.value <= 1);

  const measRow = report.per_category.find((r) => r.category === 'measurement')!;
  assert.equal(measRow.gold_count, 1);
  assert.equal(measRow.category_recall, 1);
  assert.equal(measRow.low_n, true);

  assert.ok(report.paired_vs_b1);
  assert.equal(report.paired_vs_b1.diff_f1, 0.5);
});
