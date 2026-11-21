import {
  StepVerdictSchema,
  type ErrorCategory,
  type Evidence,
  type Procedure,
  type Step,
  type StepCheck,
  type StepVerdict,
  type StepWindow,
} from './schemas.js';
import type { PipelineConfig } from './settings.js';

export function evaluateSingleStep(
  step: Step,
  window: StepWindow | undefined,
  check: StepCheck | undefined,
  windowsById: Map<string, StepWindow>,
  config: PipelineConfig,
): StepVerdict {
  if (!step.checkable) {
    return StepVerdictSchema.parse({
      step_id: step.step_id,
      status: 'not_checkable',
      categories: [],
      p_error: 0,
      decided_by: 'rules',
      evidence: [{ t_s: null, text: 'Step marked not checkable by camera' }],
    });
  }

  const t = config.thresholds;
  const candidateCategories = new Set<ErrorCategory>();
  const candidateProbs: number[] = [];
  const evidence: Evidence[] = [];

  const pDoneFull = check?.p_done_full ?? 0.5;
  const found = Boolean(window?.found);

  // 1. missing_step
  if (!found && pDoneFull < t.missing_p_done_max) {
    const pMissing = 1 - pDoneFull;
    candidateProbs.push(pMissing);
    candidateCategories.add('missing_step');
    evidence.push({
      t_s: null,
      text: `Step not localized and full-video p_done_full=${pDoneFull.toFixed(2)} < ${t.missing_p_done_max}`,
    });
  } else if (!found && pDoneFull >= t.present_p_done_min) {
    // Localizer missed it, but Decisions thinks it happened => uncertain
    const pUnc = (t.uncertain_band[0] + t.uncertain_band[1]) / 2;
    return StepVerdictSchema.parse({
      step_id: step.step_id,
      status: 'uncertain',
      categories: [],
      p_error: pUnc,
      decided_by: 'rules',
      evidence: [
        {
          t_s: null,
          text: `Localizer missed step, but full-video Decisions p_done_full=${pDoneFull.toFixed(2)} >= ${t.present_p_done_min}`,
        },
      ],
    });
  } else if (!found) {
    candidateProbs.push(1 - pDoneFull);
  }

  // 2. order constraints
  if (found && window?.start_s != null) {
    for (const predId of step.must_follow) {
      const predWin = windowsById.get(predId);
      if (predWin?.found && predWin.end_s != null) {
        if (window.start_s < predWin.end_s - t.order_tolerance_s) {
          candidateCategories.add('order');
          candidateProbs.push(0.9);
          evidence.push({
            t_s: window.start_s,
            text: `Started at ${window.start_s.toFixed(1)}s before predecessor ${predId} finished at ${predWin.end_s.toFixed(1)}s`,
          });
        }
      }
    }
  }

  // 3. measurement
  if (step.quantity && check?.measurement_probs) {
    const mp = check.measurement_probs;
    const pErrMeas = (mp.less ?? 0) + (mp.more ?? 0);
    const pCannotTell = mp.cannot_tell ?? 0;
    candidateProbs.push(pErrMeas);
    if (pErrMeas >= t.measurement_error_min && pCannotTell < 0.5) {
      candidateCategories.add('measurement');
      evidence.push({
        t_s: window?.start_s ?? null,
        text: `Measurement P(less+more)=${pErrMeas.toFixed(2)} (cannot_tell=${pCannotTell.toFixed(2)})`,
      });
    } else if (pCannotTell >= 0.5) {
      // Unreadable measurement pushes toward uncertain band if not already an error
      candidateProbs.push((t.uncertain_band[0] + t.uncertain_band[1]) / 2);
    }
  }

  // 4. visual checks
  for (const vc of step.checks) {
    const pTrue = check?.check_p_true?.[vc.check_id];
    if (pTrue === undefined) continue;
    const pFalse = 1 - pTrue;
    candidateProbs.push(pFalse);
    if (pFalse >= t.check_false_min) {
      candidateCategories.add(vc.category);
      evidence.push({
        t_s: window?.start_s ?? null,
        text: `Visual check "${vc.text}" failed (1-P(true)=${pFalse.toFixed(2)})`,
      });
    }
  }

  // Baseline probability when step is present and no checks fired
  if (candidateProbs.length === 0) {
    candidateProbs.push(Math.max(0.01, Math.min(0.99, 1 - (check?.p_done_clip ?? pDoneFull))));
  }

  const pError = Math.max(0, Math.min(1, Math.max(...candidateProbs)));
  const [uncLow, uncHigh] = t.uncertain_band;

  let status: 'ok' | 'error' | 'uncertain' = 'ok';
  if (candidateCategories.size > 0) {
    status = 'error';
  } else if (pError >= uncLow && pError <= uncHigh) {
    status = 'uncertain';
    evidence.push({
      t_s: window?.start_s ?? null,
      text: `p_error=${pError.toFixed(2)} inside uncertain band [${uncLow}, ${uncHigh}]`,
    });
  } else {
    evidence.push({
      t_s: window?.start_s ?? null,
      text: found
        ? `Observed at ${window?.start_s?.toFixed(1)}s–${window?.end_s?.toFixed(1)}s`
        : `p_done_full=${pDoneFull.toFixed(2)}`,
    });
  }

  return StepVerdictSchema.parse({
    step_id: step.step_id,
    status,
    categories: Array.from(candidateCategories),
    p_error: Number(pError.toFixed(4)),
    decided_by: 'rules',
    evidence,
  });
}

