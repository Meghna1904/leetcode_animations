// ══════════════════════════════════════════════════════════════
// PATTERNS TAB
// ══════════════════════════════════════════════════════════════
let patActiveDiff = 'all';
const QUESTION_PROGRESS_KEY = 'dsa_question_progress_v1';
const DELETED_ANIMATIONS_KEY = 'dsa_animations_deleted_v1';
const SYNC_ACCOUNT_KEY = 'dsa_sync_account_v1';
const DAY_MS = 24 * 60 * 60 * 1000;
let questionProgress = loadQuestionProgress();
let pendingQuestionId = null;
let pendingProgressMode = 'solve';
let cloudSyncAuthenticated = false;
let cloudSyncConfigured = false;
let cloudSyncUsername = '';
let cloudSyncTimer = null;
let cloudSyncRunning = false;
let cloudSyncAgain = false;
let localSyncVersion = 0;

function loadQuestionProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUESTION_PROGRESS_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function saveQuestionProgress() {
  try {
    localStorage.setItem(QUESTION_PROGRESS_KEY, JSON.stringify(questionProgress));
    localSyncVersion++;
    scheduleCloudSync();
    return true;
  } catch {
    toast('Could not save progress. Browser storage may be full.', true);
    return false;
  }
}

function questionId(pr) {
  return (pr.url || pr.name).replace(/\/$/, '').toLowerCase();
}

function findQuestion(id) {
  for (const pattern of PATTERNS) {
    const problem = pattern.problems.find(pr => questionId(pr) === id);
    if (problem) return { pattern, problem };
  }
  return null;
}

function expectedMinutes(difficulty) {
  return difficulty === 'E' ? 20 : difficulty === 'H' ? 50 : 35;
}

function nextReviewDays(difficulty, minutes, toughness, usedHint, previous) {
  const ratio = minutes / expectedMinutes(difficulty);
  const timeFactor = ratio <= 0.75 ? 1.25 : ratio <= 1.25 ? 1 : ratio <= 2 ? 0.75 : 0.55;
  const hintFactor = usedHint ? 0.75 : 1;
  const easeByToughness = [2.4, 2.05, 1.75, 1.4, 1.15];
  const firstIntervalByToughness = [14, 10, 7, 3, 1];
  const days = previous && previous.attempts > 0
    ? previous.intervalDays * easeByToughness[toughness - 1] * timeFactor * hintFactor
    : firstIntervalByToughness[toughness - 1] * timeFactor * hintFactor;
  return Math.max(1, Math.min(90, Math.round(days)));
}

function progressMeta(id) {
  const record = questionProgress[id];
  if (!record || !record.completed) return 'Not solved yet';
  const review = record.dueAt <= Date.now()
    ? 'Review due today'
    : `Review ${fmtDate(record.dueAt)}`;
  return `${review} · ${record.lastMinutes} min · toughness ${record.toughness}/5${record.usedHint ? ' · used hint' : ''}`;
}

function questionRef(patternIndex, problemIndex) {
  return `${patternIndex}:${problemIndex}`;
}

function getQuestionFromRef(ref) {
  const [patternIndex, problemIndex] = String(ref).split(':').map(Number);
  const pattern = PATTERNS[patternIndex];
  const problem = pattern?.problems[problemIndex];
  if (!pattern || !problem) return null;
  return { ref, pattern, problem, patternIndex, problemIndex };
}

function allQuestionEntries() {
  return PATTERNS.flatMap((pattern, patternIndex) =>
    pattern.problems.map((problem, problemIndex) => ({
      ref: questionRef(patternIndex, problemIndex),
      pattern,
      problem,
      patternIndex,
      problemIndex,
    }))
  );
}

