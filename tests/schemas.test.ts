import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GoldRecordingSchema,
  ProcedureSchema,
  RunResultSchema,
  StepCheckSchema,
  StepVerdictSchema,
  StepWindowSchema,
} from '../misstep/schemas.js';

test('ProcedureSchema round-trips valid procedure JSON', () => {
  const proc = {
    procedure_id: 'medprep_v1',
    title: 'MedPrep Demo (Week 47)',
    source: 'medprep' as const,
    steps: [
      {
        step_id: 'S1',
        text: 'Lay out the 7-day pill organizer with lids open for MON through THU.',
        visible_evidence: ['organizer on mat', 'MON through THU lids open'],
        quantity: null,
        checks: [
          {
            check_id: 'c_lids',
            text: 'Are the MON through THU lids open?',
            category: 'preparation' as const,
          },
        ],
        must_follow: [],
        optional: false,
        checkable: true,
      },
      {
        step_id: 'S2',
        text: 'Place 2 BLUE tablets in each of MON, TUE, WED, THU AM.',
        visible_evidence: ['2 blue tablets in MON-THU AM'],
        quantity: { item: 'blue tablets', amount: '2', unit: 'tablets' },
        checks: [],
        must_follow: ['S1'],
        optional: false,
        checkable: true,
      },
    ],
  };

  const parsed = ProcedureSchema.parse(proc);
  const reparsed = ProcedureSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed, parsed);
});

test('StepWindow, StepCheck, StepVerdict, RunResult, GoldRecording round-trip', () => {
  const win = StepWindowSchema.parse({
    step_id: 'S1',
    found: true,
    start_s: 2.5,
    end_s: 9.0,
    note: 'opened organizer lids',
  });
  const chk = StepCheckSchema.parse({
    step_id: 'S2',
    p_done_full: 0.91,
    p_done_clip: 0.88,
    measurement_probs: { less: 0.72, correct: 0.2, more: 0.05, cannot_tell: 0.03 },
    check_p_true: { c_lids: 0.95 },
  });
  const verdict = StepVerdictSchema.parse({
    step_id: 'S2',
    status: 'error',
    categories: ['measurement'],
    p_error: 0.77,
    decided_by: 'rules',
    evidence: [{ t_s: 12.0, text: 'P(less+more)=0.77' }],
  });
  const run = RunResultSchema.parse({
    run_id: 'run_1',
    system: 'misstep',
    config_version: 'v1',
    recording_id: 'rec_1',
    procedure_id: 'medprep_v1',
    windows: [win],
    checks: [chk],
    verdicts: [verdict],
    cost_usd: 0.025,
    latency_s: 4.2,
    errors: [],
  });
  assert.equal(run.verdicts[0].categories[0], 'measurement');

  const gold = GoldRecordingSchema.parse({
    recording_id: '1_7',
    activity_id: '1',
    is_error: true,
    duration_s: 400,
    steps: [
      {
        step_id: '12',
        has_error: true,
        categories: ['measurement'],
        start_s: 101.2,
        end_s: 130.5,
        description: 'Added half cup instead of full cup',
      },
    ],
  });
  assert.equal(gold.steps[0].has_error, true);
});
