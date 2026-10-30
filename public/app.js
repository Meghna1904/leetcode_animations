// ══════════════════════════════════════════════════════════════
// PATTERNS TAB
// ══════════════════════════════════════════════════════════════
let patActiveDiff = 'all';
const QUESTION_PROGRESS_KEY = 'dsa_question_progress_v1';
const DELETED_ANIMATIONS_KEY = 'dsa_animations_deleted_v1';
const SYNC_ACCOUNT_KEY = 'dsa_sync_account_v1';
const DAILY_STUDY_LOG_KEY = 'dsa_daily_study_log_v1';
const DAILY_PRACTICE_PLAN_KEY = 'dsa_daily_practice_plan_v1';
const TOPIC_STUDY_KEY = 'dsa_topic_study_content_v1';
const QUESTION_NOTES_KEY = 'dsa_question_notes_v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEFERRED_PER_DAY = 3;
const MAX_DEFERRALS_PER_QUESTION = 2;
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
let topicStudyContent = loadTopicStudyContent();
let currentStudyTopic = null;
let questionNotes = loadQuestionNotes();
let currentQuestionNotesId = null;
let topicSearchQuery = '';
let topicDifficultyFilter = 'all';
let topicStatusFilter = 'all';
let topicPatternSort = 'original';
let reviewCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let reviewCalendarSelectedDay = todayKey();
let problemSearchMode = 'navigate';