function normalizeQuestionText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b(animated?|visuali[sz]ation|solution|leetcode)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchAnimationToQuestion(title, html) {
  const entries = allQuestionEntries();
  const source = String(html || '').toLowerCase();
  const urlMatches = entries.filter(entry => {
    const url = entry.problem.url.toLowerCase().replace(/\/$/, '');
    return url && source.includes(url);
  });
  const uniqueUrlMatches = [...new Map(urlMatches.map(entry => [entry.ref, entry])).values()];
  if (uniqueUrlMatches.length === 1) return uniqueUrlMatches[0];
  if (uniqueUrlMatches.length > 1) return null;

  let htmlTitle = '';
  try {
    htmlTitle = new DOMParser().parseFromString(String(html || ''), 'text/html').title;
  } catch { /* The provided title remains available for matching. */ }

  const candidates = [normalizeQuestionText(title), normalizeQuestionText(htmlTitle)].filter(Boolean);
  const matched = entries.filter(entry => {
    const name = normalizeQuestionText(entry.problem.name);
    const slug = normalizeQuestionText(new URL(entry.problem.url).pathname.split('/').filter(Boolean).pop());
    return candidates.includes(name) || candidates.includes(slug);
  });
  const uniqueMatches = [...new Map(matched.map(entry => [entry.ref, entry])).values()];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

function getAnimationQuestionMatch(animation) {
  if (animation.questionRef) {
    const savedMatch = getQuestionFromRef(animation.questionRef);
    if (savedMatch) return savedMatch;
  }
  return matchAnimationToQuestion(animation.title, animation.html);
}

let animationMatchCache = null;

function findAnimationForQuestion(ref) {
  if (!animationMatchCache) {
    animationMatchCache = new Map();
    loadAnimations().forEach(animation => {
      const match = getAnimationQuestionMatch(animation);
      if (match) animationMatchCache.set(match.ref, animation);
    });
  }
  return animationMatchCache.get(ref);
}

function fillQuestionOptions() {
  const select = document.getElementById('anim-question');
  PATTERNS.forEach((pattern, patternIndex) => {
    const group = document.createElement('optgroup');
    group.label = `${String(patternIndex + 1).padStart(2, '0')} · ${pattern.name}`;
    pattern.problems.forEach((problem, problemIndex) => {
      const option = document.createElement('option');
      option.value = questionRef(patternIndex, problemIndex);
      option.textContent = `${String(problemIndex + 1).padStart(2, '0')} · ${problem.name} (${problem.d})`;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
}

let questionMatchWasChosen = false;

function updateQuestionMatchNote(match) {
  const note = document.getElementById('anim-question-match');
  if (!match) {
    note.textContent = 'No exact match yet. Pick a question above to link it manually.';
    return;
  }
  note.textContent = `Linked: Pattern ${String(match.patternIndex + 1).padStart(2, '0')} · Question ${String(match.problemIndex + 1).padStart(2, '0')} · ${match.problem.name}`;
}

function autoSelectRelatedQuestion() {
  if (questionMatchWasChosen) return;
  const select = document.getElementById('anim-question');
  const match = matchAnimationToQuestion(document.getElementById('anim-title').value, document.getElementById('anim-html').value);
  select.value = match?.ref || '';
  updateQuestionMatchNote(match);
}

function refreshQuestionAnimationButtons() {
  document.querySelectorAll('.pat-prow').forEach(row => {
    row.querySelector('.question-animation')?.remove();
    const ref = row.dataset.questionRef;
    const animation = findAnimationForQuestion(ref);
    if (!animation) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'question-animation';
    button.textContent = '▶';
    button.title = `Open animation: ${animation.title}`;
    button.setAttribute('aria-label', `Open animation for ${row.querySelector('.pat-pname').textContent}`);
    button.addEventListener('click', event => {
      event.stopPropagation();
      openPlayer(animation.id);
    });
    row.appendChild(button);
  });
}

function buildPatterns() {
  const grid = document.getElementById('pat-grid');
  PATTERNS.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'pat-card';
    card.id = 'pc' + idx;
    card.innerHTML = `
      <div class="pat-ch" onclick="patToggle(${idx})">
        <span class="pat-num">${String(idx + 1).padStart(2, '0')}</span>
        <div class="pat-main">
          <div class="pat-name">${p.name}</div>
          <div class="pat-trig">${p.trig}</div>
        </div>
        <div class="pat-right">
          <span class="pat-count">${p.problems.length}</span>
          <span class="pat-arr">▼</span>
        </div>
      </div>
      <div class="pat-inv">${p.inv}</div>
      <div class="pat-plist">
        ${p.problems.map((pr, i) => `
          <div class="pat-prow" data-diff="${pr.d}" data-question-ref="${questionRef(idx, i)}">
            <span class="pat-pi">${i + 1}</span>
            <label class="question-tick" title="Mark solved">
              <input type="checkbox" class="question-check" data-question-id="${encodeURIComponent(questionId(pr))}" aria-label="Mark ${esc(pr.name)} solved" ${questionProgress[questionId(pr)]?.completed ? 'checked' : ''}>
              <span aria-hidden="true">✓</span>
            </label>
            <a class="question-link" href="${pr.url}" target="_blank" rel="noopener">
              <span class="pat-pname">${pr.name}</span>
              <span class="question-meta" data-meta-id="${encodeURIComponent(questionId(pr))}">${progressMeta(questionId(pr))}</span>
            </a>
            <span class="diff-badge diff-${pr.d}">${pr.d === 'E' ? 'Easy' : pr.d === 'M' ? 'Med' : 'Hard'}</span>
          </div>`).join('')}
      </div>`;
    grid.appendChild(card);
  });
  bindQuestionChecks();
  refreshQuestionAnimationButtons();
  updatePatInfo();
  renderProgressSummary();
}

function bindQuestionChecks() {
  document.querySelectorAll('.question-check').forEach(check => {
    check.addEventListener('change', () => {
      const id = decodeURIComponent(check.dataset.questionId);
      if (check.checked) {
        openProgressDialog(id, 'solve');
        return;
      }

      if (!window.confirm('Mark this problem as unsolved? Its attempt history will be kept.')) {
        check.checked = true;
        return;
      }
      if (questionProgress[id]) {
        questionProgress[id].completed = false;
        questionProgress[id].dueAt = null;
      }
      if (saveQuestionProgress()) refreshQuestionProgress();
    });
  });
}

function patToggle(idx) {
  document.getElementById('pc' + idx).classList.toggle('open');
}

function patExpandAll() {
  document.querySelectorAll('.pat-card:not(.hide)').forEach(c => c.classList.add('open'));
}
function patCollapseAll() {
  document.querySelectorAll('.pat-card').forEach(c => c.classList.remove('open'));
}

function patFilterDiff(d, btn) {
  patActiveDiff = d;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  patFilter();
}

function patFilter() {
  const q = document.getElementById('pat-search').value.toLowerCase();
  const empty = document.getElementById('pat-empty');
  let anyVisible = false;

  PATTERNS.forEach((p, idx) => {
    const card = document.getElementById('pc' + idx);
    const nameMatch = p.name.toLowerCase().includes(q) || p.trig.toLowerCase().includes(q);
    let anyProb = false;

    card.querySelectorAll('.pat-prow').forEach(row => {
      const dm = patActiveDiff === 'all' || row.dataset.diff === patActiveDiff;
      const tm = !q || row.textContent.toLowerCase().includes(q) || nameMatch;
      if (dm && tm) { row.classList.remove('hide'); anyProb = true; }
      else row.classList.add('hide');
    });

    const show = anyProb || (nameMatch && (!q || patActiveDiff === 'all'));
    card.classList.toggle('hide', !show);
    if (!anyProb && q) card.classList.remove('open');
    if (show) anyVisible = true;
  });

  empty.style.display = anyVisible ? 'none' : 'block';
  updatePatInfo();
}

function updatePatInfo() {
  const vis   = document.querySelectorAll('.pat-card:not(.hide)').length;
  const probs = document.querySelectorAll('.pat-prow:not(.hide)').length;
  const solved = Object.values(questionProgress).filter(record => record.completed).length;
  const due = Object.values(questionProgress).filter(record => record.completed && record.dueAt <= Date.now()).length;
  document.getElementById('pat-info').textContent = `${vis} patterns · ${probs} problems · ${solved} solved · ${due} due`;
}

function openProgressDialog(id, mode) {
  const found = findQuestion(id);
  if (!found) return;
  pendingQuestionId = id;
  pendingProgressMode = mode;

  const record = questionProgress[id];
  const dialog = document.getElementById('progress-dialog');
  document.getElementById('progress-dialog-title').textContent = mode === 'review' ? 'Log review' : 'Mark as solved';
  document.getElementById('progress-problem-title').textContent = `${found.problem.name} · ${found.pattern.name}`;
  document.getElementById('solve-minutes').value = record?.lastMinutes || String(expectedMinutes(found.problem.d));
  document.getElementById('solve-toughness').value = record?.toughness || '3';
  document.getElementById('solve-used-hint').checked = Boolean(record?.usedHint);
  updateReviewPreview();
  dialog.showModal();
}

function closeProgressDialog() {
  const dialog = document.getElementById('progress-dialog');
  if (dialog.open) dialog.close();
  if (pendingQuestionId && pendingProgressMode === 'solve') {
    document.querySelectorAll(`.question-check[data-question-id="${encodeURIComponent(pendingQuestionId)}"]`).forEach(check => {
      check.checked = Boolean(questionProgress[pendingQuestionId]?.completed);
    });
  }
  pendingQuestionId = null;
}

function updateReviewPreview() {
  if (!pendingQuestionId) return;
  const found = findQuestion(pendingQuestionId);
  if (!found) return;
  const minutes = Math.max(1, Number(document.getElementById('solve-minutes').value) || expectedMinutes(found.problem.d));
  const toughness = Number(document.getElementById('solve-toughness').value);
  const usedHint = document.getElementById('solve-used-hint').checked;
  const days = nextReviewDays(found.problem.d, minutes, toughness, usedHint, questionProgress[pendingQuestionId]);
  const dueDate = new Date(Date.now() + days * DAY_MS);
  document.getElementById('next-review-preview').textContent = `Next review: ${days} day${days === 1 ? '' : 's'} · ${fmtDate(dueDate.getTime())}`;
}

function renderProgressSummary() {
  const records = Object.values(questionProgress).filter(record => record.completed);
  const due = records.filter(record => record.dueAt <= Date.now());
  const summary = document.getElementById('progress-summary');
  const list = document.getElementById('review-list');
  const empty = document.getElementById('review-empty');
  summary.textContent = `${records.length} solved · ${due.length} due today`;
  list.replaceChildren();

  if (due.length === 0) {
    const upcoming = records.map(record => record.dueAt).filter(Boolean).sort((a, b) => a - b)[0];
    empty.textContent = upcoming
      ? `Nothing due today. Your next review is ${fmtDate(upcoming)}.`
      : 'Mark a question solved to start your review schedule.';
    return;
  }

  empty.textContent = '';
  due.sort((a, b) => a.dueAt - b.dueAt).forEach(record => {
    const found = findQuestion(record.id);
    if (!found) return;
    const card = document.createElement('article');
    card.className = 'review-card';

    const info = document.createElement('div');
    info.className = 'review-card-info';
    const link = document.createElement('a');
    link.href = found.problem.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = found.problem.name;
    const details = document.createElement('span');
    details.textContent = `${found.pattern.name} · last took ${record.lastMinutes} min · toughness ${record.toughness}/5`;
    info.append(link, details);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fbtn review-log-button';
    button.textContent = 'Log review';
    button.addEventListener('click', () => openProgressDialog(record.id, 'review'));
    card.append(info, button);
    list.appendChild(card);
  });
}

function refreshQuestionProgress() {
  document.querySelectorAll('.question-check').forEach(check => {
    const id = decodeURIComponent(check.dataset.questionId);
    check.checked = Boolean(questionProgress[id]?.completed);
  });
  document.querySelectorAll('[data-meta-id]').forEach(meta => {
    const id = decodeURIComponent(meta.dataset.metaId);
    meta.textContent = progressMeta(id);
    meta.classList.toggle('is-due', Boolean(questionProgress[id]?.completed && questionProgress[id].dueAt <= Date.now()));
  });
  updatePatInfo();
  renderProgressSummary();
}

document.getElementById('progress-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingQuestionId) return;

  const found = findQuestion(pendingQuestionId);
  if (!found) return;
  const minutes = Number(document.getElementById('solve-minutes').value);
  const toughness = Number(document.getElementById('solve-toughness').value);
  const usedHint = document.getElementById('solve-used-hint').checked;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440 || toughness < 1 || toughness > 5) return;

  const previous = questionProgress[pendingQuestionId];
  const intervalDays = nextReviewDays(found.problem.d, minutes, toughness, usedHint, previous);
  const now = Date.now();
  const attempt = { at: now, minutes, toughness, usedHint, mode: pendingProgressMode };
  questionProgress[pendingQuestionId] = {
    id: pendingQuestionId,
    completed: true,
    attempts: (previous?.attempts || 0) + 1,
    lastMinutes: minutes,
    toughness,
    usedHint,
    intervalDays,
    lastAt: now,
    dueAt: now + intervalDays * DAY_MS,
    history: [...(previous?.history || []), attempt].slice(-20),
  };

  if (saveQuestionProgress()) {
    const savedMode = pendingProgressMode;
    closeProgressDialog();
    refreshQuestionProgress();
    toast(savedMode === 'review' ? `Review logged · next review in ${intervalDays} days.` : `Solved · review scheduled in ${intervalDays} days.`);
  }
});

document.getElementById('progress-cancel').addEventListener('click', closeProgressDialog);
document.getElementById('progress-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  closeProgressDialog();
});
['solve-minutes', 'solve-toughness', 'solve-used-hint'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateReviewPreview);
  document.getElementById(id).addEventListener('change', updateReviewPreview);
});


