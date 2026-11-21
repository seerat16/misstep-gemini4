const procTextEl = document.getElementById('procText');
const procFileEl = document.getElementById('procFile');
const videoFileEl = document.getElementById('videoFile');
const optNoCarbonEl = document.getElementById('optNoCarbon');
const optNoLocalizerEl = document.getElementById('optNoLocalizer');
const loadMedprepBtn = document.getElementById('loadMedprepBtn');
const compileOnlyBtn = document.getElementById('compileOnlyBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const errorBox = document.getElementById('errorBox');
const analyzeProgress = document.getElementById('analyzeProgress');
const resultsSection = document.getElementById('resultsSection');
const runKpis = document.getElementById('runKpis');
const compiledSteps = document.getElementById('compiledSteps');
const verdictsBoard = document.getElementById('verdictsBoard');
const statusMeta = document.getElementById('statusMeta');

let medprepCardText = '';

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

function showProgress(msg) {
  analyzeProgress.textContent = msg;
  analyzeProgress.hidden = !msg;
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    medprepCardText = data.medprep_card || '';
    if (!procTextEl.value.trim() && medprepCardText) {
      procTextEl.value = medprepCardText;
    }
    statusMeta.textContent = `Config ${data.config_version} · Spend $${Number(data.spend_usd || 0).toFixed(3)} / $${data.max_usd} · ${data.frozen ? 'Frozen' : 'Dev'}`;
  } catch (err) {
    statusMeta.textContent = 'Server status unavailable';
  }
}

loadMedprepBtn.addEventListener('click', () => {
  if (medprepCardText) {
    procTextEl.value = medprepCardText;
    showError('');
  }
});

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderProcedureSteps(procedure) {
  compiledSteps.replaceChildren();
  for (const step of procedure.steps || []) {
    const card = createEl('div', 'step-card');
    const head = createEl('div', 'step-card-head');
    head.appendChild(createEl('span', 'step-title', `${step.step_id}: ${step.text}`));
    head.appendChild(createEl('span', 'state-label', step.checkable ? 'CHECKABLE' : 'NOT CHECKABLE'));
    card.appendChild(head);

    const meta = createEl('div', 'step-meta');
    if (step.quantity) {
      meta.appendChild(
        createEl('span', 'mono', `Qty: ${step.quantity.amount} ${step.quantity.unit} ${step.quantity.item}`),
      );
    }
    if (step.must_follow && step.must_follow.length > 0) {
      meta.appendChild(createEl('span', 'mono', `After: ${step.must_follow.join(', ')}`));
    }
    if (step.checks && step.checks.length > 0) {
      meta.appendChild(
        createEl('span', '', `Checks: ${step.checks.map((c) => `[${c.category}] ${c.text}`).join(' | ')}`),
      );
    }
    card.appendChild(meta);
    compiledSteps.appendChild(card);
  }
}

function renderRunResult(result, procedure) {
  resultsSection.hidden = false;
  renderProcedureSteps(procedure);

  const errCount = (result.verdicts || []).filter((v) => v.status === 'error').length;
  const uncCount = (result.verdicts || []).filter((v) => v.status === 'uncertain').length;

  runKpis.replaceChildren();
  const kpis = [
    ['System', result.system],
    ['Errors Detected', `${errCount} / ${(result.verdicts || []).length}`],
    ['Uncertain', `${uncCount}`],
    ['Run Cost', `$${Number(result.cost_usd || 0).toFixed(4)}`],
    ['Latency', `${Number(result.latency_s || 0).toFixed(1)} s`],
  ];
  for (const [label, val] of kpis) {
    const card = createEl('div', 'kpi-card');
    card.appendChild(createEl('div', 'kpi-label', label));
    card.appendChild(createEl('div', 'kpi-value', val));
    runKpis.appendChild(card);
  }

  const winByStep = new Map((result.windows || []).map((w) => [w.step_id, w]));
  const stepTextById = new Map((procedure.steps || []).map((s) => [s.step_id, s.text]));

  verdictsBoard.replaceChildren();
  for (const v of result.verdicts || []) {
    const card = createEl('div', `step-card status-${v.status}`);
    const head = createEl('div', 'step-card-head');
    head.appendChild(
      createEl('span', 'step-title', `${v.step_id}: ${stepTextById.get(v.step_id) || v.step_id}`),
    );
    const catSuffix = v.categories && v.categories.length > 0 ? ` (${v.categories.join(', ')})` : '';
    head.appendChild(
      createEl(
        'span',
        'state-label',
        `${v.status.toUpperCase()}${catSuffix} · p=${Number(v.p_error).toFixed(2)}`,
      ),
    );
    card.appendChild(head);

    const meta = createEl('div', 'step-meta');
    const win = winByStep.get(v.step_id);
    if (win && win.found) {
      meta.appendChild(
        createEl('span', 'mono', `Window: ${Number(win.start_s).toFixed(1)}s–${Number(win.end_s).toFixed(1)}s`),
      );
    } else {
      meta.appendChild(createEl('span', 'mono', 'Window: not localized'));
    }
    meta.appendChild(createEl('span', 'mono', `Decided by: ${v.decided_by}`));
    for (const ev of v.evidence || []) {
      const ts = ev.t_s !== null && ev.t_s !== undefined ? `@${Number(ev.t_s).toFixed(1)}s: ` : '';
      meta.appendChild(createEl('span', '', `${ts}${ev.text}`));
    }
    card.appendChild(meta);
    verdictsBoard.appendChild(card);
  }
}

