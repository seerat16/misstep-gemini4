import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCarbonDecision, evaluateSingleStep, evaluateSteps } from '../misstep/rules.js';
import type { Procedure, StepCheck, StepWindow } from '../misstep/schemas.js';
import { loadConfig } from '../misstep/settings.js';

const cfg = loadConfig();

const baseProc: Procedure = {
  procedure_id: 'test_proc',
  title: 'Test Procedure',
  source: 'upload',
  steps: [
    {
      step_id: 'S1',
      text: 'Open jar',
      visible_evidence: ['lid off jar'],
      quantity: null,
      checks: [],
      must_follow: [],
      optional: false,
      checkable: true,
    },
    {
      step_id: 'S2',
      text: 'Add 2 cups flour',
      visible_evidence: ['2 cups flour in bowl'],
      quantity: { item: 'flour', amount: '2', unit: 'cups' },
      checks: [{ check_id: 'c_sift', text: 'Is flour sifted?', category: 'technique' }],
      must_follow: ['S1'],
      optional: false,
      checkable: true,
    },
    {
      step_id: 'S3',
      text: 'Taste silently',
      visible_evidence: [],
      quantity: null,
      checks: [],
      must_follow: [],
      optional: false,
      checkable: false,
    },
  ],
};

test('evaluateSteps detects missing_step, order violation, measurement error, visual check failure, and not_checkable', () => {
  // Missing S1
  const winMissing: StepWindow[] = [
    { step_id: 'S1', found: false, start_s: null, end_s: null, note: '' },
    { step_id: 'S2', found: true, start_s: 10, end_s: 20, note: '' },
  ];
  const chkMissing: StepCheck[] = [
    { step_id: 'S1', p_done_full: 0.1, p_done_clip: null, measurement_probs: null, check_p_true: {} },
    {
      step_id: 'S2',
      p_done_full: 0.9,
      p_done_clip: 0.9,
      measurement_probs: { less: 0.5, correct: 0.2, more: 0.2, cannot_tell: 0.1 },
      check_p_true: { c_sift: 0.2 },
    },
  ];
  const verdicts = evaluateSteps(baseProc, winMissing, chkMissing, cfg);
  assert.equal(verdicts[0].status, 'error');
  assert.deepEqual(verdicts[0].categories, ['missing_step']);

  assert.equal(verdicts[1].status, 'error');
  assert.ok(verdicts[1].categories.includes('measurement'));
  assert.ok(verdicts[1].categories.includes('technique'));

  assert.equal(verdicts[2].status, 'not_checkable');

  // Order error: S2 starts at 5s while S1 ends at 15s (tolerance 2s => 5 < 13)
  const winOrder = new Map<string, StepWindow>([
    ['S1', { step_id: 'S1', found: true, start_s: 1, end_s: 15, note: '' }],
    ['S2', { step_id: 'S2', found: true, start_s: 5, end_s: 20, note: '' }],
  ]);
  const vOrder = evaluateSingleStep(
    baseProc.steps[1],
    winOrder.get('S2'),
    {
      step_id: 'S2',
      p_done_full: 0.95,
      p_done_clip: 0.95,
      measurement_probs: { less: 0.05, correct: 0.9, more: 0.02, cannot_tell: 0.03 },
      check_p_true: { c_sift: 0.95 },
    },
    winOrder,
    cfg,
  );
  assert.equal(vOrder.status, 'error');
  assert.ok(vOrder.categories.includes('order'));
});

test('evaluateSingleStep enters uncertain band when localizer misses step with high p_done_full or p_error in band', () => {
  const winMap = new Map<string, StepWindow>([
    ['S1', { step_id: 'S1', found: false, start_s: null, end_s: null, note: '' }],
  ]);
  const vUnc = evaluateSingleStep(
    baseProc.steps[0],
    winMap.get('S1'),
    { step_id: 'S1', p_done_full: 0.72, p_done_clip: null, measurement_probs: null, check_p_true: {} },
    winMap,
    cfg,
  );
  assert.equal(vUnc.status, 'uncertain');
  assert.ok(vUnc.p_error >= 0.35 && vUnc.p_error <= 0.65);
});

test('applyCarbonDecision vetoes error->ok, resolves uncertain, ignores ok steps', () => {
  const okVerdict = {
    step_id: 'S1',
    status: 'ok' as const,
    categories: [],
    p_error: 0.08,
    decided_by: 'rules' as const,
    evidence: [],
  };
  const afterOk = applyCarbonDecision(
    okVerdict,
    { verdict: 'error', categories: ['technique'], rationale: 'should be ignored' },
    true,
    false,
  );
  assert.equal(afterOk.status, 'ok');

  const errVerdict = {
    step_id: 'S2',
    status: 'error' as const,
    categories: ['measurement' as const],
    p_error: 0.75,
    decided_by: 'rules' as const,
    evidence: [],
  };
  const vetoed = applyCarbonDecision(
    errVerdict,
    { verdict: 'ok', categories: [], rationale: 'Clearly 2 full cups visible' },
    true,
    false,
  );
  assert.equal(vetoed.status, 'ok');
  assert.deepEqual(vetoed.categories, []);
  assert.equal(vetoed.decided_by, 'carbon');

  const uncVerdict = {
    step_id: 'S1',
    status: 'uncertain' as const,
    categories: [],
    p_error: 0.5,
    decided_by: 'rules' as const,
    evidence: [],
  };
  const resolved = applyCarbonDecision(
    uncVerdict,
    { verdict: 'error', categories: ['missing_step'], rationale: 'Lid remained closed' },
    true,
    false,
  );
  assert.equal(resolved.status, 'error');
  assert.deepEqual(resolved.categories, ['missing_step']);
});