// ══════════════════════════════════════════════════════════════
// ANIMATIONS TAB
// ══════════════════════════════════════════════════════════════
const STORE_KEY = 'dsa_animations_v1';

function loadAnimations() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function loadDeletedAnimationIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(DELETED_ANIMATIONS_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}
function saveDeletedAnimationIds(ids) {
  localStorage.setItem(DELETED_ANIMATIONS_KEY, JSON.stringify([...ids]));
}
function saveAnimations(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
  localSyncVersion++;
  scheduleCloudSync();
  const badge = document.getElementById('anim-tab-count');
  if (badge) badge.textContent = list.length;
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Sub-views inside Animations
function showAnimView(name) {
  // 'collection', 'add', 'player'
  document.querySelectorAll('.anim-view').forEach(v => v.classList.remove('active'));
  document.getElementById('anim-view-' + name).classList.add('active');
  if (name !== 'player') {
    const f = document.getElementById('player-frame');
    if (f) f.srcdoc = '';
  }
}

function renderAnimCollection() {
  const anims = loadAnimations();
  const grid  = document.getElementById('anim-grid');
  const count = document.getElementById('anim-count');
  const empty = document.getElementById('anim-empty');

  count.textContent = `${anims.length} saved`;
  grid.innerHTML = '';

  if (anims.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  anims.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'anim-card';
    const match = getAnimationQuestionMatch(a);
    card.innerHTML = `
      <div class="anim-card-num">#${String(i + 1).padStart(3, '0')}</div>
      <div class="anim-card-title">${esc(a.title)}</div>
      ${a.desc ? `<div class="anim-card-desc">${esc(a.desc)}</div>` : ''}
      ${match ? `<div class="anim-card-related">Pattern ${String(match.patternIndex + 1).padStart(2, '0')} · Q${String(match.problemIndex + 1).padStart(2, '0')} · ${esc(match.problem.name)} <a class="anim-card-lc" href="${match.problem.url}" target="_blank" rel="noopener">LeetCode ↗</a></div>` : ''}
      <div class="anim-card-footer">
        <span class="anim-card-date">${fmtDate(a.ts)}</span>
        <button class="btn btn-danger" data-id="${a.id}" title="Delete">✕ delete</button>
      </div>`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-danger, .anim-card-lc')) return;
      openPlayer(a.id);
    });
    card.querySelector('.btn-danger').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnim(a.id);
    });
    grid.appendChild(card);
  });
}

