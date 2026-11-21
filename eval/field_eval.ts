import fs from 'node:fs';
import path from 'node:path';
import type { LiveSession } from '../misstep/live.js';
import {
  ErrorCategoryEnum,
  type ErrorCategory,
  type GoldRecording,
  type RunResult,
} from '../misstep/schemas.js';
import { getEnvSettings } from '../misstep/settings.js';
import { scoreSystem, type EvalScoreReport } from './score.js';

export interface FieldLabelStep {
  step_id: string;
  has_error: boolean;
  categories: ErrorCategory[];
  mistake_t_s?: number | null;
}

export interface FieldLabelRecord {
  session_id: string;
  labeled_at: string;
  intended_mistake_note?: string;
  steps: FieldLabelStep[];
}

export interface FieldEvalSummary {
  runs_scored: number;
  scores: EvalScoreReport | null;
  alert_latencies_s: number[];
  mean_alert_latency_s: number | null;
  median_alert_latency_s: number | null;
  perfect_runs: number;
  false_alarms_per_perfect_run: number;
}

export function getFieldGoldPath(): string {
  return path.join(getEnvSettings().dataDir, 'field_gold.jsonl');
}

export function readFieldGold(): FieldLabelRecord[] {
  const p = getFieldGoldPath();
  if (!fs.existsSync(p)) return [];
  const bySession = new Map<string, FieldLabelRecord>();
  for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as FieldLabelRecord;
      bySession.set(parsed.session_id, parsed);
    } catch {
      // skip malformed line
    }
  }
  return Array.from(bySession.values());
}

export function saveFieldLabel(record: FieldLabelRecord): void {
  const p = getFieldGoldPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const normalized: FieldLabelRecord = {
    ...record,
    labeled_at: record.labeled_at || new Date().toISOString(),
    steps: record.steps.map((s) => ({
      ...s,
      categories: s.categories.map((c) => ErrorCategoryEnum.parse(c)),
    })),
  };
  fs.appendFileSync(p, JSON.stringify(normalized) + '\n', 'utf-8');
}

export function scoreFieldRuns(): FieldEvalSummary {
  const labels = readFieldGold();
  const { runsDir } = getEnvSettings();
  const liveDir = path.join(runsDir, 'live');

  const golds: GoldRecording[] = [];
  const results: RunResult[] = [];
  const alertLatencies: number[] = [];
  let perfectRuns = 0;
  let falseAlarmsOnPerfect = 0;

  for (const label of labels) {
    const sessPath = path.join(liveDir, label.session_id, 'session.json');
    if (!fs.existsSync(sessPath)) continue;
    const sess = JSON.parse(fs.readFileSync(sessPath, 'utf-8')) as LiveSession;

    const anyErr = label.steps.some((s) => s.has_error);
    if (!anyErr) {
      perfectRuns += 1;
      falseAlarmsOnPerfect += sess.alerts_history.length;
    }

    // Alert latency for labeled mistakes that triggered an alert
    const alertByStep = new Map(sess.alerts_history.map((a) => [a.step_id, a]));
    for (const ls of label.steps) {
      if (ls.has_error && ls.mistake_t_s != null) {
        const alert = alertByStep.get(ls.step_id);
        if (alert) {
          alertLatencies.push(Number(Math.max(0, alert.t_s - ls.mistake_t_s).toFixed(2)));
        }
      }
    }

    const totalDur = sess.ticks.length > 0 ? sess.ticks[sess.ticks.length - 1].t_s : 0;
    golds.push({
      recording_id: label.session_id,
      activity_id: sess.procedure.procedure_id,
      is_error: anyErr,
      duration_s: totalDur,
      steps: label.steps.map((s) => ({
        step_id: s.step_id,
        has_error: s.has_error,
        categories: s.categories,
        start_s: s.mistake_t_s ?? null,
        end_s: null,
        description: '',
      })),
    });

    const compartmentMismatch = Boolean(
      sess.final_report && !sess.final_report.all_compartments_match,
    );
    const stateByStep = new Map(sess.step_states.map((st) => [st.step_id, st]));

    results.push({
      run_id: sess.session_id,
      system: 'misstep_live',
      config_version: 'live',
      recording_id: label.session_id,
      procedure_id: sess.procedure.procedure_id,
      windows: [],
      checks: [],
      verdicts: sess.procedure.steps.map((step) => {
        const st = stateByStep.get(step.step_id);
        const isSkipped = st?.status === 'skipped' || st?.late;
        const isCountStep =
          compartmentMismatch && /tablet|blue|red|compartment/i.test(step.text);
        const isErr = Boolean(isSkipped || isCountStep);
        const cats: ErrorCategory[] = [];
        if (isSkipped) cats.push(st?.alerted ? 'order' : 'missing_step');
        if (isCountStep) cats.push('measurement');

        return {
          step_id: step.step_id,
          status: isErr ? 'error' : 'ok',
          categories: cats,
          p_error: isErr ? 0.9 : 0.1,
          decided_by: 'rules',
          evidence: [],
        };
      }),
      cost_usd: sess.total_cost_usd,
      latency_s:
        sess.ticks.length > 0
          ? sess.ticks.reduce((a, t) => a + t.latency_ms, 0) / sess.ticks.length / 1000
          : 0,
      errors: [],
    });
  }

  const scores = golds.length > 0 ? scoreSystem('misstep_live', golds, results) : null;
  const sortedLat = [...alertLatencies].sort((a, b) => a - b);

  return {
    runs_scored: golds.length,
    scores,
    alert_latencies_s: alertLatencies,
    mean_alert_latency_s:
      alertLatencies.length > 0
        ? Number((alertLatencies.reduce((a, b) => a + b, 0) / alertLatencies.length).toFixed(2))
        : null,
    median_alert_latency_s:
      sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length / 2)] : null,
    perfect_runs: perfectRuns,
    false_alarms_per_perfect_run:
      perfectRuns > 0 ? Number((falseAlarmsOnPerfect / perfectRuns).toFixed(2)) : 0,
  };
}