function loadTopicStudyContent() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOPIC_STUDY_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function loadQuestionNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUESTION_NOTES_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function localDayStart(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function tomorrowStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function isReviewDue(record, now = Date.now()) {
  return Boolean(record?.completed && record.dueAt <= now && (!record.postponedUntil || record.postponedUntil <= now));
}

function deferredForDay(dayStart) {
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  return Object.values(questionProgress).filter(record => record.completed && record.postponedUntil >= dayStart && record.postponedUntil < nextDay.getTime());
}

function canPostpone(record) {
  return isReviewDue(record) && (record.postponeCount || 0) < MAX_DEFERRALS_PER_QUESTION && deferredForDay(tomorrowStart()).length < MAX_DEFERRED_PER_DAY;
}

function postponeReview(id) {
  const record = questionProgress[id];
  if (!record || !canPostpone(record)) return;
  record.postponeCount = (record.postponeCount || 0) + 1;
  record.postponedUntil = tomorrowStart();
  if (saveQuestionProgress()) refreshQuestionProgress();
}

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

const mistakeTypes = [
  ['concept', 'Concept gap'],
  ['edge-case', 'Missed edge case'],
  ['complexity', 'Complexity / approach'],
  ['implementation', 'Implementation bug'],
  ['misread', 'Misread problem'],
];
let pendingMistakeCauses = [];

function reviewIntervalDetails(difficulty, minutes, toughness, usedHint, previous) {
  const ratio = minutes / expectedMinutes(difficulty);
  const timeFactor = ratio <= 0.75 ? 1.25 : ratio <= 1.25 ? 1 : ratio <= 2 ? 0.75 : 0.55;
  const hintFactor = usedHint ? 0.75 : 1;
  const easeByToughness = [2.4, 2.05, 1.75, 1.4, 1.15];
  const firstIntervalByToughness = [14, 10, 7, 3, 1];
  const firstAttempt = !previous || previous.attempts < 1;
  const baseDays = firstAttempt ? firstIntervalByToughness[toughness - 1] : previous.intervalDays;
  const ratingFactor = firstAttempt ? 1 : easeByToughness[toughness - 1];
  const rawDays = baseDays * ratingFactor * timeFactor * hintFactor;
  const days = Math.max(1, Math.min(90, Math.round(rawDays)));
  return { days, baseDays, firstAttempt, ratingFactor, timeFactor, hintFactor, rawDays };
}

function nextReviewDays(difficulty, minutes, toughness, usedHint, previous) {
  return reviewIntervalDetails(difficulty, minutes, toughness, usedHint, previous).days;
}

function outcomeLabel(attempt) {
  if (attempt?.solvedWithoutHelp === true || attempt?.outcome === 'independent') return 'solved without help';
  if (attempt?.usedSolution || attempt?.outcome === 'solution') return 'needed solution';
  if (attempt?.usedHint || attempt?.outcome === 'hint') return 'used a hint';
  if (attempt?.usedHint === false) return 'solved without help';
  return 'outcome not recorded';
}

function latestAttempt(record) {
  return record?.history?.at(-1) || record || {};
}

function progressMeta(id) {
  const record = questionProgress[id];
  if (!record || !record.completed) return 'Not solved yet';
  const review = isReviewDue(record)
    ? 'Review due today'
    : `Review ${fmtDate(Math.max(record.dueAt, record.postponedUntil || 0))}`;
  const latest = latestAttempt(record);
  const categories = (latest.mistakeCategories || []).map(category => mistakeTypes.find(([key]) => key === category)?.[1] || String(category).replace(/^custom:/, '')).filter(Boolean);
  const causes = Array.isArray(latest.mistakeCauses) ? latest.mistakeCauses : [];
  const notes = [...categories, ...causes].slice(0, 2);
  const noteText = notes.length ? ` · ${notes.join(', ')}${categories.length + causes.length > notes.length ? '…' : ''}` : '';
  return `${review} · ${record.attempts} attempt${record.attempts === 1 ? '' : 's'} · rating ${latest.toughness || record.toughness}/5 · ${outcomeLabel(latest)}${noteText}`;
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

function hideAnimationTitleSuggestions() {
  const suggestions = document.getElementById('anim-title-suggestions');
  suggestions.hidden = true;
  suggestions.replaceChildren();
  titleInput.setAttribute('aria-expanded', 'false');
}

function chooseAnimationTitleSuggestion(entry) {
  titleInput.value = entry.problem.name;
  questionSelect.value = entry.ref;
  questionMatchWasChosen = true;
  updateQuestionMatchNote(entry);
  hideAnimationTitleSuggestions();
}

function renderAnimationTitleSuggestions() {
  const suggestions = document.getElementById('anim-title-suggestions');
  const query = normalizeQuestionText(titleInput.value);
  suggestions.replaceChildren();
  if (query.length < 2) {
    hideAnimationTitleSuggestions();
    return;
  }

  const matches = allQuestionEntries()
    .map(entry => ({ ...entry, normalizedName: normalizeQuestionText(entry.problem.name) }))
    .filter(entry => entry.normalizedName.includes(query))
    .sort((a, b) => Number(!a.normalizedName.startsWith(query)) - Number(!b.normalizedName.startsWith(query)) || a.problem.name.localeCompare(b.problem.name))
    .slice(0, 8);

  if (!matches.length) {
    hideAnimationTitleSuggestions();
    return;
  }

  matches.forEach(entry => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'anim-title-suggestion';
    option.dataset.questionRef = entry.ref;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const title = document.createElement('strong');
    title.textContent = entry.problem.name;
    const detail = document.createElement('span');
    const difficulty = entry.problem.d === 'E' ? 'Easy' : entry.problem.d === 'M' ? 'Medium' : 'Hard';
    detail.textContent = `${entry.pattern.name} · ${difficulty}`;
    option.append(title, detail);
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => chooseAnimationTitleSuggestion(entry));
    option.addEventListener('keydown', event => {
      const options = [...suggestions.querySelectorAll('.anim-title-suggestion')];
      const index = options.indexOf(option);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        options[Math.min(index + 1, options.length - 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (index === 0) titleInput.focus();
        else options[index - 1]?.focus();
      } else if (event.key === 'Escape') {
        hideAnimationTitleSuggestions();
        titleInput.focus();
      }
    });
    suggestions.appendChild(option);
  });
  suggestions.hidden = false;
  titleInput.setAttribute('aria-expanded', 'true');
}

function refreshQuestionAnimationButtons() {
  document.querySelectorAll('.pat-prow').forEach(row => {
    row.querySelector('.question-animation-actions')?.remove();
    const ref = row.dataset.questionRef;
    const animation = findAnimationForQuestion(ref);
    const problemName = row.querySelector('.pat-pname').textContent;
    const actions = document.createElement('div');
    actions.className = 'question-animation-actions';
    if (animation) {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'question-animation';
      play.textContent = '▶';
      play.title = `Open animation: ${animation.title}`;
      play.setAttribute('aria-label', `Open animation for ${problemName}`);
      play.addEventListener('click', event => {
        event.stopPropagation();
        openPlayer(animation.id);
      });
      actions.appendChild(play);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'question-animation question-animation-add';
    add.textContent = '+';
    add.title = `Add animation for ${problemName}`;
    add.setAttribute('aria-label', `Add animation for ${problemName}`);
    add.addEventListener('click', event => {
      event.stopPropagation();
      startAnimationForQuestion(ref);
    });
    actions.appendChild(add);
    row.appendChild(actions);
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

function applyPatternGridSort() {
  const grid = document.getElementById('pat-grid');
  const sort = document.getElementById('pat-sort')?.value || 'original';
  if (!grid) return;
  const order = PATTERNS.map((pattern, index) => ({ pattern, index }));
  if (sort === 'name') order.sort((a, b) => a.pattern.name.localeCompare(b.pattern.name));
  if (sort === 'most-complete' || sort === 'least-complete') {
    order.sort((a, b) => {
      const completion = entry => {
        const solved = entry.pattern.problems.filter(problem => questionProgress[questionId(problem)]?.completed).length;
        return solved / entry.pattern.problems.length;
      };
      const difference = completion(a) - completion(b);
      return (sort === 'most-complete' ? -difference : difference) || a.pattern.name.localeCompare(b.pattern.name);
    });
  }
  order.forEach(({ index }) => {
    const card = document.getElementById(`pc${index}`);
    if (card) grid.appendChild(card);
  });
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
  const due = Object.values(questionProgress).filter(record => isReviewDue(record)).length;
  document.getElementById('pat-info').textContent = `${vis} patterns · ${probs} problems · ${solved} solved · ${due} due`;
}

function openProgressDialog(id, mode) {
  const found = findQuestion(id);
  if (!found) return;
  pendingQuestionId = id;
  pendingProgressMode = mode;

  const record = questionProgress[id];
  const dialog = document.getElementById('progress-dialog');
  document.getElementById('progress-dialog-title').textContent = mode === 'review' ? 'Log review' : 'Log a solve';
  document.getElementById('progress-problem-title').textContent = `${found.problem.name} · ${found.pattern.name}`;
  document.getElementById('solve-minutes').value = record?.lastMinutes || String(expectedMinutes(found.problem.d));
  document.getElementById('solve-toughness').value = record?.toughness || '3';
  const latest = latestAttempt(record);
  const outcome = latest.outcome || (latest.solvedWithoutHelp === true ? 'independent' : latest.usedSolution ? 'solution' : latest.usedHint ? 'hint' : 'independent');
  document.getElementById('solve-outcome').value = outcome;
  const categories = Array.isArray(latest.mistakeCategories) ? latest.mistakeCategories : [];
  document.querySelectorAll('[name="mistake-category"]').forEach(check => {
    check.checked = categories.includes(check.value);
  });
  pendingMistakeCauses = [];
  document.getElementById('mistake-cause-input').value = '';
  renderMistakeCauses();
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
  const outcome = document.getElementById('solve-outcome').value;
  const usedHint = outcome !== 'independent';
  const details = reviewIntervalDetails(found.problem.d, minutes, toughness, usedHint, questionProgress[pendingQuestionId]);
  const dueDate = new Date(Date.now() + details.days * DAY_MS);
  const rating = details.firstAttempt
    ? `first interval ${details.baseDays}d for rating ${toughness}/5`
    : `prior interval ${details.baseDays}d × ${details.ratingFactor.toFixed(2)} rating factor`;
  const modifiers = `time × ${details.timeFactor.toFixed(2)} · ${usedHint ? 'help used × 0.75' : 'no help × 1.00'}`;
  document.getElementById('next-review-preview').textContent = `Next review: ${details.days} day${details.days === 1 ? '' : 's'} · ${fmtDate(dueDate.getTime())}. ${rating}; ${modifiers}. Rating 1 is easiest, 5 is hardest.`;
}

function recordAttempts(record) {
  if (Array.isArray(record?.history) && record.history.length) return record.history;
  return record ? [record] : [];
}

function countUnaidedReviews(record) {
  return recordAttempts(record).filter(attempt => attempt.mode === 'review' && outcomeLabel(attempt) === 'solved without help').length;
}

function progressCounts(entries) {
  const solved = entries.filter(entry => questionProgress[questionId(entry.problem)]?.completed);
  return {
    total: entries.length,
    solved: solved.length,
    attempts: solved.reduce((sum, entry) => sum + (questionProgress[questionId(entry.problem)].attempts || 0), 0),
    unaidedReviews: solved.reduce((sum, entry) => sum + countUnaidedReviews(questionProgress[questionId(entry.problem)]), 0),
  };
}

const TOPIC_AREAS = [
  { name: 'Arrays & Sequences', patterns: ['Two Pointers – Opposite Ends', 'Sliding Window – Fixed Size', 'Sliding Window – Variable Size', 'Prefix Sum', 'Binary Search', 'Greedy', 'Intervals', 'Sorting Techniques', 'Array In-place Tricks', 'Divide and Conquer / Recursion', 'Monotonic Queue / Deque', 'Fenwick Tree / Segment Tree', "Kadane's / Maximum Subarray Variants", 'Coordinate Compression & Difference Array', 'Random / Reservoir Sampling'] },
  { name: 'Strings', patterns: ['Two Pointers – Opposite Ends', 'Sliding Window – Fixed Size', 'Sliding Window – Variable Size', 'HashMap – Lookup & Grouping', 'Stack – Bracket / General', 'Trie (Prefix Tree)', 'Backtracking', '2D Dynamic Programming', 'HashMap – Frequency & Grouping', 'String Manipulation & Parsing'] },
  { name: 'Dynamic Programming', patterns: ['1D Dynamic Programming', '2D Dynamic Programming', 'Monotonic Queue / Deque', 'Divide and Conquer / Recursion', "Kadane's / Maximum Subarray Variants", 'Combinatorics & Counting', 'Stock Buy & Sell – State Machine DP', 'Interval DP', 'Bitmask DP', 'Game Theory / Minimax DP'] },
  { name: 'Linked Lists', patterns: ['Fast & Slow Pointers', 'Linked List Manipulation', 'Design / Data Structures'] },
  { name: 'Trees', patterns: ['DFS – Tree Recursion', 'Binary Search Tree', 'Tree Construction & Serialization', 'Tree Traversal Orders', 'Binary Lifting / LCA (Trees)'] },
  { name: 'Graphs', patterns: ['BFS – Shortest Path / Level Order', 'DFS – Graph / Grid', 'Union-Find (Disjoint Set)', 'Topological Sort', 'Dijkstra / Weighted Shortest Path', 'Graph – MST (Kruskal / Prim)', 'Eulerian Path / Circuit & Hierholzer'] },
  { name: 'Stacks & Queues', patterns: ['Stack – Monotonic', 'Stack – Bracket / General', 'Monotonic Queue / Deque'] },
  { name: 'Hash Maps & Sets', patterns: ['Prefix Sum', 'HashMap – Lookup & Grouping', 'HashMap – Frequency & Grouping'] },
  { name: 'Matrices & Grids', patterns: ['DFS – Graph / Grid', '2D Dynamic Programming', 'Matrix / Grid'] },
  { name: 'Data Structures', patterns: ['Heap / Priority Queue', 'Trie (Prefix Tree)', 'Union-Find (Disjoint Set)', 'Linked List Manipulation', 'Design / Data Structures', 'Monotonic Queue / Deque', 'Fenwick Tree / Segment Tree'] },
  { name: 'Math, Bits & Geometry', patterns: ['Bit Manipulation', 'Basics + Maths', 'Math & Number Theory', 'Combinatorics & Counting', 'Bitmask DP', 'Random / Reservoir Sampling', 'Geometry / Computational Geometry'] },
  { name: 'Other Topics', patterns: ['Concurrency Patterns'] },
];
let activeTopicArea = 'All Topics';

function uniquePatternEntries(patterns) {
  const unique = new Map();
  patterns.forEach(pattern => pattern.problems.forEach(problem => unique.set(questionId(problem), { pattern, problem })));
  return [...unique.values()];
}

function renderDifficultyTargets(container, entries) {
  const targets = document.createElement('div');
  targets.className = 'topic-difficulty-targets';
  [['E', 'Easy'], ['M', 'Medium'], ['H', 'Hard']].forEach(([code, label]) => {
    const total = entries.filter(entry => entry.problem.d === code).length;
    if (!total) return;
    const solved = entries.filter(entry => entry.problem.d === code && questionProgress[questionId(entry.problem)]?.completed).length;
    const target = document.createElement('span');
    target.className = `topic-difficulty-target${solved === total ? ' complete' : ''}`;
    target.textContent = `${label} ${solved}/${total} · ${total - solved} left`;
    targets.appendChild(target);
  });
  container.appendChild(targets);
}

function createTopicProgressBar(counts) {
  const wrap = document.createElement('div');
  wrap.className = 'topic-progress-meter';
  const track = document.createElement('div');
  track.className = 'topic-progress-meter-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(counts.total));
  track.setAttribute('aria-valuenow', String(counts.solved));
  track.setAttribute('aria-label', `${counts.solved} of ${counts.total} problems solved`);
  const fill = document.createElement('span');
  fill.style.width = `${counts.total ? counts.solved / counts.total * 100 : 0}%`;
  track.appendChild(fill);
  const percent = document.createElement('span');
  percent.className = 'topic-progress-meter-label';
  percent.textContent = `${counts.total ? Math.round(counts.solved / counts.total * 100) : 0}%`;
  wrap.append(track, percent);
  return wrap;
}

function renderPatternMastery(pattern, parent, filters = {}) {
  const entries = pattern.problems.map(problem => ({ pattern, problem }));
  const query = (filters.query || '').trim().toLowerCase();
  const topicMatches = query && filters.topicName?.toLowerCase().includes(query);
  const patternMatches = query && pattern.name.toLowerCase().includes(query);
  const visibleProblems = pattern.problems.filter(problem => {
    const id = questionId(problem);
    const record = questionProgress[id];
    if (query && !topicMatches && !patternMatches && !problem.name.toLowerCase().includes(query)) return false;
    if (filters.difficulty !== 'all' && problem.d !== filters.difficulty) return false;
    const due = isReviewDue(record);
    if (filters.status === 'unsolved' && record?.completed) return false;
    if (filters.status === 'solved' && !record?.completed) return false;
    if (filters.status === 'due' && !due) return false;
    return true;
  });
  if (!visibleProblems.length) return;
  const counts = progressCounts(entries);
  const item = document.createElement('details');
  item.className = 'topic-pattern';
  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.textContent = pattern.name;
  const status = document.createElement('span');
  status.textContent = counts.solved === counts.total ? `Complete · ${counts.total}/${counts.total}` : `${counts.solved}/${counts.total} · ${counts.total - counts.solved} left`;
  summary.append(name, status);
  item.appendChild(summary);
  item.appendChild(createTopicProgressBar(counts));
  renderDifficultyTargets(item, entries);
  const problemList = document.createElement('div');
  problemList.className = 'topic-problem-list';
  visibleProblems.forEach(problem => {
    const id = questionId(problem);
    const record = questionProgress[id];
    const row = document.createElement('div');
    row.className = 'topic-problem-row';
    const info = document.createElement('div');
    info.className = 'topic-problem-info';
    const problemName = document.createElement('a');
    problemName.href = problem.url;
    problemName.target = '_blank';
    problemName.rel = 'noopener';
    problemName.textContent = problem.name;
    const title = document.createElement('div');
    title.className = 'topic-problem-title';
    const difficulty = document.createElement('span');
    difficulty.className = `diff-badge diff-${problem.d}`;
    difficulty.textContent = problem.d === 'E' ? 'Easy' : problem.d === 'M' ? 'Med' : 'Hard';
    title.append(problemName, difficulty);
    const state = document.createElement('span');
    const due = isReviewDue(record);
    state.textContent = due ? 'Revision due' : record?.completed ? `Solved · next ${fmtDate(Math.max(record.dueAt || 0, record.postponedUntil || 0))}` : 'Not solved';
    info.append(title, state);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'fbtn topic-problem-action';
    if (!record?.completed) {
      action.textContent = 'Log solve';
      action.addEventListener('click', () => openProgressDialog(id, 'solve'));
    } else if (due) {
      action.textContent = 'Review';
      action.addEventListener('click', () => openProgressDialog(id, 'review'));
    } else {
      action.textContent = 'Solved';
      action.disabled = true;
    }
    const notes = document.createElement('button');
    notes.type = 'button';
    notes.className = 'fbtn topic-problem-notes';
    notes.textContent = questionNotes[id]?.text?.trim() ? 'Edit notes' : 'Add notes';
    notes.setAttribute('aria-label', `${notes.textContent} for ${problem.name}`);
    notes.addEventListener('click', () => openProblemNotes(id, problem.name));
    const actions = document.createElement('div');
    actions.className = 'topic-problem-actions';
    actions.append(action, notes);
    row.append(info, actions);
    problemList.appendChild(row);
  });
  item.appendChild(problemList);
  parent.appendChild(item);
}

function renderTopicStudyPreview(frame, html) {
  if (!html.trim()) {
    frame.srcdoc = '<!doctype html><html><body></body></html>';
    return;
  }
  frame.srcdoc = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:14px system-ui,sans-serif;color:#171717;padding:16px}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

function renderTopicStudyArea(topicName, parent) {
  const material = topicStudyContent[topicName] || { notes: '', html: '' };
  const section = document.createElement('section');
  section.className = 'topic-study-area';
  const head = document.createElement('div');
  head.className = 'topic-study-area-head';
  const title = document.createElement('h3');
  title.textContent = 'Study area';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'fbtn';
  edit.textContent = material.notes || material.html ? 'Edit study material' : 'Add study material';
  edit.addEventListener('click', () => openTopicStudyEditor(topicName));
  head.append(title, edit);
  section.appendChild(head);

  const content = document.createElement('div');
  content.className = 'topic-study-content';
  if (material.notes?.trim()) {
    const notes = document.createElement('p');
    notes.className = 'topic-study-notes';
    notes.textContent = material.notes;
    content.appendChild(notes);
  }
  if (material.html?.trim()) {
    const preview = document.createElement('iframe');
    preview.className = 'topic-study-preview';
    preview.title = `${topicName} study material preview`;
    preview.setAttribute('sandbox', 'allow-scripts');
    preview.setAttribute('referrerpolicy', 'no-referrer');
    renderTopicStudyPreview(preview, material.html);
    content.appendChild(preview);
  }
  if (!material.notes?.trim() && !material.html?.trim()) {
    const empty = document.createElement('p');
    empty.className = 'topic-study-empty';
    empty.textContent = 'Save notes, images, or HTML for this topic here.';
    content.appendChild(empty);
  }
  section.appendChild(content);
  parent.appendChild(section);
}

function openTopicStudyEditor(topicName) {
  currentStudyTopic = topicName;
  const material = topicStudyContent[topicName] || { notes: '', html: '' };
  document.getElementById('topic-study-title').textContent = `${topicName} study area`;
  document.getElementById('topic-study-notes').value = material.notes || '';
  document.getElementById('topic-study-html').value = material.html || '';
  document.getElementById('topic-study-image-file').value = '';
  renderTopicStudyPreview(document.getElementById('topic-study-preview'), material.html || '');
  document.getElementById('topic-study-dialog').showModal();
}

function openProblemNotes(questionIdValue, problemName) {
  currentQuestionNotesId = questionIdValue;
  document.getElementById('problem-notes-title').textContent = `${problemName} notes`;
  document.getElementById('problem-notes-text').value = questionNotes[questionIdValue]?.text || '';
  document.getElementById('problem-notes-dialog').showModal();
}

function renderTopicAreas() {
  const tabs = document.getElementById('topic-tabs');
  const container = document.getElementById('topic-area-list');
  if (!tabs || !container) return;
  tabs.replaceChildren();
  container.replaceChildren();

  const areas = [{ name: 'All Topics', patterns: PATTERNS }, ...TOPIC_AREAS.map(area => ({
    name: area.name,
    patterns: PATTERNS.filter(pattern => area.patterns.includes(pattern.name)),
  })).filter(area => area.patterns.length)];
  const search = (document.getElementById('topic-search')?.value || '').trim().toLowerCase();
  topicSearchQuery = search;
  const areaMatchesSearch = area => !search || area.name.toLowerCase().includes(search) || area.patterns.some(pattern =>
    pattern.name.toLowerCase().includes(search) || pattern.problems.some(problem => problem.name.toLowerCase().includes(search))
  );
  const visibleAreas = areas.filter(areaMatchesSearch);
  if (!visibleAreas.length) {
    container.textContent = 'No topics, patterns, or problems match your search.';
    container.classList.add('topic-no-results');
    return;
  }
  container.classList.remove('topic-no-results');
  if (!visibleAreas.some(area => area.name === activeTopicArea)) activeTopicArea = visibleAreas[0].name;

  visibleAreas.forEach(area => {
    const counts = progressCounts(uniquePatternEntries(area.patterns));
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `topic-tab${area.name === activeTopicArea ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(area.name === activeTopicArea));
    tab.setAttribute('aria-controls', 'topic-area-list');
    const label = document.createElement('span');
    label.textContent = area.name;
    const progress = document.createElement('span');
    progress.textContent = `${counts.solved}/${counts.total}`;
    tab.append(label, progress);
    tab.addEventListener('click', () => {
      activeTopicArea = area.name;
      renderTopicAreas();
    });
    tabs.appendChild(tab);
  });

  const selected = visibleAreas.find(area => area.name === activeTopicArea) || visibleAreas[0];
  const entries = uniquePatternEntries(selected.patterns);
  const counts = progressCounts(entries);
  const heading = document.createElement('div');
  heading.className = 'topic-selected-heading';
  const title = document.createElement('h2');
  title.textContent = selected.name;
  const status = document.createElement('span');
  status.textContent = counts.solved === counts.total ? `Complete · ${counts.total}/${counts.total}` : `${counts.solved}/${counts.total} solved · ${counts.total - counts.solved} left`;
  heading.append(title, status);
  container.setAttribute('role', 'tabpanel');
  container.setAttribute('aria-label', `${selected.name} topic patterns`);
  container.append(heading, createTopicProgressBar(counts));
  renderTopicStudyArea(selected.name, container);

  const patternsList = document.createElement('div');
  patternsList.className = 'topic-area-patterns';
  const patterns = [...selected.patterns];
  const patternCounts = pattern => progressCounts(pattern.problems.map(problem => ({ pattern, problem })));
  if (topicPatternSort === 'name') patterns.sort((a, b) => a.name.localeCompare(b.name));
  if (topicPatternSort === 'most-complete') patterns.sort((a, b) => {
    const left = patternCounts(a);
    const right = patternCounts(b);
    return (right.solved / right.total) - (left.solved / left.total) || a.name.localeCompare(b.name);
  });
  if (topicPatternSort === 'least-complete') patterns.sort((a, b) => {
    const left = patternCounts(a);
    const right = patternCounts(b);
    return (left.solved / left.total) - (right.solved / right.total) || a.name.localeCompare(b.name);
  });
  patterns.forEach(pattern => renderPatternMastery(pattern, patternsList, {
    query: topicSearchQuery,
    topicName: selected.name,
    difficulty: topicDifficultyFilter,
    status: topicStatusFilter,
  }));
  if (!patternsList.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'topic-no-results';
    empty.textContent = 'No problems match these filters.';
    patternsList.appendChild(empty);
  }
  container.appendChild(patternsList);
}

document.getElementById('topic-search').addEventListener('input', renderTopicAreas);
document.getElementById('topic-difficulty-filter').addEventListener('change', event => {
  topicDifficultyFilter = event.target.value;
  renderTopicAreas();
});
document.getElementById('topic-status-filter').addEventListener('change', event => {
  topicStatusFilter = event.target.value;
  renderTopicAreas();
});
document.getElementById('topic-pattern-sort').addEventListener('change', event => {
  topicPatternSort = event.target.value;
  renderTopicAreas();
});
document.getElementById('topic-expand-all').addEventListener('click', () => {
  document.querySelectorAll('#topic-area-list .topic-pattern').forEach(pattern => { pattern.open = true; });
});
document.getElementById('topic-collapse-all').addEventListener('click', () => {
  document.querySelectorAll('#topic-area-list .topic-pattern').forEach(pattern => { pattern.open = false; });
});

function renderProgressInsights() {
  const entries = allQuestionEntries();
  const difficultyContainer = document.getElementById('difficulty-progress');
  const mistakeContainer = document.getElementById('mistake-summary');
  difficultyContainer.replaceChildren();

  [['E', 'Easy'], ['M', 'Medium'], ['H', 'Hard']].forEach(([code, label]) => {
    const counts = progressCounts(entries.filter(entry => entry.problem.d === code));
    const card = document.createElement('div');
    card.className = 'difficulty-card';
    const head = document.createElement('div');
    head.className = 'difficulty-card-head';
    const name = document.createElement('strong');
    name.textContent = label;
    const fraction = document.createElement('span');
    fraction.textContent = `${counts.solved}/${counts.total}`;
    head.append(name, fraction);
    const track = document.createElement('div');
    track.className = 'difficulty-card-track';
    const fill = document.createElement('span');
    fill.style.width = `${counts.total ? counts.solved / counts.total * 100 : 0}%`;
    track.appendChild(fill);
    const meta = document.createElement('div');
    meta.className = 'difficulty-card-meta';
    meta.textContent = `${counts.attempts} attempts · ${counts.unaidedReviews} reviews solved without help`;
    card.append(head, track, meta);
    difficultyContainer.appendChild(card);
  });

  renderTopicAreas();

  mistakeContainer.replaceChildren();
  const categoryCounts = new Map(mistakeTypes.map(([key, label]) => [key, { label, count: 0 }]));
  Object.values(questionProgress).forEach(record => recordAttempts(record).forEach(attempt => {
    (Array.isArray(attempt.mistakeCategories) ? attempt.mistakeCategories : []).forEach(category => {
      if (categoryCounts.has(category)) categoryCounts.get(category).count++;
    });
  }));
  const frequentMistakes = [...categoryCounts.values()].filter(item => item.count).sort((a, b) => b.count - a.count);
  if (frequentMistakes.length) {
    const label = document.createElement('span');
    label.textContent = 'Mistakes logged:';
    mistakeContainer.appendChild(label);
    frequentMistakes.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'mistake-chip';
      chip.textContent = `${item.label} ${item.count}`;
      mistakeContainer.appendChild(chip);
    });
  }
}

function dueStatus(record) {
  const overdueDays = Math.floor((Date.now() - record.dueAt) / DAY_MS);
  return overdueDays <= 0 ? 'Due today' : `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`;
}

function dueReason(record) {
  const attempt = latestAttempt(record);
  const schedule = attempt.schedule;
  if (!schedule) return `Rating ${record.toughness}/5 and ${outcomeLabel(attempt)} set a ${record.intervalDays}-day interval.`;
  const rating = schedule.firstAttempt
    ? `rating ${attempt.toughness}/5 set the first gap to ${schedule.baseDays}d`
    : `rating ${attempt.toughness}/5 applied ×${schedule.ratingFactor.toFixed(2)} to the prior ${schedule.baseDays}d gap`;
  const help = schedule.hintFactor < 1 ? 'help used ×0.75' : 'no help ×1.00';
  return `${rating}; time ×${schedule.timeFactor.toFixed(2)}; ${help} → ${record.intervalDays}d. ${dueStatus(record)}.`;
}

function buildMistakeOptions(selected = new Set()) {
  const container = document.getElementById('mistake-categories');
  container.replaceChildren();
  mistakeTypes.forEach(([value, label]) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'mistake-option';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.name = 'mistake-category';
    check.value = value;
    check.checked = selected.has(value);
    const text = document.createElement('span');
    text.textContent = label;
    wrapper.append(check, text);
    container.appendChild(wrapper);
  });
}

function renderMistakeCauses() {
  const container = document.getElementById('mistake-causes');
  container.replaceChildren();
  pendingMistakeCauses.forEach((cause, index) => {
    const item = document.createElement('div');
    item.className = 'mistake-cause-item';
    const text = document.createElement('span');
    text.textContent = cause;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove bug cause ${index + 1}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      pendingMistakeCauses.splice(index, 1);
      renderMistakeCauses();
    });
    item.append(text, remove);
    container.appendChild(item);
  });
}

function addMistakeCause() {
  const input = document.getElementById('mistake-cause-input');
  const cause = input.value.trim().slice(0, 160);
  if (!cause) {
    toast('Enter a bug cause first.', true);
    input.focus();
    return;
  }
  if (pendingMistakeCauses.length >= 10) {
    toast('Add up to 10 bug causes for one attempt.', true);
    return;
  }
  pendingMistakeCauses.push(cause);
  renderMistakeCauses();
  input.value = '';
}

function renderProgressSummary() {
  renderProgressInsights();
  const records = Object.values(questionProgress).filter(record => record.completed);
  const due = records.filter(record => isReviewDue(record));
  const summary = document.getElementById('progress-summary');
  const list = document.getElementById('review-list');
  const empty = document.getElementById('review-empty');
  const attempts = records.reduce((sum, record) => sum + (record.attempts || 0), 0);
  const unaidedReviews = records.reduce((sum, record) => sum + countUnaidedReviews(record), 0);
  summary.textContent = `${records.length} solved · ${due.length} due · ${attempts} attempts · ${unaidedReviews} unaided reviews`;
  list.replaceChildren();

  if (due.length === 0) {
    const upcoming = records.map(record => Math.max(record.dueAt || 0, record.postponedUntil || 0)).filter(Boolean).sort((a, b) => a - b)[0];
    empty.textContent = upcoming
      ? `Nothing due today. Your next review is ${fmtDate(upcoming)}.`
      : 'Mark a question solved to start your review schedule.';
    renderToday();
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
    const latest = latestAttempt(record);
    const categories = Array.isArray(latest.mistakeCategories) ? latest.mistakeCategories : [];
    const categoryLabels = categories.map(category => mistakeTypes.find(([key]) => key === category)?.[1] || String(category).replace(/^custom:/, '')).filter(Boolean);
    details.textContent = `${found.pattern.name} · ${record.attempts} attempts · last ${outcomeLabel(latest)}${categoryLabels.length ? ` · ${categoryLabels.join(', ')}` : ''}`;
    const causes = Array.isArray(latest.mistakeCauses) ? latest.mistakeCauses : [];
    if (causes.length) details.textContent += ` · cause: ${causes.join('; ')}`;
    const why = document.createElement('span');
    why.className = 'review-card-why';
    why.textContent = dueReason(record);
    info.append(link, details, why);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fbtn review-log-button';
    button.textContent = 'Log review';
    button.addEventListener('click', () => openProgressDialog(record.id, 'review'));
    const actions = document.createElement('div');
    actions.className = 'today-task-actions';
    actions.appendChild(button);
    const postpone = document.createElement('button');
    postpone.type = 'button';
    postpone.className = 'fbtn today-defer';
    const allowed = canPostpone(record);
    postpone.textContent = allowed ? 'Move to tomorrow' : (record.postponeCount || 0) >= MAX_DEFERRALS_PER_QUESTION ? 'Move limit reached' : 'Tomorrow is full';
    postpone.disabled = !allowed;
    postpone.title = allowed ? 'Move this review to tomorrow. Each question can be moved twice; tomorrow accepts up to three moved reviews.' : 'You can move each question twice, with up to three moved reviews on any day.';
    postpone.addEventListener('click', () => postponeReview(record.id));
    actions.appendChild(postpone);
    card.append(info, actions);
    list.appendChild(card);
  });
  renderToday();
}

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function loadStudyLog() {
  try {
    const saved = JSON.parse(localStorage.getItem(DAILY_STUDY_LOG_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function loadDailyPracticePlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(DAILY_PRACTICE_PLAN_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function saveDailyPracticePlan(plan) {
  try {
    localStorage.setItem(DAILY_PRACTICE_PLAN_KEY, JSON.stringify(plan));
    localSyncVersion++;
    scheduleCloudSync();
    return true;
  } catch {
    toast('Could not save today’s plan. Browser storage may be full.', true);
    return false;
  }
}

function planDayStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}

function displayPlanDate(day) {
  return new Date(planDayStart(day)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function hasSolveSinceDay(id, day) {
  const start = planDayStart(day);
  return recordAttempts(questionProgress[id]).some(attempt => attempt.mode === 'solve' && attempt.at >= start);
}

function addPlannedProblem(id) {
  const plan = loadDailyPracticePlan();
  const day = todayKey();
  const entry = plan[day] && typeof plan[day] === 'object' ? plan[day] : { questionIds: [] };
  const questionIds = Array.isArray(entry.questionIds) ? entry.questionIds : [];
  if (questionIds.includes(id)) {
    toast('That problem is already on today’s plan.');
    return;
  }
  if (questionIds.length >= 100) {
    toast('Today’s plan can contain up to 100 problems.', true);
    return;
  }
  plan[day] = { ...entry, questionIds: [...questionIds, id], updatedAt: Date.now() };
  if (saveDailyPracticePlan(plan)) renderToday();
}

function removePlannedProblem(id) {
  const plan = loadDailyPracticePlan();
  const today = todayKey();
  const now = Date.now();
  let changed = false;
  for (const [day, entry] of Object.entries(plan)) {
    if (day > today || !Array.isArray(entry?.questionIds) || !entry.questionIds.includes(id)) continue;
    plan[day] = { ...entry, questionIds: entry.questionIds.filter(questionId => questionId !== id), updatedAt: now };
    changed = true;
  }
  if (changed && saveDailyPracticePlan(plan)) renderToday();
}

function todayPlannedProblems(today) {
  const plan = loadDailyPracticePlan();
  const todayEntry = plan[today];
  const currentIds = Array.isArray(todayEntry?.questionIds) ? todayEntry.questionIds : [];
  const planned = new Map();

  Object.keys(plan).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today).sort().forEach(day => {
    const entry = plan[day];
    if (!Array.isArray(entry?.questionIds)) return;
    entry.questionIds.forEach(id => {
      if (typeof id !== 'string' || hasSolveSinceDay(id, day)) return;
      const existing = planned.get(id);
      if (!existing) planned.set(id, { id, originDay: day, plannedToday: false });
      else if (existing.plannedToday && (!existing.originDay || day < existing.originDay)) existing.originDay = day;
    });
  });

  currentIds.forEach(id => {
    if (typeof id !== 'string') return;
    const existing = planned.get(id);
    planned.set(id, { id, originDay: existing?.originDay || null, plannedToday: true });
  });
  return [...planned.values()].filter(item => findQuestion(item.id));
}

function createTodayTask(title, detail) {
  const row = document.createElement('div');
  row.className = 'today-task';
  const info = document.createElement('div');
  info.className = 'today-task-info';
  const name = document.createElement('strong');
  name.textContent = title;
  const note = document.createElement('span');
  note.textContent = detail;
  info.append(name, note);
  const actions = document.createElement('div');
  actions.className = 'today-task-actions';
  row.append(info, actions);
  return { row, actions };
}

function createTodayCard(title, count, content) {
  const card = document.createElement('section');
  card.className = 'today-card';
  const head = document.createElement('div');
  head.className = 'today-card-head';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const countText = document.createElement('span');
  countText.textContent = count;
  head.append(heading, countText);
  card.append(head, content);
  return card;
}

function reviewCalendarKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftReviewCalendarMonth(offset) {
  const day = Number(reviewCalendarSelectedDay.slice(-2));
  const targetMonth = new Date(reviewCalendarMonth.getFullYear(), reviewCalendarMonth.getMonth() + offset, 1);
  const targetDay = Math.min(day, new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate());
  reviewCalendarMonth = targetMonth;
  reviewCalendarSelectedDay = `${targetMonth.getFullYear()}-${String(targetMonth.getMonth() + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function renderReviewCalendar() {
  const container = document.getElementById('review-calendar');
  if (!container) return;
  container.replaceChildren();

  const scheduled = Object.values(questionProgress).filter(record => record.completed && record.dueAt > 0)
    .map(record => ({ record, when: Math.max(record.dueAt, record.postponedUntil || 0), found: findQuestion(record.id) }))
    .filter(item => item.found);
  const byDay = new Map();
  scheduled.forEach(item => {
    const key = reviewCalendarKey(item.when);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  });

  const summary = document.createElement('summary');
  summary.className = 'review-calendar-summary';
  const monthPrefix = `${reviewCalendarMonth.getFullYear()}-${String(reviewCalendarMonth.getMonth() + 1).padStart(2, '0')}-`;
  const monthCount = scheduled.filter(item => reviewCalendarKey(item.when).startsWith(monthPrefix)).length;
  summary.textContent = `Review calendar · ${monthCount} scheduled this month`;
  container.appendChild(summary);

  const head = document.createElement('div');
  head.className = 'review-calendar-head';
  const heading = document.createElement('h2');
  heading.textContent = 'Browse dates';
  const nav = document.createElement('div');
  nav.className = 'review-calendar-nav';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'fbtn';
  previous.textContent = '‹';
  previous.setAttribute('aria-label', 'Previous month');
  previous.addEventListener('click', () => {
    shiftReviewCalendarMonth(-1);
    renderReviewCalendar();
  });
  const month = document.createElement('strong');
  month.textContent = reviewCalendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'fbtn';
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next month');
  next.addEventListener('click', () => {
    shiftReviewCalendarMonth(1);
    renderReviewCalendar();
  });
  nav.append(previous, month, next);
  head.append(heading, nav);
  container.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'review-calendar-grid';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
    const label = document.createElement('span');
    label.className = 'review-calendar-weekday';
    label.textContent = day;
    grid.appendChild(label);
  });
  const year = reviewCalendarMonth.getFullYear();
  const monthIndex = reviewCalendarMonth.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  for (let blank = 0; blank < firstWeekday; blank++) {
    const spacer = document.createElement('span');
    spacer.className = 'review-calendar-spacer';
    grid.appendChild(spacer);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const items = byDay.get(key) || [];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `review-calendar-day${key === reviewCalendarSelectedDay ? ' selected' : ''}${key === todayKey() ? ' today' : ''}${items.length ? ' has-reviews' : ''}`;
    button.setAttribute('aria-label', `${key}, ${items.length} review${items.length === 1 ? '' : 's'}`);
    button.setAttribute('aria-pressed', String(key === reviewCalendarSelectedDay));
    const number = document.createElement('span');
    number.textContent = String(day);
    button.appendChild(number);
    if (items.length) {
      const count = document.createElement('small');
      count.textContent = String(items.length);
      button.appendChild(count);
    }
    button.addEventListener('click', () => {
      reviewCalendarSelectedDay = key;
      renderReviewCalendar();
    });
    grid.appendChild(button);
  }
  container.appendChild(grid);

  const selectedItems = byDay.get(reviewCalendarSelectedDay) || [];
  const selected = document.createElement('div');
  selected.className = 'review-calendar-selected';
  const selectedHeading = document.createElement('h3');
  const [selectedYear, selectedMonth, selectedDay] = reviewCalendarSelectedDay.split('-').map(Number);
  selectedHeading.textContent = new Date(selectedYear, selectedMonth - 1, selectedDay).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  selected.appendChild(selectedHeading);
  if (!selectedItems.length) {
    const empty = document.createElement('p');
    empty.className = 'today-empty';
    empty.textContent = 'No reviews scheduled for this day.';
    selected.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'review-calendar-list';
    selectedItems.forEach(({ record, when, found }) => {
      const row = document.createElement('div');
      row.className = 'review-calendar-item';
      const info = document.createElement('div');
      info.className = 'today-task-info';
      const title = document.createElement('strong');
      title.textContent = found.problem.name;
      const detail = document.createElement('span');
      detail.textContent = `${found.pattern.name} · ${when < localDayStart() ? 'Overdue' : 'Review due'}`;
      info.append(title, detail);
      const review = document.createElement('button');
      review.type = 'button';
      review.className = `fbtn${isReviewDue(record) ? ' today-review-primary' : ''}`;
      review.textContent = 'Review';
      review.addEventListener('click', () => openProgressDialog(record.id, 'review'));
      row.append(info, review);
      list.appendChild(row);
    });
    selected.appendChild(list);
  }
  container.appendChild(selected);
}

function renderToday() {
  const container = document.getElementById('today-plan');
  if (!container) return;
  container.replaceChildren();
  const upcomingContainer = document.getElementById('today-upcoming');
  upcomingContainer?.replaceChildren();
  document.getElementById('today-date-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  renderReviewCalendar();

  const todayStart = localDayStart();
  const plannedProblems = todayPlannedProblems(todayKey());
  const plannedList = document.createElement('div');
  plannedList.className = 'today-task-list';
  const addPlanned = document.createElement('button');
  addPlanned.type = 'button';
  addPlanned.className = 'fbtn today-review-primary today-add-problem';
  addPlanned.textContent = 'Add problem';
  addPlanned.addEventListener('click', () => openProblemSearch('plan'));
  plannedList.appendChild(addPlanned);
  if (!plannedProblems.length) {
    const empty = document.createElement('p');
    empty.className = 'today-empty';
    empty.textContent = 'Add problems you plan to solve today. Unfinished problems will carry over to tomorrow.';
    plannedList.appendChild(empty);
  } else {
    plannedProblems.forEach(({ id, originDay }) => {
      const found = findQuestion(id);
      const solvedToday = recordAttempts(questionProgress[id]).some(attempt => attempt.mode === 'solve' && attempt.at >= todayStart);
      const detail = originDay ? `${found.pattern.name} · Leftover from ${displayPlanDate(originDay)}` : found.pattern.name;
      const task = createTodayTask(found.problem.name, detail);
      if (solvedToday) task.row.classList.add('is-complete');
      const link = document.createElement('a');
      link.href = found.problem.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open problem';
      task.actions.appendChild(link);
      const questionEntry = allQuestionEntries().find(entry => questionId(entry.problem) === id);
      if (questionEntry) {
        const addAnimation = document.createElement('button');
        addAnimation.type = 'button';
        addAnimation.className = 'fbtn today-add-animation';
        addAnimation.textContent = '+ Animation';
        addAnimation.setAttribute('aria-label', `Add animation for ${found.problem.name}`);
        addAnimation.addEventListener('click', () => startAnimationForQuestion(questionEntry.ref));
        task.actions.appendChild(addAnimation);
      }
      if (solvedToday) {
        const complete = document.createElement('span');
        complete.className = 'today-planned-complete';
        complete.textContent = 'Solved today';
        task.actions.appendChild(complete);
      } else {
        const solve = document.createElement('button');
        solve.type = 'button';
        solve.className = 'fbtn';
        solve.textContent = 'Log solve';
        solve.addEventListener('click', () => openProgressDialog(id, 'solve'));
        task.actions.appendChild(solve);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fbtn today-plan-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${found.problem.name} from today’s plan`);
      remove.addEventListener('click', () => removePlannedProblem(id));
      task.actions.appendChild(remove);
      plannedList.appendChild(task.row);
    });
  }
  container.appendChild(createTodayCard('Problems to solve today', `${plannedProblems.length} planned`, plannedList));

  const solvedToday = Object.values(questionProgress).map(record => {
    const attempts = record.completed ? recordAttempts(record).filter(attempt => attempt.mode === 'solve' && attempt.at >= todayStart) : [];
    const found = attempts.length ? findQuestion(record.id) : null;
    return found ? { record, found, attempts } : null;
  }).filter(Boolean).sort((a, b) => b.attempts.at(-1).at - a.attempts.at(-1).at);

  const due = Object.values(questionProgress).filter(record => isReviewDue(record)).sort((a, b) => a.dueAt - b.dueAt);
  const revisionList = document.createElement('div');
  revisionList.className = 'today-task-list';
  if (!due.length) {
    const empty = document.createElement('p');
    empty.className = 'today-empty';
    empty.textContent = 'No revisions are due today.';
    revisionList.appendChild(empty);
  } else {
    due.forEach(record => {
      const found = findQuestion(record.id);
      if (!found) return;
      const task = createTodayTask(found.problem.name, `${found.pattern.name} · ${dueReason(record)}`);
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'fbtn today-review-primary';
      review.textContent = 'Review';
      review.addEventListener('click', () => openProgressDialog(record.id, 'review'));
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'fbtn today-defer';
      const allowed = canPostpone(record);
      move.textContent = allowed ? 'Move to tomorrow' : (record.postponeCount || 0) >= MAX_DEFERRALS_PER_QUESTION ? 'Move limit reached' : 'Tomorrow is full';
      move.disabled = !allowed;
      move.title = 'At most three reviews can be moved to tomorrow, and each problem can be moved twice.';
      move.addEventListener('click', () => postponeReview(record.id));
      task.actions.append(review, move);
      revisionList.appendChild(task.row);
    });
  }
  container.appendChild(createTodayCard('Revision due', String(due.length), revisionList));

  const logSolveContent = document.createElement('div');
  logSolveContent.className = 'today-log-solve';
  const logSolveHelp = document.createElement('p');
  logSolveHelp.textContent = 'Find the problem you just worked on, then enter your time and whether you used a hint.';
  const logSolveButton = document.createElement('button');
  logSolveButton.type = 'button';
  logSolveButton.className = 'fbtn today-review-primary';
  logSolveButton.textContent = 'Log solve';
  logSolveButton.addEventListener('click', () => openProblemSearch('solve'));
  logSolveContent.append(logSolveHelp, logSolveButton);
  container.appendChild(createTodayCard('Log a solve', 'Choose any problem', logSolveContent));

  const solvedList = document.createElement('div');
  solvedList.className = 'today-task-list';
  if (!solvedToday.length) {
    const empty = document.createElement('p');
    empty.className = 'today-empty';
    empty.textContent = 'Problems you solve today will appear here.';
    solvedList.appendChild(empty);
  } else {
    solvedToday.forEach(({ found, attempts }) => {
      const latest = attempts.at(-1);
      const task = createTodayTask(found.problem.name, `${found.pattern.name} · ${attempts.length} solved today · latest ${outcomeLabel(latest)}`);
      const link = document.createElement('a');
      link.href = found.problem.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open problem';
      task.actions.appendChild(link);
      solvedList.appendChild(task.row);
    });
  }
  container.appendChild(createTodayCard('Solved today', `${solvedToday.length} problem${solvedToday.length === 1 ? '' : 's'}`, solvedList));

  const upcomingReviews = Object.values(questionProgress).filter(record => record.completed)
    .map(record => ({ record, when: Math.max(record.dueAt || 0, record.postponedUntil || 0), found: findQuestion(record.id) }))
    .filter(item => item.when > Date.now() && item.found)
    .sort((a, b) => a.when - b.when);
  const nextDay = upcomingReviews.length ? localDayStart(upcomingReviews[0].when) : null;
  const nextProblems = upcomingReviews;
  const nextCard = document.createElement('details');
  nextCard.className = 'today-card today-next-card';
  const nextHead = document.createElement('summary');
  nextHead.className = 'today-card-head';
  const nextHeading = document.createElement('h2');
  nextHeading.textContent = 'What’s next';
  const nextLabel = document.createElement('span');
  nextLabel.textContent = nextDay === null ? 'No upcoming reviews' : `${nextProblems.length} scheduled`;
  nextHead.append(nextHeading, nextLabel);
  const nextList = document.createElement('div');
  nextList.className = 'today-next-problems';
  if (nextProblems.length) {
    nextProblems.forEach(({ found, when }) => {
      const row = document.createElement('div');
      row.className = 'today-next-problem';
      const link = document.createElement('a');
      link.href = found.problem.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = found.problem.name;
      const date = document.createElement('span');
      date.textContent = fmtDate(when);
      row.append(link, date);
      nextList.appendChild(row);
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'today-empty';
    empty.textContent = 'No upcoming reviews.';
    nextList.appendChild(empty);
  }
  nextCard.append(nextHead, nextList);
  upcomingContainer?.appendChild(nextCard);

  const badge = document.getElementById('today-tab-count');
  if (badge) badge.textContent = String(due.length);
}
function refreshQuestionProgress() {
  document.querySelectorAll('.question-check').forEach(check => {
    const id = decodeURIComponent(check.dataset.questionId);
    check.checked = Boolean(questionProgress[id]?.completed);
  });
  document.querySelectorAll('[data-meta-id]').forEach(meta => {
    const id = decodeURIComponent(meta.dataset.metaId);
    meta.textContent = progressMeta(id);
  meta.classList.toggle('is-due', isReviewDue(questionProgress[id]));
  });
  updatePatInfo();
  renderProgressSummary();
  applyPatternGridSort();
  renderToday();
}

document.getElementById('progress-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingQuestionId) return;

  const found = findQuestion(pendingQuestionId);
  if (!found) return;
  const minutes = Number(document.getElementById('solve-minutes').value);
  const toughness = Number(document.getElementById('solve-toughness').value);
  const outcome = document.getElementById('solve-outcome').value;
  const usedHint = outcome !== 'independent';
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440 || toughness < 1 || toughness > 5) return;

  const previous = questionProgress[pendingQuestionId];
  const schedule = reviewIntervalDetails(found.problem.d, minutes, toughness, usedHint, previous);
  const intervalDays = schedule.days;
  const now = Date.now();
  const mistakeCategories = [...document.querySelectorAll('[name="mistake-category"]:checked')].map(check => check.value);
  const attempt = {
    at: now,
    minutes,
    toughness,
    usedHint,
    usedSolution: outcome === 'solution',
    solvedWithoutHelp: outcome === 'independent',
    outcome,
    mistakeCategories,
    mistakeCauses: [...pendingMistakeCauses],
    mode: pendingProgressMode,
    intervalDays,
    schedule: {
      firstAttempt: schedule.firstAttempt,
      baseDays: schedule.baseDays,
      ratingFactor: schedule.ratingFactor,
      timeFactor: schedule.timeFactor,
      hintFactor: schedule.hintFactor,
    },
  };
  questionProgress[pendingQuestionId] = {
    id: pendingQuestionId,
    completed: true,
    postponeCount: 0,
    postponedUntil: null,
    attempts: (previous?.attempts || 0) + 1,
    lastMinutes: minutes,
    toughness,
    usedHint,
    usedSolution: outcome === 'solution',
    solvedWithoutHelp: outcome === 'independent',
    outcome,
    mistakeCategories,
    mistakeCauses: [...pendingMistakeCauses],
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
document.getElementById('mistake-cause-add').addEventListener('click', addMistakeCause);
document.getElementById('mistake-cause-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addMistakeCause();
  }
});
['solve-minutes', 'solve-toughness', 'solve-outcome'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateReviewPreview);
  document.getElementById(id).addEventListener('change', updateReviewPreview);
});

document.getElementById('topic-study-html').addEventListener('input', event => {
  renderTopicStudyPreview(document.getElementById('topic-study-preview'), event.target.value);
});
async function insertTopicStudyImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('Choose an image file.', true);
    return;
  }
  let imageBlob = file;
  if (file.size > 512 * 1024) {
    try {
      const bitmap = await createImageBitmap(file);
      let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      let quality = 0.84;
      for (let attempt = 0; attempt < 12; attempt++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (!blob) break;
        imageBlob = blob;
        if (blob.size <= 512 * 1024) break;
        if (quality > 0.56) quality -= 0.1;
        else {
          scale *= 0.8;
          quality = 0.84;
        }
      }
      bitmap.close();
    } catch {
      toast('Could not resize that image. Try a smaller image file.', true);
      return;
    }
  }
  if (imageBlob.size > 512 * 1024) {
    toast('Could not compress that image below the storage limit. Try a smaller image.', true);
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    const html = document.getElementById('topic-study-html');
    const image = `<img src="${reader.result}" alt="Study image" style="max-width:100%;height:auto">`;
    if (html.value.length + image.length > 1_500_000) {
      toast('This topic’s HTML is too large to add another image.', true);
      return;
    }
    html.setRangeText(image, html.selectionStart, html.selectionEnd, 'end');
    html.dispatchEvent(new Event('input', { bubbles: true }));
  });
  reader.addEventListener('error', () => toast('Could not read that image.', true));
  reader.readAsDataURL(imageBlob);
}
document.getElementById('topic-study-html').addEventListener('paste', event => {
  const imageItem = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'));
  if (!imageItem) return;
  const image = imageItem.getAsFile();
  if (!image) return;
  event.preventDefault();
  insertTopicStudyImage(image);
});
document.getElementById('topic-study-add-image').addEventListener('click', () => {
  document.getElementById('topic-study-image-file').click();
});
document.getElementById('topic-study-image-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  insertTopicStudyImage(file);
});
document.getElementById('topic-study-cancel').addEventListener('click', () => {
  document.getElementById('topic-study-dialog').close();
  currentStudyTopic = null;
});
document.getElementById('topic-study-dialog').addEventListener('cancel', () => { currentStudyTopic = null; });
document.getElementById('topic-study-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!currentStudyTopic) return;
  const notes = document.getElementById('topic-study-notes').value;
  const html = document.getElementById('topic-study-html').value;
  topicStudyContent = {
    ...topicStudyContent,
    [currentStudyTopic]: { notes, html, updatedAt: Date.now() },
  };
  try {
    localStorage.setItem(TOPIC_STUDY_KEY, JSON.stringify(topicStudyContent));
  } catch {
    toast('Could not save the study area. Browser storage may be full.', true);
    return;
  }
  localSyncVersion++;
  scheduleCloudSync();
  document.getElementById('topic-study-dialog').close();
  currentStudyTopic = null;
  renderTopicAreas();
  toast('Study material saved.');
});
document.getElementById('problem-notes-cancel').addEventListener('click', () => {
  document.getElementById('problem-notes-dialog').close();
  currentQuestionNotesId = null;
});
document.getElementById('problem-notes-dialog').addEventListener('cancel', () => { currentQuestionNotesId = null; });
document.getElementById('problem-notes-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!currentQuestionNotesId) return;
  const text = document.getElementById('problem-notes-text').value;
  const nextNotes = {
    ...questionNotes,
    [currentQuestionNotesId]: { text, updatedAt: Date.now() },
  };
  try {
    localStorage.setItem(QUESTION_NOTES_KEY, JSON.stringify(nextNotes));
  } catch {
    toast('Could not save problem notes. Browser storage may be full.', true);
    return;
  }
  questionNotes = nextNotes;
  localSyncVersion++;
  scheduleCloudSync();
  document.getElementById('problem-notes-dialog').close();
  currentQuestionNotesId = null;
  renderTopicAreas();
  toast('Problem notes saved.');
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

document.getElementById('btn-add-animation').addEventListener('click', () => startAnimationForQuestion());

questionSelect.addEventListener('change', () => {
  questionMatchWasChosen = Boolean(questionSelect.value);
  updateQuestionMatchNote(getQuestionFromRef(questionSelect.value));
});
titleInput.addEventListener('input', () => {
  autoSelectRelatedQuestion();
  renderAnimationTitleSuggestions();
});
titleInput.addEventListener('keydown', event => {
  const suggestions = document.getElementById('anim-title-suggestions');
  if (suggestions.hidden) return;
  const options = [...suggestions.querySelectorAll('.anim-title-suggestion')];
  if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    options[0].focus();
  } else if (event.key === 'Enter' && options.length) {
    event.preventDefault();
    const match = getQuestionFromRef(options[0].dataset.questionRef);
    if (match) chooseAnimationTitleSuggestion(match);
  } else if (event.key === 'Escape') {
    hideAnimationTitleSuggestions();
  }
});

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
  if (name === 'today') renderToday();
}

function selectProblemSearchResult(ref) {
  const entry = getQuestionFromRef(ref);
  if (!entry) return;
  const { problem } = entry;
  document.getElementById('problem-search-input').setAttribute('aria-expanded', 'false');
  document.getElementById('problem-search-dialog').close();
  if (problemSearchMode === 'plan') {
    addPlannedProblem(questionId(problem));
    switchTab('today');
    return;
  }
  if (problemSearchMode === 'solve') {
    openProgressDialog(questionId(problem), 'solve');
    return;
  }
  switchTab('patterns');
  const search = document.getElementById('pat-search');
  search.value = problem.name;
  patActiveDiff = 'all';
  const diffButtons = document.querySelectorAll('#pat-controls > .fbtn');
  diffButtons.forEach(button => button.classList.remove('on'));
  diffButtons[0]?.classList.add('on');
  patFilter();
  const row = [...document.querySelectorAll('.pat-prow')].find(item => item.dataset.questionRef === ref);
  if (row) {
    row.closest('.pat-card')?.classList.add('open');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderProblemSearchResults() {
  const results = document.getElementById('problem-search-results');
  const query = document.getElementById('problem-search-input').value.trim().toLowerCase();
  results.replaceChildren();
  if (!query) {
    document.getElementById('problem-search-input').setAttribute('aria-expanded', 'false');
    const prompt = document.createElement('p');
    prompt.className = 'problem-search-empty';
    prompt.textContent = 'Type a problem or pattern name to search.';
    results.appendChild(prompt);
    return;
  }
  const matches = allQuestionEntries().filter(({ pattern, problem }) =>
    problem.name.toLowerCase().includes(query) || pattern.name.toLowerCase().includes(query)
  ).slice(0, 60);
  if (!matches.length) {
    document.getElementById('problem-search-input').setAttribute('aria-expanded', 'false');
    const empty = document.createElement('p');
    empty.className = 'problem-search-empty';
    empty.textContent = 'No matching problems.';
    results.appendChild(empty);
    return;
  }
  document.getElementById('problem-search-input').setAttribute('aria-expanded', 'true');
  matches.forEach(({ ref, pattern, problem }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'problem-search-result';
    button.dataset.questionRef = ref;
    button.setAttribute('role', 'option');
    const title = document.createElement('strong');
    title.textContent = problem.name;
    const detail = document.createElement('span');
    detail.textContent = `${pattern.name} · ${problem.d === 'E' ? 'Easy' : problem.d === 'M' ? 'Medium' : 'Hard'}`;
    button.append(title, detail);
    button.addEventListener('click', () => selectProblemSearchResult(ref));
    button.addEventListener('keydown', event => {
      const options = [...results.querySelectorAll('.problem-search-result')];
      const index = options.indexOf(button);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        options[Math.min(index + 1, options.length - 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (index === 0) document.getElementById('problem-search-input').focus();
        else options[index - 1]?.focus();
      }
    });
    results.appendChild(button);
  });
}

function openProblemSearch(mode = 'navigate') {
  problemSearchMode = mode;
  document.getElementById('problem-search-kicker').textContent = mode === 'solve' ? 'LOG PROGRESS' : mode === 'plan' ? 'TODAY’S PLAN' : 'QUICK SEARCH';
  document.getElementById('problem-search-title').textContent = mode === 'solve' ? 'Log a solve' : mode === 'plan' ? 'Add a problem to today' : 'Search problems';
  document.getElementById('problem-search-input').value = '';
  renderProblemSearchResults();
  document.getElementById('problem-search-dialog').showModal();
  document.getElementById('problem-search-input').focus();
}

function startAnimationForQuestion(ref = '') {
  const match = ref ? getQuestionFromRef(ref) : null;
  if (ref && !match) return;
  addForm.reset();
  fileInput.value = '';
  badgeLoaded.textContent = '';
  badgeLoaded.classList.remove('show');
  hideAnimationTitleSuggestions();
  switchTab('animations');
  showAnimView('add');
  questionSelect.value = match?.ref || '';
  questionMatchWasChosen = Boolean(match);
  updateQuestionMatchNote(match);
  document.getElementById('anim-title').focus();
}

const problemSearchInput = document.getElementById('problem-search-input');
problemSearchInput.setAttribute('aria-autocomplete', 'list');
problemSearchInput.setAttribute('aria-controls', 'problem-search-results');
problemSearchInput.setAttribute('aria-expanded', 'false');
problemSearchInput.addEventListener('input', renderProblemSearchResults);
problemSearchInput.addEventListener('keydown', event => {
  const options = [...document.querySelectorAll('#problem-search-results .problem-search-result')];
  if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    options[0].focus();
  } else if (event.key === 'Enter' && options.length === 1) {
    event.preventDefault();
    selectProblemSearchResult(options[0].dataset.questionRef);
  }
});
document.getElementById('problem-search-form').addEventListener('submit', event => event.preventDefault());
document.getElementById('problem-search-cancel').addEventListener('click', () => document.getElementById('problem-search-dialog').close());
document.getElementById('btn-global-search').addEventListener('click', () => openProblemSearch('navigate'));
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]');
  if ((event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault();
    openProblemSearch('navigate');
  }
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
    dailyStudyLog: loadStudyLog(),
    dailyPracticePlan: loadDailyPracticePlan(),
    topicStudyContent,
    questionNotes,
  };
}

function activateLocalSyncAccount(username) {
  if (!username) return;
  const previous = localStorage.getItem(SYNC_ACCOUNT_KEY);
  if (previous && previous !== username) {
    localStorage.removeItem(QUESTION_PROGRESS_KEY);
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(DELETED_ANIMATIONS_KEY);
    localStorage.removeItem(DAILY_STUDY_LOG_KEY);
    localStorage.removeItem(DAILY_PRACTICE_PLAN_KEY);
    localStorage.removeItem(TOPIC_STUDY_KEY);
    localStorage.removeItem(QUESTION_NOTES_KEY);
    questionProgress = {};
    topicStudyContent = {};
    questionNotes = {};
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
  const dailyStudyLog = {};
  for (const source of [remote.dailyStudyLog, local.dailyStudyLog]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [day, topics] of Object.entries(source)) {
      if (!Array.isArray(topics)) continue;
      dailyStudyLog[day] = [...new Set([...(dailyStudyLog[day] || []), ...topics])];
    }
  }
  const dailyPracticePlan = { ...(remote.dailyPracticePlan || {}) };
  for (const [day, plan] of Object.entries(local.dailyPracticePlan || {})) {
    if (!dailyPracticePlan[day] || plan.updatedAt > dailyPracticePlan[day].updatedAt) dailyPracticePlan[day] = plan;
  }
  const topicStudyContent = { ...(remote.topicStudyContent || {}) };
  for (const [topic, content] of Object.entries(local.topicStudyContent || {})) {
    if (!topicStudyContent[topic] || content.updatedAt > topicStudyContent[topic].updatedAt) topicStudyContent[topic] = content;
  }
  const questionNotes = { ...(remote.questionNotes || {}) };
  for (const [id, note] of Object.entries(local.questionNotes || {})) {
    if (!questionNotes[id] || note.updatedAt >= questionNotes[id].updatedAt) questionNotes[id] = note;
  }
  return { questionProgress, animations: [...animationsById.values()], deletedAnimationIds: [...deletedAnimationIds], dailyStudyLog, dailyPracticePlan, topicStudyContent, questionNotes };
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
  localStorage.setItem(DAILY_STUDY_LOG_KEY, JSON.stringify(state.dailyStudyLog || {}));
  localStorage.setItem(DAILY_PRACTICE_PLAN_KEY, JSON.stringify(state.dailyPracticePlan || {}));
  topicStudyContent = state.topicStudyContent || {};
  localStorage.setItem(TOPIC_STUDY_KEY, JSON.stringify(topicStudyContent));
  questionNotes = state.questionNotes || {};
  localStorage.setItem(QUESTION_NOTES_KEY, JSON.stringify(questionNotes));
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
  const { state: remote = { questionProgress: {}, animations: [], deletedAnimationIds: [], dailyStudyLog: {}, dailyPracticePlan: {}, topicStudyContent: {}, questionNotes: {} } } =
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
buildMistakeOptions();
updateQuestionMatchNote(null);
buildPatterns();
document.getElementById('pat-sort').addEventListener('change', applyPatternGridSort);
renderAnimCollection();
switchTab('today');
void initializeCloudSync();

// init animation tab badge from existing localStorage
(function() {
  const badge = document.getElementById('anim-tab-count');
  if (badge) badge.textContent = loadAnimations().length;
})();