function openPlayer(id) {
  const anim = loadAnimations().find(a => a.id === id);
  if (!anim) return;
  document.getElementById('player-title').textContent = anim.title;
  const related = document.getElementById('player-related');
  related.replaceChildren();
  const match = getAnimationQuestionMatch(anim);
  if (match) {
    const position = document.createElement('span');
    position.textContent = `Pattern ${String(match.patternIndex + 1).padStart(2, '0')} · Q${String(match.problemIndex + 1).padStart(2, '0')}`;
    const link = document.createElement('a');
    link.href = match.problem.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'LeetCode ↗';
    related.append(position, link);
  }

  // Replace iframe for clean slate
  const old = document.getElementById('player-frame');
  const fresh = document.createElement('iframe');
  fresh.id = 'player-frame';
  fresh.className = 'player-frame';
  fresh.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
  fresh.setAttribute('title', anim.title);
  fresh.srcdoc = anim.html;
  old.replaceWith(fresh);

  showAnimView('player');
}

function deleteAnim(id) {
  const deletedIds = new Set(loadDeletedAnimationIds());
  deletedIds.add(id);
  saveDeletedAnimationIds(deletedIds);
  const updated = loadAnimations().filter(a => a.id !== id);
  saveAnimations(updated);
  animationMatchCache = null;
  renderAnimCollection();
  toast('Animation removed.');
}

