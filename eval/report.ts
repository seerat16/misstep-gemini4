import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getEnvSettings } from '../misstep/settings.js';
import { scoreFieldRuns, type FieldEvalSummary } from './field_eval.js';
import { findLatestRunDir, type FailureRecord } from './run_eval.js';
import type { EvalScoreReport } from './score.js';
import type { StressReport } from './stress.js';

export interface KnownFailureReportItem extends FailureRecord {
  still_url?: string;
  summary_sentence?: string;
}

export interface FullReportPayload {
  generated_at: string;
  split: 'dev' | 'test';
  systems: Record<string, EvalScoreReport>;
  changelog_md: string;
  field_eval: FieldEvalSummary;
  stress: StressReport | null;
  known_failures: KnownFailureReportItem[];
}

function readScoresFromLatest(split: 'dev' | 'test', system: string): EvalScoreReport | null {
  const dir = findLatestRunDir(split, system);
  if (!dir) return null;
  const p = path.join(dir, 'scores.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as EvalScoreReport;
}

export function collectReportData(preferredSplit: 'dev' | 'test' = 'test'): FullReportPayload {
  const { runsDir } = getEnvSettings();
  const systemsToCheck = [
    'B0',
    'B1',
    'B2',
    'misstep',
    'misstep-no-carbon',
    'misstep-no-localizer',
    'misstep-decisions-only-full',
  ];

  const systems: Record<string, EvalScoreReport> = {};
  let activeSplit: 'dev' | 'test' = preferredSplit;

  for (const sys of systemsToCheck) {
    const s = readScoresFromLatest(preferredSplit, sys);
    if (s) systems[sys] = s;
  }

  if (Object.keys(systems).length === 0 && preferredSplit === 'test') {
    activeSplit = 'dev';
    for (const sys of systemsToCheck) {
      const s = readScoresFromLatest('dev', sys);
      if (s) systems[sys] = s;
    }
  }

  const changelogPath = path.resolve('./docs/CHANGELOG_FIXES.md');
  const changelogMd = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf-8') : '';

  const fieldEval = scoreFieldRuns();

  const stressPath = path.join(runsDir, 'stress', 'report.json');
  const stress = fs.existsSync(stressPath)
    ? (JSON.parse(fs.readFileSync(stressPath, 'utf-8')) as StressReport)
    : null;

  const { dataDir } = getEnvSettings();
  const devMisstepDir = findLatestRunDir('dev', 'misstep');
  const knownFailures: KnownFailureReportItem[] = [];
  if (devMisstepDir) {
    const fPath = path.join(devMisstepDir, 'failures.jsonl');
    if (fs.existsSync(fPath)) {
      const stillDir = path.join(runsDir, 'report', 'stills');
      fs.mkdirSync(stillDir, { recursive: true });
      const seenCats = new Set<string>();
      const allFailures = fs
        .readFileSync(fPath, 'utf-8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FailureRecord);

      // Prefer 3 diverse failures across categories/kinds
      const picked: FailureRecord[] = [];
      for (const f of allFailures) {
        const key = `${f.kind}:${f.gold_categories[0] ?? 'none'}`;
        if (!seenCats.has(key)) {
          seenCats.add(key);
          picked.push(f);
        }
        if (picked.length >= 3) break;
      }
      for (const f of allFailures) {
        if (picked.length >= 3) break;
        if (!picked.includes(f)) picked.push(f);
      }

      for (const f of picked) {
        const item: KnownFailureReportItem = {
          ...f,
          summary_sentence:
            f.kind === 'FN'
              ? `Missed gold [${f.gold_categories.join(', ') || 'error'}] (predicted ${f.pred_status}, p_error=${f.p_error.toFixed(2)}).`
              : `False alarm [${f.pred_categories.join(', ') || 'error'}] on clean step (p_error=${f.p_error.toFixed(2)}).`,
        };
        const vidPath = path.join(dataDir, 'videos', `${f.recording_id}.mp4`);
        if (fs.existsSync(vidPath)) {
          const fname = `${f.recording_id}_${f.step_id}.jpg`.replace(/[^a-zA-Z0-9._-]/g, '_');
          const outStill = path.join(stillDir, fname);
          const mid =
            f.start_s != null && f.end_s != null
              ? (f.start_s + f.end_s) / 2
              : f.start_s ?? 10;
          if (!fs.existsSync(outStill)) {
            try {
              execFileSync(
                'ffmpeg',
                ['-y', '-ss', String(Math.max(0, mid)), '-i', vidPath, '-frames:v', '1', '-vf', 'scale=640:-2', outStill],
                { stdio: 'ignore' },
              );
            } catch {
              // ignore still extraction error
            }
          }
          if (fs.existsSync(outStill)) {
            item.still_url = `/api/report/stills/${fname}`;
          }
        }
        knownFailures.push(item);
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    split: activeSplit,
    systems,
    changelog_md: changelogMd,
    field_eval: fieldEval,
    stress,
    known_failures: knownFailures,
  };
}

export function generateEvalMarkdownAndHtml(preferredSplit: 'dev' | 'test' = 'test'): {
  markdownPath: string;
  htmlPath: string;
  payload: FullReportPayload;
} {
  const payload = collectReportData(preferredSplit);
  const { runsDir } = getEnvSettings();

  const lines: string[] = [
    '# Misstep Evaluation Results',
    '',
    `Generated: ${payload.generated_at} · Split: \`${payload.split}\``,
    '',
    '## 1. System Comparison (Step-Level & Recording-Level)',
    '',
    '| System | Recordings | Step F1 (95% CI) | Covered F1 | Coverage | AUROC | ECE | Mean Cost | Mean Latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const [name, s] of Object.entries(payload.systems)) {
    const pairedNote = s.paired_vs_b1
      ? ` (Δ vs B1: ${(s.paired_vs_b1.diff_f1 * 100).toFixed(1)} pts [${(
          s.paired_vs_b1.ci_low * 100
        ).toFixed(1)}, ${(s.paired_vs_b1.ci_high * 100).toFixed(1)}]${
          s.paired_vs_b1.significant ? ' *sig*' : ''
        })`
      : '';
    lines.push(
      `| ${name} | ${s.recordings} | ${(s.f1.value * 100).toFixed(1)}% [${(
        s.f1.ci_low * 100
      ).toFixed(1)}, ${(s.f1.ci_high * 100).toFixed(1)}]${pairedNote} | ${(
        s.covered_f1.value * 100
      ).toFixed(1)}% | ${(s.coverage.value * 100).toFixed(1)}% | ${s.auroc.value.toFixed(
        3,
      )} | ${s.ece.value.toFixed(3)} | $${s.mean_cost_usd.toFixed(3)} | ${s.mean_latency_s.toFixed(
        1,
      )}s |`,
    );
  }

  if (payload.systems.misstep) {
    lines.push('', '## 2. Per-Category Recall (Misstep)', '');
    lines.push('| Category | Gold Count | Category Recall | Detected Any Error | Note |');
    lines.push('|---|---:|---:|---:|---|');
    for (const row of payload.systems.misstep.per_category) {
      lines.push(
        `| ${row.category} | ${row.gold_count} | ${(row.category_recall * 100).toFixed(1)}% | ${(
          row.detected_any_error_recall * 100
        ).toFixed(1)}% | ${row.low_n ? 'low-n, reported but not claimed' : ''} |`,
      );
    }
  }

  lines.push('', '## 3. Field Evaluation (MedPrep Live)', '');
  lines.push(
    `- Labeled runs: ${payload.field_eval.runs_scored}`,
    `- Perfect runs: ${payload.field_eval.perfect_runs} · False alarms / perfect run: ${payload.field_eval.false_alarms_per_perfect_run}`,
    `- Median alert latency: ${payload.field_eval.median_alert_latency_s ?? 'N/A'} s`,
  );

  if (payload.stress) {
    lines.push('', '## 4. Stress Ladder', '');
    lines.push('| Condition | F1 | Relative to Clean | Breaking Point |');
    lines.push('|---|---:|---:|---|');
    for (const r of payload.stress.rows) {
      lines.push(
        `| ${r.condition} | ${(r.f1 * 100).toFixed(1)}% | ${(r.relative_to_clean * 100).toFixed(
          0,
        )}% | ${r.breaking_point ? 'YES (<50%)' : 'No'} |`,
      );
    }
  }

  const markdownPath = path.resolve('./docs/EVAL_RESULTS.md');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, lines.join('\n') + '\n', 'utf-8');

  const htmlDir = path.join(runsDir, 'report');
  fs.mkdirSync(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, 'index.html');
  fs.writeFileSync(htmlPath, renderStaticReportHtml(payload), 'utf-8');

  return { markdownPath, htmlPath, payload };
}

function renderStaticReportHtml(payload: FullReportPayload): string {
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Misstep — Evaluation Report</title>
  <link rel="stylesheet" href="/static/style.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
</head>
<body>
  <header class="topbar">
    <a href="/" class="brand">Misstep</a>
    <nav class="nav-links">
      <a href="/">Analyze</a>
      <a href="/static/live.html">Live Monitor</a>
      <a href="/static/review.html">Field Review</a>
      <a href="/static/report.html" class="active">Eval Report</a>
    </nav>
    <div class="topbar-action">
      <a href="/static/live.html" class="btn btn-primary">Launch Live Demo</a>
    </div>
  </header>
  <main class="container">
    <section class="page-head">
      <div>
        <h1>Evaluation & Calibration Report</h1>
        <p class="muted">Split: <strong>${payload.split}</strong> · Generated: <span class="mono">${payload.generated_at}</span></p>
      </div>
      <button id="refreshBtn" class="btn btn-secondary">Regenerate Report</button>
    </section>

    <section id="headlineGrid" class="kpi-grid"></section>

    <section class="grid-2">
      <div class="panel">
        <h2>Headline F1 & Covered F1</h2>
        <canvas id="f1Chart"></canvas>
      </div>
      <div class="panel">
        <h2>Reliability Diagram (ECE Calibration)</h2>
        <canvas id="eceChart"></canvas>
      </div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>Per-Category Recall</h2>
        <canvas id="catChart"></canvas>
      </div>
      <div class="panel">
        <h2>Cost vs. Latency per Recording</h2>
        <canvas id="costChart"></canvas>
      </div>
    </section>

    <section class="panel">
      <h2>Ablations & System Table</h2>
      <div id="systemsTable"></div>
    </section>

    <section class="grid-2">
      <div class="panel">
        <h2>Dev Improvement Trail (Antigravity Agent)</h2>
        <pre id="changelogBox" class="code-box"></pre>
      </div>
      <div class="panel">
        <h2>Field Eval & Stress Ladder</h2>
        <div id="fieldSummary"></div>
        <div id="stressTable"></div>
      </div>
    </section>

    <section class="panel">
      <h2>Known Failures (Concrete Examples)</h2>
      <div id="failuresList"></div>
    </section>
  </main>
  <script>
    const INITIAL_DATA = ${safeJson};
  </script>
  <script src="/static/report.js"></script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const splitIdx = argv.indexOf('--split');
  const split = splitIdx >= 0 && argv[splitIdx + 1] === 'dev' ? 'dev' : 'test';
  const out = generateEvalMarkdownAndHtml(split);
  console.log(`Generated ${out.markdownPath} and ${out.htmlPath}`);
}