compileOnlyBtn.addEventListener('click', async () => {
  showError('');
  showProgress('Compiling procedure with Gemini 4 Neon and pre-generating TTS alerts...');
  compileOnlyBtn.disabled = true;
  try {
    const fd = new FormData();
    if (procFileEl.files && procFileEl.files[0]) {
      fd.append('file', procFileEl.files[0]);
    } else if (procTextEl.value.trim() === medprepCardText.trim() && medprepCardText) {
      fd.append('preset', 'medprep');
    } else {
      fd.append('text', procTextEl.value.trim());
    }
    const res = await fetch('/api/procedure', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Compilation failed');
    resultsSection.hidden = false;
    renderProcedureSteps(data.procedure);
    verdictsBoard.replaceChildren(
      createEl('p', 'muted', `Compiled ${data.procedure.steps.length} steps. Session ${data.session_id} ready for live mode.`),
    );
    showProgress('');
    fetchStatus();
  } catch (err) {
    showProgress('');
    showError(err.message);
  } finally {
    compileOnlyBtn.disabled = false;
  }
});

analyzeBtn.addEventListener('click', async () => {
  showError('');
  if (!videoFileEl.files || !videoFileEl.files[0]) {
    showError('Please choose a recorded video file first.');
    return;
  }
  analyzeBtn.disabled = true;
  showProgress('Uploading video and running Misstep pipeline (Neon -> Hydrogen -> Decisions -> Rules -> Carbon)...');
  try {
    const fd = new FormData();
    fd.append('video', videoFileEl.files[0]);
    if (procFileEl.files && procFileEl.files[0]) {
      fd.append('procedure_file', procFileEl.files[0]);
    } else if (procTextEl.value.trim() === medprepCardText.trim() && medprepCardText) {
      fd.append('preset', 'medprep');
    } else {
      fd.append('procedure_text', procTextEl.value.trim());
    }
    fd.append('no_carbon', String(optNoCarbonEl.checked));
    fd.append('no_localizer', String(optNoLocalizerEl.checked));

    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');
    renderRunResult(data.result, data.procedure);
    showProgress('');
    fetchStatus();
  } catch (err) {
    showProgress('');
    showError(err.message);
  } finally {
    analyzeBtn.disabled = false;
  }
});

if (loadSampleBtn) {
  loadSampleBtn.addEventListener('click', async () => {
    showError('');
    loadSampleBtn.disabled = true;
    showProgress('Loading verified CaptainCook4D dev analysis (frozen v4 pipeline)...');
    try {
      const res = await fetch('/api/sample-analysis');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load sample analysis');
      if (data.procedure_text) {
        procTextEl.value = data.procedure_text;
      }
      renderRunResult(data.result, data.procedure);
      showProgress(
        `Loaded real CaptainCook4D recording ${data.result.recording_id} (${data.procedure.steps.length} compiled steps · Neon + Hydrogen + Decisions API + Carbon).`,
      );
    } catch (err) {
      showProgress('');
      showError(err.message);
    } finally {
      loadSampleBtn.disabled = false;
    }
  });
}

fetchStatus();