// ── Add form ────────────────────────────────────────────────
const addForm     = document.getElementById('anim-add-form');
const titleInput  = document.getElementById('anim-title');
const descInput   = document.getElementById('anim-desc');
const htmlBox     = document.getElementById('anim-html');
const fileInput   = document.getElementById('anim-file');
const dropZone    = document.getElementById('anim-dropzone');
const badgeLoaded = document.getElementById('badge-loaded');
const questionSelect = document.getElementById('anim-question');

questionSelect.addEventListener('change', () => {
  questionMatchWasChosen = Boolean(questionSelect.value);
  updateQuestionMatchNote(getQuestionFromRef(questionSelect.value));
});
titleInput.addEventListener('input', autoSelectRelatedQuestion);

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) readFile(fileInput.files[0]);
});

function readFile(file) {
  if (!file.name.endsWith('.html') && file.type !== 'text/html') {
    toast('Please upload an HTML file.', true); return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    htmlBox.value = e.target.result;
    showBadge(file.name);
    if (!titleInput.value.trim())
      titleInput.value = file.name.replace(/\.html?$/i, '').replace(/[-_]/g, ' ');
    autoSelectRelatedQuestion();
  };
  reader.readAsText(file);
}

htmlBox.addEventListener('input', () => {
  htmlBox.value.trim() ? showBadge(null) : (badgeLoaded.classList.remove('show'));
  autoSelectRelatedQuestion();
});

