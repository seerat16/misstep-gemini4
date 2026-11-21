const ALL_CATEGORIES = [
  'missing_step',
  'order',
  'measurement',
  'technique',
  'preparation',
  'timing',
  'temperature',
  'other',
];

const reviewError = document.getElementById('reviewError');
const reviewNotice = document.getElementById('reviewNotice');
const reloadSessionsBtn = document.getElementById('reloadSessionsBtn');
const fieldSummaryKpis = document.getElementById('fieldSummaryKpis');
const sessionsList = document.getElementById('sessionsList');
const sessionFramesPanel = document.getElementById('sessionFramesPanel');
const alertSummaryBox = document.getElementById('alertSummaryBox');
const ticksList = document.getElementById('ticksList');
const labelPanel = document.getElementById('labelPanel');
const labelPanelTitle = document.getElementById('labelPanelTitle');
const mistakeSlipInput = document.getElementById('mistakeSlipInput');
const labelStepsContainer = document.getElementById('labelStepsContainer');
const saveLabelBtn = document.getElementById('saveLabelBtn');

let sessionsCache = [];
let fieldLabelsBySession = new Map();
let activeSession = null;

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function showError(msg) {
  reviewError.textContent = msg;
  reviewError.hidden = !msg;
}

function showNotice(msg) {
  reviewNotice.textContent = msg;
  reviewNotice.hidden = !msg;
}

function renderSummaryKpis(summary) {
  fieldSummaryKpis.replaceChildren();
  const scores = summary && summary.scores ? summary.scores : null;
  const f1Text = scores ? `${(scores.f1.value * 100).toFixed(1)}%` : 'N/A';
  const precText = scores ? `${(scores.precision.value * 100).toFixed(1)}%` : 'N/A';
  const recText = scores ? `${(scores.recall.value * 100).toFixed(1)}%` : 'N/A';
  const latText =
    summary && summary.median_alert_latency_s !== null && summary.median_alert_latency_s !== undefined
      ? `${summary.median_alert_latency_s} s`
      : 'N/A';

  const cards = [
    ['Labeled Field Runs', `${summary?.runs_scored ?? 0}`],
    ['Field Step F1', `${f1Text}`],
    ['Precision / Recall', `${precText} / ${recText}`],
    ['Median Alert Latency', latText],
    [
      'False Alarms / Perfect Run',
      `${summary?.false_alarms_per_perfect_run ?? 0} (${summary?.perfect_runs ?? 0} clean)`,
    ],
  ];

  for (const [label, val] of cards) {
    const c = createEl('div', 'kpi-card');
    c.appendChild(createEl('div', 'kpi-label', label));
    c.appendChild(createEl('div', 'kpi-value', val));
    fieldSummaryKpis.appendChild(c);
  }
}

async function fetchSummary() {
  try {
    const res = await fetch('/api/field/summary');
    if (res.ok) {
      const data = await res.json();
      renderSummaryKpis(data);
    }
  } catch {
    // ignore
  }
}

function renderSessionsList() {
  sessionsList.replaceChildren();
  if (sessionsCache.length === 0) {
    sessionsList.appendChild(
      createEl('p', 'muted', 'No live sessions recorded yet. Run a session in Live Monitor first.'),
    );
    return;
  }

  for (const s of sessionsCache) {
    const isLabeled = fieldLabelsBySession.has(s.session_id);
    const isSelected = activeSession && activeSession.session_id === s.session_id;
    const card = createEl(
      'div',
      `step-card ${isSelected ? 'status-in_progress' : isLabeled ? 'status-done' : ''}`,
    );

    const head = createEl('div', 'step-card-head');
    head.appendChild(createEl('span', 'step-title', `${s.procedure_title || s.procedure_id}`));
    head.appendChild(createEl('span', 'state-label', isLabeled ? 'LABELED' : 'UNLABELED'));
    card.appendChild(head);

    const meta = createEl('div', 'step-meta');
    meta.appendChild(createEl('span', 'mono', s.session_id));
    meta.appendChild(createEl('span', 'mono', `Ticks: ${s.tick_count}`));
    meta.appendChild(createEl('span', 'mono', `Alerts: ${s.alert_count}`));
    meta.appendChild(createEl('span', 'mono', s.has_final_report ? 'Organizer verified' : 'No final still'));
    card.appendChild(meta);

    const btnRow = createEl('div', 'btn-row');
    btnRow.style.marginTop = '10px';
    const inspectBtn = createEl('button', 'btn btn-secondary', 'Inspect & Label');
    inspectBtn.type = 'button';
    inspectBtn.addEventListener('click', () => loadSessionDetail(s.session_id));
    btnRow.appendChild(inspectBtn);
    card.appendChild(btnRow);

    sessionsList.appendChild(card);
  }
}

