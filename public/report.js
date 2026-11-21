const headlineGrid = document.getElementById('headlineGrid');
const systemsTable = document.getElementById('systemsTable');
const changelogBox = document.getElementById('changelogBox');
const fieldSummary = document.getElementById('fieldSummary');
const stressTable = document.getElementById('stressTable');
const failuresList = document.getElementById('failuresList');
const refreshBtn = document.getElementById('refreshBtn');

const charts = {};

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function pct(val) {
  return `${(Number(val || 0) * 100).toFixed(1)}%`;
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderHeadlines(payload) {
  headlineGrid.replaceChildren();
  const sys = payload.systems || {};
  const mis = sys.misstep;
  const b1 = sys.B1;
  const f1Delta = mis && mis.paired_vs_b1 ? `${(mis.paired_vs_b1.diff_f1 * 100).toFixed(1)} pts` : 'N/A';

  const items = [
    ['Active Split', `${payload.split || 'test'} (${Object.keys(sys).length} systems)`],
    ['Misstep Step F1', mis ? pct(mis.f1.value) : 'No eval run yet'],
    ['Misstep Covered F1 / Cov', mis ? `${pct(mis.covered_f1.value)} @ ${pct(mis.coverage.value)}` : 'N/A'],
    ['Delta F1 vs B1 (Hydrogen)', f1Delta],
    ['Misstep ECE / AUROC', mis ? `${mis.ece.value.toFixed(3)} / ${mis.auroc.value.toFixed(3)}` : 'N/A'],
    ['B1 Step F1', b1 ? pct(b1.f1.value) : 'No B1 run yet'],
  ];

  for (const [label, val] of items) {
    const card = createEl('div', 'kpi-card');
    card.appendChild(createEl('div', 'kpi-label', label));
    card.appendChild(createEl('div', 'kpi-value', val));
    headlineGrid.appendChild(card);
  }
}

function renderSystemsTable(payload) {
  systemsTable.replaceChildren();
  const entries = Object.entries(payload.systems || {});
  if (entries.length === 0) {
    systemsTable.appendChild(
      createEl(
        'p',
        'muted',
        'No offline evaluation runs found yet. Run baseline/misstep evaluation scripts on dev or frozen test.',
      ),
    );
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of [
    'System',
    'Recs',
    'Step F1 (95% CI)',
    'Covered F1',
    'Coverage',
    'AUROC',
    'ECE',
    'Mean Cost',
    'Mean Latency',
  ]) {
    hr.appendChild(createEl('th', '', h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const [name, s] of entries) {
    const tr = document.createElement('tr');
    tr.appendChild(createEl('td', 'mono', name));
    tr.appendChild(createEl('td', 'mono', String(s.recordings)));
    tr.appendChild(
      createEl('td', 'mono', `${pct(s.f1.value)} [${pct(s.f1.ci_low)}, ${pct(s.f1.ci_high)}]`),
    );
    tr.appendChild(createEl('td', 'mono', pct(s.covered_f1.value)));
    tr.appendChild(createEl('td', 'mono', pct(s.coverage.value)));
    tr.appendChild(createEl('td', 'mono', s.auroc.value.toFixed(3)));
    tr.appendChild(createEl('td', 'mono', s.ece.value.toFixed(3)));
    tr.appendChild(createEl('td', 'mono', `$${s.mean_cost_usd.toFixed(4)}`));
    tr.appendChild(createEl('td', 'mono', `${s.mean_latency_s.toFixed(1)}s`));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  systemsTable.appendChild(table);
}

function renderCharts(payload) {
  if (typeof Chart === 'undefined') return;
  const entries = Object.entries(payload.systems || {});
  const names = entries.map(([n]) => n);

  destroyChart('f1Chart');
  const f1Ctx = document.getElementById('f1Chart');
  if (f1Ctx && entries.length > 0) {
    charts.f1Chart = new Chart(f1Ctx, {
      type: 'bar',
      data: {
        labels: names,
        datasets: [
          {
            label: 'Step F1 (%)',
            data: entries.map(([, s]) => Number((s.f1.value * 100).toFixed(1))),
            backgroundColor: '#2563eb',
          },
          {
            label: 'Covered F1 (%)',
            data: entries.map(([, s]) => Number((s.covered_f1.value * 100).toFixed(1))),
            backgroundColor: '#059669',
          },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 100 } },
      },
    });
  }

  destroyChart('eceChart');
  const eceCtx = document.getElementById('eceChart');
  const mis = payload.systems?.misstep || entries[0]?.[1];
  const b1 = payload.systems?.B1;
  if (eceCtx && mis && mis.reliability_bins) {
    const binLabels = Array.from({ length: 10 }, (_, i) => `${i * 10 + 5}%`);
    const datasets = [
      {
        label: `Misstep (ECE=${mis.ece.value.toFixed(3)})`,
        data: mis.reliability_bins.map((b) => (b.count > 0 ? Number((b.mean_acc * 100).toFixed(1)) : null)),
        borderColor: '#2563eb',
        backgroundColor: '#2563eb',
        spanGaps: true,
        tension: 0.2,
      },
      {
        label: 'Ideal Calibration',
        data: binLabels.map((_, i) => i * 10 + 5),
        borderColor: '#94a3b8',
        borderDash: [5, 5],
        pointRadius: 0,
      },
    ];
    if (b1 && b1.reliability_bins && b1 !== mis) {
      datasets.splice(1, 0, {
        label: `B1 Hydrogen (ECE=${b1.ece.value.toFixed(3)})`,
        data: b1.reliability_bins.map((b) => (b.count > 0 ? Number((b.mean_acc * 100).toFixed(1)) : null)),
        borderColor: '#dc2626',
        backgroundColor: '#dc2626',
        spanGaps: true,
        tension: 0.2,
      });
    }
    charts.eceChart = new Chart(eceCtx, {
      type: 'line',
      data: {
        labels: binLabels,
        datasets,
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 100 } },
      },
    });
  }

  destroyChart('catChart');
  const catCtx = document.getElementById('catChart');
  if (catCtx && mis && mis.per_category) {
    charts.catChart = new Chart(catCtx, {
      type: 'bar',
      data: {
        labels: mis.per_category.map((c) => `${c.category}${c.low_n ? ' (low-n)' : ''}`),
        datasets: [
          {
            label: 'Exact Category Recall (%)',
            data: mis.per_category.map((c) => Number((c.category_recall * 100).toFixed(1))),
            backgroundColor: '#2563eb',
          },
          {
            label: 'Any-Error Recall (%)',
            data: mis.per_category.map((c) => Number((c.detected_any_error_recall * 100).toFixed(1))),
            backgroundColor: '#60a5fa',
          },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 100 } },
      },
    });
  }

  destroyChart('costChart');
  const costCtx = document.getElementById('costChart');
  if (costCtx && entries.length > 0) {
    charts.costChart = new Chart(costCtx, {
      type: 'scatter',
      data: {
        datasets: entries.map(([name, s], idx) => ({
          label: name,
          data: [{ x: s.mean_latency_s, y: Number((s.mean_cost_usd * 100).toFixed(2)) }],
          pointRadius: 7,
          backgroundColor: ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#475569'][idx % 7],
        })),
      },
      options: {
        responsive: true,
        scales: {
          x: { title: { display: true, text: 'Mean Latency (s)' } },
          y: { title: { display: true, text: 'Mean Cost (cents USD)' }, beginAtZero: true },
        },
      },
    });
  }
}