function showBadge(name) {
  badgeLoaded.classList.add('show');
  badgeLoaded.textContent = '✓ ' + (name || 'HTML loaded');
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const html  = htmlBox.value.trim();
  if (!title) { toast('Enter a title.', true); titleInput.focus(); return; }
  if (!html)  { toast('Paste or upload the HTML.', true); return; }

  const list = loadAnimations();
  const relatedQuestion = getQuestionFromRef(questionSelect.value) || matchAnimationToQuestion(title, html);
  const animation = {
    id: genId(), title, desc: descInput.value.trim(), html, ts: Date.now(),
    questionRef: relatedQuestion?.ref || null,
  };
  const deletedIds = new Set(loadDeletedAnimationIds());
  deletedIds.delete(animation.id);
  saveDeletedAnimationIds(deletedIds);
  list.push(animation);
  saveAnimations(list);
  animationMatchCache = null;

  toast(`"${title}" saved!`);
  addForm.reset();
  badgeLoaded.classList.remove('show');
  questionMatchWasChosen = false;
  questionSelect.value = '';
  updateQuestionMatchNote(null);
  renderAnimCollection();
  refreshQuestionAnimationButtons();
  showAnimView('collection');
});

document.getElementById('anim-cancel').addEventListener('click', () => showAnimView('collection'));
document.getElementById('btn-back-player').addEventListener('click', () => {
  showAnimView('collection');
  renderAnimCollection();
});


// ══════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('btn-add-anim').addEventListener('click', () => {
  switchTab('animations');
  showAnimView('add');
});


// ══════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════
function toast(msg, err = false) {
  const wrap = document.getElementById('toast-wrap');
  const el   = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove());
  }, 3000);
}

function currentCloudState() {
  return {
    questionProgress,
    animations: loadAnimations(),
    deletedAnimationIds: loadDeletedAnimationIds(),
  };
}

function activateLocalSyncAccount(username) {
  if (!username) return;
  const previous = localStorage.getItem(SYNC_ACCOUNT_KEY);
  if (previous && previous !== username) {
    localStorage.removeItem(QUESTION_PROGRESS_KEY);
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(DELETED_ANIMATIONS_KEY);
    questionProgress = {};
  }
  localStorage.setItem(SYNC_ACCOUNT_KEY, username);
}

