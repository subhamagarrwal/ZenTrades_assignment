'use strict';

const $ = (id) => document.getElementById(id);

const companyEl   = $('company');
const accountIdEl = $('account-id');

const v1FileEl   = $('v1-file');
const v1FnameEl  = $('v1-fname');
const v1RunEl    = $('v1-run');
const v1LogsEl   = $('v1-logs');
const v1ResultEl = $('v1-result');
const v1TimerEl  = $('v1-timer');

const v2El       = $('v2');
const v2FileEl   = $('v2-file');
const v2FnameEl  = $('v2-fname');
const v2FormEl   = $('v2-form');
const v2RunEl    = $('v2-run');
const v2LogsEl   = $('v2-logs');
const v2ResultEl = $('v2-result');
const v2TimerEl  = $('v2-timer');

const changelogSection = $('changelog-section');
const changelogContent = $('changelog-content');
const batchSection     = $('batch-section');
const batchStatusLabel = $('batch-status-label');
const batchAccounts    = $('batch-accounts');

let v1Running = false;
let v2Running = false;
let v1Done    = false;
let _batchPollId = null;
let _lastBatchSnapshot = '';
let _stableCount = 0;          // how many polls with no change
let _batchEverActive = false;  // did we detect activity at least once?
const STABLE_THRESHOLD = 4;    // hide after 4 polls (~12s) of no change

const getCompany   = () => companyEl.value.trim();
const getAccountId = () => accountIdEl.value.trim() || getCompany();

function sync() {
  const c = !!getCompany();
  v1RunEl.disabled = !c || !v1FileEl.files.length || v1Running;
  v2RunEl.disabled = !c || (!v2FileEl.files.length && !v2FormEl.value.trim()) || v2Running || !v1Done;
}

function log(panel, text, cls = 'log-line') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

function clearLog(panel) {
  panel.innerHTML = '';
}

function startTimer(el) {
  const t0 = Date.now();
  el.textContent = '0.0s';
  const id = setInterval(() => {
    el.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  }, 100);
  return () => clearInterval(id);
}

async function runPipeline(url, formData, logPanel, resultEl, timerEl) {
  clearLog(logPanel);
  logPanel.classList.add('visible');
  resultEl.textContent = '';
  resultEl.className = 'result';

  const stop = startTimer(timerEl);

  try {
    const resp = await fetch(url, { method: 'POST', body: formData });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      log(logPanel, `Error: ${err.error}`, 'log-error');
      resultEl.textContent = 'Failed';
      resultEl.classList.add('fail');
      stop();
      return null;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'log') {
            const cls = /STEP|═/.test(ev.text) ? 'log-step' : 'log-line';
            log(logPanel, ev.text, cls);
          } else if (ev.type === 'error') {
            log(logPanel, ev.text, 'log-error');
          } else if (ev.type === 'done') {
            result = ev;
          }
        } catch { /* skip malformed SSE */ }
      }
    }

    stop();

    if (result) {
      timerEl.textContent = result.duration + 's';
      if (result.code === 0) {
        resultEl.textContent = '\u2713 Complete';
        resultEl.classList.add('ok');
      } else {
        resultEl.textContent = `\u2717 Exit code ${result.code}`;
        resultEl.classList.add('fail');
      }
    }

    return result;
  } catch (err) {
    stop();
    log(logPanel, `Network error: ${err.message}`, 'log-error');
    resultEl.textContent = 'Failed';
    resultEl.classList.add('fail');
    return null;
  }
}

function formatVal(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v, null, 1);
  return String(v);
}

function renderChangelog(data, container) {
  container.innerHTML = '';
  if (!data || !data.history || data.history.length === 0) {
    container.innerHTML = '<p style="font-size:0.75rem;color:#999;">No changes recorded.</p>';
    return;
  }

  for (const entry of data.history) {
    const div = document.createElement('div');
    div.className = 'cl-entry';

    const ts = entry.generated_at ? new Date(entry.generated_at).toLocaleString() : '';
    div.innerHTML = `
      <div class="cl-entry-header">
        <span class="cl-version">${entry.version_from} → ${entry.version_to}</span>
        <span class="cl-source">${entry.source || ''} &middot; ${ts}</span>
      </div>`;

    if (entry.changes && entry.changes.length > 0) {
      for (const c of entry.changes) {
        const row = document.createElement('div');
        row.className = 'cl-change';
        row.innerHTML = `
          <span class="cl-field">${c.field}</span>
          <span class="cl-note">${c.note || ''}</span><br>
          <span class="cl-before">- <span class="cl-val">${escHTML(formatVal(c.before))}</span></span><br>
          <span class="cl-after">+ <span class="cl-val">${escHTML(formatVal(c.after))}</span></span>`;
        div.appendChild(row);
      }
    }
    container.appendChild(div);
  }
}

function escHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function showChangelog(company) {
  try {
    const r = await fetch(`/api/changelog?company=${encodeURIComponent(company)}`);
    if (!r.ok) { changelogSection.style.display = 'none'; return; }
    const data = await r.json();
    renderChangelog(data, changelogContent);
    changelogSection.style.display = '';
  } catch { changelogSection.style.display = 'none'; }
}