function renderSidePanels(payload) {
  changelogBox.textContent = payload.changelog_md || 'No Antigravity failure-analyst entries logged yet.';

  fieldSummary.replaceChildren();
  const fe = payload.field_eval;
  if (fe && fe.runs_scored > 0) {
    const line = createEl(
      'p',
      '',
      `Labeled live runs: ${fe.runs_scored} · Step F1: ${fe.scores ? pct(fe.scores.f1.value) : 'N/A'} · Perfect runs: ${fe.perfect_runs} · False alarms/perfect run: ${fe.false_alarms_per_perfect_run} · Median alert latency: ${fe.median_alert_latency_s ?? 'N/A'} s`,
    );
    fieldSummary.appendChild(line);
  } else {
    fieldSummary.appendChild(createEl('p', 'muted', 'No field-labeled live runs scored yet.'));
  }

  stressTable.replaceChildren();
  if (payload.stress && payload.stress.rows && payload.stress.rows.length > 0) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Stress Condition', 'Step F1', 'Rel to Clean', 'Breaking Point']) {
      hr.appendChild(createEl('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const r of payload.stress.rows) {
      const tr = document.createElement('tr');
      tr.appendChild(createEl('td', 'mono', r.condition));
      tr.appendChild(createEl('td', 'mono', pct(r.f1)));
      tr.appendChild(createEl('td', 'mono', `${(r.relative_to_clean * 100).toFixed(0)}%`));
      tr.appendChild(createEl('td', 'mono', r.breaking_point ? 'YES (<50%)' : 'No'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    stressTable.appendChild(table);
  } else {
    stressTable.appendChild(createEl('p', 'muted', 'Stress ladder has not been run yet.'));
  }

  failuresList.replaceChildren();
  const failures = payload.known_failures || [];
  if (failures.length === 0) {
    failuresList.appendChild(createEl('p', 'muted', 'No logged dev failure examples yet.'));
  } else {
    for (const f of failures) {
      const card = createEl('div', 'step-card status-error');
      const head = createEl('div', 'step-card-head');
      head.appendChild(createEl('span', 'step-title mono', `${f.recording_id} · step ${f.step_id} (${f.kind || f.failure_type || 'ERR'})`));
      head.appendChild(createEl('span', 'state-label', `p_error=${Number(f.p_error || 0).toFixed(2)}`));
      card.appendChild(head);
      if (f.still_url) {
        const img = document.createElement('img');
        img.src = f.still_url;
        img.alt = `Failure frame ${f.recording_id} step ${f.step_id}`;
        img.style.width = '100%';
        img.style.maxWidth = '360px';
        img.style.borderRadius = '6px';
        img.style.margin = '8px 0';
        card.appendChild(img);
      }
      const meta = createEl('div', 'step-meta');
      meta.appendChild(createEl('span', '', `Step: ${f.step_text}`));
      meta.appendChild(createEl('span', 'mono', `Gold: [${(f.gold_categories || []).join(', ')}] vs Pred: ${f.pred_status} [${(f.pred_categories || []).join(', ')}]`));
      if (f.summary_sentence) meta.appendChild(createEl('span', '', f.summary_sentence));
      card.appendChild(meta);
      failuresList.appendChild(card);
    }
  }
}

function renderAll(payload) {
  renderHeadlines(payload);
  renderSystemsTable(payload);
  renderCharts(payload);
  renderSidePanels(payload);
}

if (typeof INITIAL_DATA !== 'undefined') {
  renderAll(INITIAL_DATA);
} else {
  fetch('/api/report/data')
    .then((r) => r.json())
    .then((data) => renderAll(data))
    .catch(() => {});
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/report/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ split: 'test' }),
      });
      const data = await res.json();
      if (res.ok && data.payload) {
        renderAll(data.payload);
      }
    } finally {
      refreshBtn.disabled = false;
    }
  });
}