export function evaluateSteps(
  procedure: Procedure,
  windows: StepWindow[],
  checks: StepCheck[],
  config: PipelineConfig,
): StepVerdict[] {
  const windowsById = new Map(windows.map((w) => [w.step_id, w]));
  const checksById = new Map(checks.map((c) => [c.step_id, c]));

  return procedure.steps.map((step) =>
    evaluateSingleStep(
      step,
      windowsById.get(step.step_id),
      checksById.get(step.step_id),
      windowsById,
      config,
    ),
  );
}

export function applyCarbonDecision(
  verdict: StepVerdict,
  carbon: {
    verdict: 'error' | 'ok' | 'cannot_tell';
    categories: ErrorCategory[];
    rationale: string;
    evidence_s?: number | null;
  },
  canVetoErrors = true,
  canCreateErrorsFromOk = false,
): StepVerdict {
  if (verdict.status === 'ok' && !canCreateErrorsFromOk) {
    return verdict;
  }
  if (verdict.status === 'not_checkable') {
    return verdict;
  }

  if (carbon.verdict === 'cannot_tell') {
    return {
      ...verdict,
      decided_by: 'carbon',
      evidence: [
        ...verdict.evidence,
        { t_s: carbon.evidence_s ?? null, text: `Carbon (cannot_tell): ${carbon.rationale}` },
      ],
    };
  }

  if (verdict.status === 'uncertain') {
    const newStatus = carbon.verdict === 'error' ? 'error' : 'ok';
    return {
      ...verdict,
      status: newStatus,
      categories: newStatus === 'error' ? carbon.categories : [],
      p_error: newStatus === 'error' ? Math.max(verdict.p_error, 0.85) : Math.min(verdict.p_error, 0.15),
      decided_by: 'carbon',
      evidence: [
        ...verdict.evidence,
        { t_s: carbon.evidence_s ?? null, text: `Carbon: ${carbon.rationale}` },
      ],
    };
  }

  if (verdict.status === 'error' && carbon.verdict === 'ok' && canVetoErrors) {
    return {
      ...verdict,
      status: 'ok',
      categories: [],
      p_error: Math.min(verdict.p_error, 0.15),
      decided_by: 'carbon',
      evidence: [
        ...verdict.evidence,
        { t_s: carbon.evidence_s ?? null, text: `Carbon vetoed error: ${carbon.rationale}` },
      ],
    };
  }

  // Confirmed error
  return {
    ...verdict,
    categories: carbon.categories.length > 0 ? carbon.categories : verdict.categories,
    p_error: Math.max(verdict.p_error, 0.9),
    decided_by: 'carbon',
    evidence: [
      ...verdict.evidence,
      { t_s: carbon.evidence_s ?? null, text: `Carbon confirmed: ${carbon.rationale}` },
    ],
  };
}