async function pollBatchStatus() {
  try {
    const r = await fetch('/api/batch-status');
    if (!r.ok) return;
    const data = await r.json();

    const snapshot = JSON.stringify(data.accounts.map(a => `${a.company}:${a.v1}:${a.v2}`));
    const changed = snapshot !== _lastBatchSnapshot;

    if (changed && _lastBatchSnapshot !== '') {
      // Accounts are actively changing — batch is running
      _stableCount = 0;
      _batchEverActive = true;
    } else {
      _stableCount++;
    }

    _lastBatchSnapshot = snapshot;

    // Only show the batch panel if we detected active changes
    // Hide it once stable for STABLE_THRESHOLD polls
    if (!_batchEverActive || _stableCount >= STABLE_THRESHOLD) {
      batchSection.style.display = 'none';
      return;
    }

    if (data.accounts.length === 0) {
      batchSection.style.display = 'none';
      return;
    }

    // Show batch section
    batchSection.style.display = '';

    // Determine if still actively changing
    const allDone = data.accounts.every(a => a.v2);
    batchStatusLabel.textContent = allDone ? 'Complete' : 'Processing\u2026';
    batchStatusLabel.className = 'batch-status ' + (allDone ? 'idle' : 'active');

    batchAccounts.innerHTML = '';
    for (const acct of data.accounts) {
      const card = document.createElement('div');
      card.className = 'batch-card';

      const badges = [];
      if (acct.v1) badges.push('<span class="batch-badge v1">v1</span>');
      if (acct.v2) badges.push('<span class="batch-badge v2">v2</span>');
      if (!acct.v1 && !acct.v2) badges.push('<span class="batch-badge none">pending</span>');

      card.innerHTML = `
        <div class="batch-card-header">
          <span class="batch-company">${escHTML(acct.company)}</span>
          <div class="batch-badges">${badges.join('')}</div>
        </div>
        <div class="batch-card-body"></div>`;

      // Toggle open/close
      card.querySelector('.batch-card-header').addEventListener('click', () => {
        card.classList.toggle('open');
      });

      // Render changelog inside card body if available
      const body = card.querySelector('.batch-card-body');
      if (acct.changelog && acct.changelog.history && acct.changelog.history.length > 0) {
        renderChangelog(acct.changelog, body);
      } else if (acct.v2) {
        body.innerHTML = '<p style="font-size:0.72rem;color:#999;">v2 complete \u2014 no changelog recorded.</p>';
      } else if (acct.v1) {
        body.innerHTML = '<p style="font-size:0.72rem;color:#999;">v1 complete \u2014 awaiting v2.</p>';
      } else {
        body.innerHTML = '<p style="font-size:0.72rem;color:#999;">Queued \u2014 not yet processed.</p>';
      }

      batchAccounts.appendChild(card);
    }
  } catch { /* ignore poll errors */ }
}

function startBatchPolling() {
  if (_batchPollId) return;
  pollBatchStatus(); // immediate first poll
  _batchPollId = setInterval(pollBatchStatus, 3000); // every 3s
}

function stopBatchPolling() {
  if (_batchPollId) {
    clearInterval(_batchPollId);
    _batchPollId = null;
  }
}

let checkTimeout;
async function checkExistingOutputs() {
  const c = getCompany();
  if (!c) {
    changelogSection.style.display = 'none';
    return;
  }
  try {
    const r = await fetch(`/outputs?company=${encodeURIComponent(c)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.version) {
        v1Done = true;
        v2El.classList.remove('disabled');
        log(v1LogsEl, `\u2139  Existing ${data.version} outputs found for "${c}"`, 'log-line');
        v1LogsEl.classList.add('visible');
        sync();
      }
    }
  } catch { /* ignore */ }

  await showChangelog(c);
}

companyEl.addEventListener('input', () => {
  clearTimeout(checkTimeout);
  checkTimeout = setTimeout(checkExistingOutputs, 600);
  sync();
});

accountIdEl.addEventListener('input', sync);

v1FileEl.addEventListener('change', () => {
  v1FnameEl.textContent = v1FileEl.files.length ? v1FileEl.files[0].name : 'No file selected';
  sync();
});

v2FileEl.addEventListener('change', () => {
  v2FnameEl.textContent = v2FileEl.files.length ? v2FileEl.files[0].name : 'No file selected';
  sync();
});

v2FormEl.addEventListener('input', sync);

v1RunEl.addEventListener('click', async () => {
  if (v1Running) return;
  v1Running = true;
  v1RunEl.textContent = 'Running\u2026';
  sync();

  const fd = new FormData();
  fd.append('company', getCompany());
  fd.append('account_id', getAccountId());
  fd.append('file', v1FileEl.files[0]);

  const result = await runPipeline('/api/v1', fd, v1LogsEl, v1ResultEl, v1TimerEl);

  v1Running = false;
  v1RunEl.textContent = 'Run v1';

  if (result && result.code === 0) {
    v1Done = true;
    v2El.classList.remove('disabled');
  }

  sync();
});

v2RunEl.addEventListener('click', async () => {
  if (v2Running) return;
  v2Running = true;
  v2RunEl.textContent = 'Running\u2026';
  sync();

  const fd = new FormData();
  fd.append('company', getCompany());
  fd.append('account_id', getAccountId());
  if (v2FileEl.files.length) fd.append('file', v2FileEl.files[0]);

  const form = v2FormEl.value.trim();
  if (form && form !== '{}') fd.append('form_data', form);

  const result = await runPipeline('/api/v2', fd, v2LogsEl, v2ResultEl, v2TimerEl);

  v2Running = false;
  v2RunEl.textContent = 'Run v2';
  sync();

  if (result && result.code === 0) {
    await showChangelog(getCompany());
  }
});

startBatchPolling();