function renderTicksAndAlerts(sess) {
  sessionFramesPanel.hidden = false;
  alertSummaryBox.replaceChildren();

  if (sess.alerts_history && sess.alerts_history.length > 0) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Time', 'Tick', 'Step', 'Alert Text', 'Reason']) {
      hr.appendChild(createEl('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const a of sess.alerts_history) {
      const tr = document.createElement('tr');
      tr.appendChild(createEl('td', 'mono', `${a.t_s}s`));
      tr.appendChild(createEl('td', 'mono', `#${a.tick}`));
      tr.appendChild(createEl('td', 'mono', a.step_id));
      tr.appendChild(createEl('td', '', a.text));
      tr.appendChild(createEl('td', 'muted', a.reason));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    alertSummaryBox.appendChild(table);
  } else {
    alertSummaryBox.appendChild(createEl('p', 'muted', 'No spoken alerts fired during this session.'));
  }

  if (sess.final_report) {
    const compInfo = createEl(
      'div',
      sess.final_report.all_compartments_match ? 'info-banner' : 'alert-banner',
      `Organizer final check: ${
        sess.final_report.all_compartments_match
          ? 'All 8 compartments matched MedPrep card'
          : 'Compartment mismatch detected'
      } (${sess.final_report.compartments
        .filter((c) => !c.match)
        .map((c) => `${c.day} ${c.color}=${c.final_choice} vs ${c.expected}`)
        .join(', ') || 'all ok'})`,
    );
    compInfo.style.marginTop = '12px';
    alertSummaryBox.appendChild(compInfo);
  }

  ticksList.replaceChildren();
  const recentTicks = (sess.ticks || []).slice(-12);
  if (recentTicks.length === 0) {
    ticksList.appendChild(createEl('p', 'muted', 'No ticks saved in this session.'));
    return;
  }

  for (const tick of recentTicks) {
    const card = createEl('div', 'step-card');
    const head = createEl('div', 'step-card-head');
    head.appendChild(createEl('span', 'step-title mono', `Tick #${tick.tick} @ ${tick.t_s}s`));
    head.appendChild(
      createEl(
        'span',
        'state-label',
        `${tick.latency_ms} ms · $${Number(tick.cost_usd || 0).toFixed(4)}`,
      ),
    );
    card.appendChild(head);

    const tickName = `tick_${String(tick.tick).padStart(4, '0')}`;
    const strip = createEl('div', 'frames-strip');
    for (const fName of tick.frame_files || []) {
      const img = document.createElement('img');
      img.src = `/api/sessions/${encodeURIComponent(sess.session_id)}/frames/${encodeURIComponent(tickName)}/${encodeURIComponent(fName)}`;
      img.alt = `${tickName} ${fName}`;
      img.loading = 'lazy';
      strip.appendChild(img);
    }
    card.appendChild(strip);

    const activityChoice = tick.answers?.activity?.choice;
    if (activityChoice) {
      const meta = createEl('div', 'step-meta');
      meta.style.marginTop = '8px';
      meta.appendChild(createEl('span', 'mono', `Activity choice: ${activityChoice}`));
      card.appendChild(meta);
    }
    ticksList.appendChild(card);
  }
}

function renderLabelForm(sess) {
  labelPanel.hidden = false;
  labelPanelTitle.textContent = `Label Session: ${sess.session_id}`;

  const existing = fieldLabelsBySession.get(sess.session_id);
  mistakeSlipInput.value = existing?.intended_mistake_note || '';
  const existingByStep = new Map((existing?.steps || []).map((s) => [s.step_id, s]));
  const stateByStep = new Map((sess.step_states || []).map((s) => [s.step_id, s]));

  labelStepsContainer.replaceChildren();
  for (const step of sess.procedure.steps || []) {
    const prev = existingByStep.get(step.step_id);
    const st = stateByStep.get(step.step_id);
    const card = createEl('div', `step-card status-${st ? st.status : 'pending'}`);
    card.dataset.stepId = step.step_id;

    const head = createEl('div', 'step-card-head');
    head.appendChild(createEl('span', 'step-title', `${step.step_id}: ${step.text}`));
    head.appendChild(
      createEl(
        'span',
        'state-label',
        st ? `${st.status.toUpperCase()}${st.late ? ' (LATE)' : ''}` : 'UNKNOWN',
      ),
    );
    card.appendChild(head);

    const controls = createEl('div', 'btn-row');
    controls.style.marginTop = '8px';

    const errLabel = document.createElement('label');
    errLabel.style.display = 'flex';
    errLabel.style.alignItems = 'center';
    errLabel.style.gap = '6px';
    errLabel.style.fontWeight = '600';
    errLabel.style.fontSize = '13px';
    const errCb = document.createElement('input');
    errCb.type = 'checkbox';
    errCb.className = 'step-has-error';
    errCb.checked = Boolean(prev?.has_error);
    errLabel.appendChild(errCb);
    errLabel.appendChild(document.createTextNode('Step has error'));
    controls.appendChild(errLabel);

    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.step = '0.5';
    timeInput.min = '0';
    timeInput.placeholder = 'Mistake t (s)';
    timeInput.className = 'step-mistake-ts';
    timeInput.style.width = '140px';
    if (prev?.mistake_t_s !== null && prev?.mistake_t_s !== undefined) {
      timeInput.value = String(prev.mistake_t_s);
    }
    controls.appendChild(timeInput);
    card.appendChild(controls);

    const catsRow = createEl('div', 'btn-row');
    catsRow.style.marginTop = '8px';
    const selectedCats = new Set(prev?.categories || []);
    for (const cat of ALL_CATEGORIES) {
      const cl = document.createElement('label');
      cl.style.display = 'flex';
      cl.style.alignItems = 'center';
      cl.style.gap = '4px';
      cl.style.fontSize = '12px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'step-cat-cb';
      cb.value = cat;
      cb.checked = selectedCats.has(cat);
      cl.appendChild(cb);
      cl.appendChild(document.createTextNode(cat));
      catsRow.appendChild(cl);
    }
    card.appendChild(catsRow);
    labelStepsContainer.appendChild(card);
  }
}

async function loadSessionDetail(sessionId) {
  showError('');
  showNotice('');
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const sess = await res.json();
    if (!res.ok) throw new Error(sess.error || 'Failed to load session');
    activeSession = sess;
    renderSessionsList();
    renderTicksAndAlerts(sess);
    renderLabelForm(sess);
  } catch (err) {
    showError(err.message);
  }
}