function mergeCloudStates(remote, local) {
  remote = remote && typeof remote === 'object' ? remote : {};
  local = local && typeof local === 'object' ? local : {};
  const questionProgress = { ...(remote.questionProgress || {}) };
  for (const [id, record] of Object.entries(local.questionProgress || {})) {
    if (!questionProgress[id] || record.lastAt > questionProgress[id].lastAt) questionProgress[id] = record;
  }

  const deletedAnimationIds = new Set([
    ...(Array.isArray(remote.deletedAnimationIds) ? remote.deletedAnimationIds : []),
    ...(Array.isArray(local.deletedAnimationIds) ? local.deletedAnimationIds : []),
  ]);
  const animationsById = new Map();
  for (const animation of [...(remote.animations || []), ...(local.animations || [])]) {
    if (!deletedAnimationIds.has(animation.id)) animationsById.set(animation.id, animation);
  }
  return { questionProgress, animations: [...animationsById.values()], deletedAnimationIds: [...deletedAnimationIds] };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function applyCloudState(state) {
  questionProgress = state.questionProgress || {};
  localStorage.setItem(QUESTION_PROGRESS_KEY, JSON.stringify(questionProgress));
  localStorage.setItem(STORE_KEY, JSON.stringify(state.animations || []));
  saveDeletedAnimationIds(new Set(state.deletedAnimationIds || []));
  const badge = document.getElementById('anim-tab-count');
  if (badge) badge.textContent = (state.animations || []).length;
  animationMatchCache = null;
  refreshQuestionProgress();
  renderAnimCollection();
  refreshQuestionAnimationButtons();
}

function setCloudStatus(text) {
  const button = document.getElementById('btn-sync-status');
  if (button) {
    button.textContent = cloudSyncAuthenticated && cloudSyncUsername ? `Hi, ${cloudSyncUsername}` : 'Sync';
    button.setAttribute('aria-label', cloudSyncAuthenticated && cloudSyncUsername ? `Signed in as ${cloudSyncUsername}. Cloud sync: ${text}` : `Cloud sync: ${text}`);
    button.title = cloudSyncAuthenticated && cloudSyncUsername ? `Hi, ${cloudSyncUsername} · Cloud sync: ${text}` : `Cloud sync: ${text}`;
  }
  const message = document.getElementById('sync-dialog-message');
  if (message && cloudSyncAuthenticated) message.textContent = `Current status: ${text}. Changes sync to your Neon database.`;
}

async function readApiResponse(response) {
  let body = {};
  try { body = await response.json(); } catch { /* The API may return an empty response. */ }
  if (!response.ok) {
    const error = new Error(body.error || `Sync request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function pullAndMergeCloudState() {
  if (!cloudSyncAuthenticated) return;
  const { state: remote = { questionProgress: {}, animations: [], deletedAnimationIds: [] } } =
    await readApiResponse(await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' }));
  const local = currentCloudState();
  const merged = mergeCloudStates(remote, local);
  applyCloudState(merged);

  if (stableJson(merged) !== stableJson(remote)) {
    cloudSyncAgain = true;
    scheduleCloudSync(0);
  } else {
    setCloudStatus('Synced');
  }
}

function scheduleCloudSync(delay = 700) {
  if (!cloudSyncAuthenticated) return;
  clearTimeout(cloudSyncTimer);
  setCloudStatus('Syncing…');
  cloudSyncTimer = setTimeout(pushCloudState, delay);
}

async function pushCloudState() {
  if (!cloudSyncAuthenticated) return;
  if (cloudSyncRunning) {
    cloudSyncAgain = true;
    return;
  }
  cloudSyncRunning = true;
  try {
    do {
      cloudSyncAgain = false;
      const version = localSyncVersion;
      const state = currentCloudState();
      const result = await readApiResponse(await fetch('/api/state', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      }));
      if (version === localSyncVersion) {
        applyCloudState(result.state);
        setCloudStatus('Synced');
      } else {
        cloudSyncAgain = true;
      }
    } while (cloudSyncAgain);
  } catch (error) {
    console.error('Cloud sync failed:', error);
    if (error.status === 401) cloudSyncAuthenticated = false;
    setCloudStatus(error.status === 401 ? 'Sign in to sync' : 'Sync retry');
    toast(error.message || 'Could not sync right now. Your local data is still saved.', true);
  } finally {
    cloudSyncRunning = false;
  }
}

function setSyncDialogMode(signedIn) {
  document.getElementById('sync-dialog-title').textContent = signedIn && cloudSyncUsername ? `Hi, ${cloudSyncUsername}!` : signedIn ? 'Cloud sync is on' : 'Your sync account';
  document.getElementById('sync-dialog-message').textContent = signedIn
    ? `Current status: ${document.getElementById('btn-sync-status').title.split('Cloud sync: ').pop()}. Your progress and animations sync to this account.`
    : cloudSyncConfigured
      ? 'Create a username and password, then use the same account on each device.'
      : 'Cloud sync is not enabled for this deployment yet. Your data is being saved only on this device.';
  document.getElementById('sync-recovery-warning').hidden = signedIn;
  document.getElementById('sync-username-label').hidden = signedIn;
  document.getElementById('sync-username').hidden = signedIn;
  document.getElementById('sync-username').required = !signedIn;
  document.getElementById('sync-password-label').hidden = signedIn;
  document.getElementById('sync-password').hidden = signedIn;
  document.getElementById('sync-password').required = !signedIn;
  document.getElementById('sync-sign-in').hidden = signedIn;
  document.getElementById('sync-register').hidden = signedIn;
  document.getElementById('sync-sign-out').hidden = !signedIn;
}

async function initializeCloudSync() {
  try {
    const result = await readApiResponse(await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' }));
    cloudSyncConfigured = Boolean(result.configured);
    cloudSyncAuthenticated = Boolean(result.authenticated && result.configured);
    cloudSyncUsername = cloudSyncAuthenticated ? result.username || '' : '';
    if (cloudSyncAuthenticated) activateLocalSyncAccount(result.username);
    setCloudStatus(cloudSyncAuthenticated ? 'Syncing…' : cloudSyncConfigured ? 'Sign in to sync' : 'Sync setup');
    if (cloudSyncAuthenticated) await pullAndMergeCloudState();
  } catch {
    cloudSyncConfigured = false;
    cloudSyncAuthenticated = false;
    setCloudStatus('Local only');
  }
}

document.getElementById('btn-sync-status').addEventListener('click', () => {
  setSyncDialogMode(cloudSyncAuthenticated);
  document.getElementById('sync-dialog').showModal();
});
document.getElementById('sync-cancel').addEventListener('click', () => document.getElementById('sync-dialog').close());
document.getElementById('sync-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || document.getElementById('sync-sign-in');
  const action = button.value || 'login';
  const username = document.getElementById('sync-username').value;
  const password = document.getElementById('sync-password').value;
  const buttons = [...document.querySelectorAll('#sync-form button[type="submit"]')];
  buttons.forEach(submitButton => { submitButton.disabled = true; });
  try {
    const account = await readApiResponse(await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, username, password }),
    }));
    cloudSyncConfigured = true;
    cloudSyncAuthenticated = true;
    cloudSyncUsername = account.username || username.trim();
    activateLocalSyncAccount(account.username);
    document.getElementById('sync-username').value = '';
    document.getElementById('sync-password').value = '';
    document.getElementById('sync-dialog').close();
    setCloudStatus('Syncing…');
    await pullAndMergeCloudState();
    toast(action === 'register' ? 'Account created. Cloud sync is on for this device.' : 'Cloud sync is on for this device.');
  } catch (error) {
    toast(error.message || 'Could not sign in to sync.', true);
  } finally {
    buttons.forEach(submitButton => { submitButton.disabled = false; });
  }
});
document.getElementById('sync-sign-out').addEventListener('click', async () => {
  try {
    await readApiResponse(await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }));
    cloudSyncAuthenticated = false;
    cloudSyncUsername = '';
    clearTimeout(cloudSyncTimer);
    document.getElementById('sync-dialog').close();
    setCloudStatus('Sign in to sync');
    toast('Signed out. This device’s local data remains here.');
  } catch (error) {
    toast(error.message || 'Could not sign out right now.', true);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cloudSyncAuthenticated) pullAndMergeCloudState().catch(error => {
    if (error.status === 401) cloudSyncAuthenticated = false;
    setCloudStatus(error.status === 401 ? 'Sign in to sync' : 'Sync retry');
  });
});
setInterval(() => {
  if (document.visibilityState === 'visible' && cloudSyncAuthenticated) {
    pullAndMergeCloudState().catch(error => {
      if (error.status === 401) cloudSyncAuthenticated = false;
      setCloudStatus(error.status === 401 ? 'Sign in to sync' : 'Sync retry');
    });
  }
}, 30000);


// ══════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════
fillQuestionOptions();
updateQuestionMatchNote(null);
buildPatterns();
renderAnimCollection();
switchTab('patterns');
void initializeCloudSync();

// init animation tab badge from existing localStorage
(function() {
  const badge = document.getElementById('anim-tab-count');
  if (badge) badge.textContent = loadAnimations().length;
})();