async function loadSessions() {
  showError('');
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch sessions');
    sessionsCache = data.sessions || [];
    fieldLabelsBySession = new Map((data.field_labels || []).map((l) => [l.session_id, l]));
    renderSessionsList();
    if (activeSession) {
      renderLabelForm(activeSession);
    } else if (sessionsCache.length > 0) {
      await loadSessionDetail(sessionsCache[0].session_id);
    }
  } catch (err) {
    showError(err.message);
  }
}

saveLabelBtn.addEventListener('click', async () => {
  if (!activeSession) return;
  showError('');
  showNotice('');
  saveLabelBtn.disabled = true;
  try {
    const stepCards = labelStepsContainer.querySelectorAll('.step-card');
    const steps = [];
    for (const card of stepCards) {
      const stepId = card.dataset.stepId;
      const hasErr = card.querySelector('.step-has-error').checked;
      const tVal = card.querySelector('.step-mistake-ts').value.trim();
      const cats = Array.from(card.querySelectorAll('.step-cat-cb:checked')).map((el) => el.value);
      steps.push({
        step_id: stepId,
        has_error: hasErr,
        categories: hasErr ? (cats.length > 0 ? cats : ['other']) : [],
        mistake_t_s: tVal ? Number(tVal) : null,
      });
    }

    const payload = {
      session_id: activeSession.session_id,
      labeled_at: new Date().toISOString(),
      intended_mistake_note: mistakeSlipInput.value.trim(),
      steps,
    };

    const res = await fetch('/api/field/label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save label');

    fieldLabelsBySession.set(activeSession.session_id, payload);
    if (data.summary) renderSummaryKpis(data.summary);
    renderSessionsList();
    showNotice(`Saved field ground truth for ${activeSession.session_id}.`);
  } catch (err) {
    showError(err.message);
  } finally {
    saveLabelBtn.disabled = false;
  }
});

reloadSessionsBtn.addEventListener('click', () => {
  loadSessions();
  fetchSummary();
});

fetchSummary();
loadSessions();
