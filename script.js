const firebaseConfig = {
  apiKey: "AIzaSyAT6GuPdghvQA3YV0gJvq66ICg6MChj1Pg",
  authDomain: "aces-let-crown-challenge.firebaseapp.com",
  projectId: "aces-let-crown-challenge",
  storageBucket: "aces-let-crown-challenge.firebasestorage.app",
  messagingSenderId: "187730889786",
  appId: "1:187730889786:web:b1406b5f64c334d70c7903",
  measurementId: "G-3EV1NS7851"
};

const CATEGORY_CONFIG = {
  profed: {
    label: "ProfEd Crown Race",
    shortLabel: "ProfEd",
    title: "Weekly ACES ProfEd Crown Holder",
    scoresCollection: "aces_profed_weekly_scores",
    championsCollection: "aces_profed_weekly_crown_holders",
    localScoresKey: "acesProfedWeeklyScores",
    localChampionsKey: "acesProfedWeeklyCrownHolders"
  },
  gened: {
    label: "GenEd Crown Race",
    shortLabel: "GenEd",
    title: "Weekly ACES GenEd Crown Holder",
    scoresCollection: "aces_gened_weekly_scores",
    championsCollection: "aces_gened_weekly_crown_holders",
    localScoresKey: "acesGenedWeeklyScores",
    localChampionsKey: "acesGenedWeeklyCrownHolders"
  }
};

const PHT_TIMEZONE = "Asia/Manila";
const QUIZ_LENGTH = 10;
const ONE_DAY = 24 * 60 * 60 * 1000;

let firebaseReady = false;
let firebaseErrorMessage = "";
let db = null;
let firestore = {};

let selectedMode = "profed";
let currentQuiz = [];
let currentQuestionIndex = 0;
let currentScore = 0;
let answeredCurrentQuestion = false;
let timerInterval = null;
let timerStartedAt = null;
let latestResult = null;
let scoreSubmitted = false;

const $ = (id) => document.getElementById(id);

function safeText(value, fallback = "") {
  return String(value ?? fallback).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[char]));
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function chooseRandom(array) {
  if (!array.length) return null;
  return array[Math.floor(Math.random() * array.length)];
}

function groupByGroup(questions) {
  return questions.reduce((groups, question, index) => {
    const group = question.group || question.subject || "Ungrouped";
    if (!groups[group]) groups[group] = [];
    groups[group].push({ ...question, _id: question.id || `${group}-${index}`, group });
    return groups;
  }, {});
}

function normalizeAnswerText(value) {
  return String(value ?? "").trim();
}

function getCorrectAnswerText(question) {
  if (!Array.isArray(question.choices)) return "";
  if (typeof question.answer === "number") {
    return question.choices[question.answer];
  }
  return question.answer;
}

function shuffleChoicesForDisplay(question) {
  const correctAnswerText = getCorrectAnswerText(question);
  const originalChoices = Array.isArray(question.choices) ? [...question.choices] : [];
  const originalSignature = originalChoices.map(String).join("|||ALL_CHOICES|||");
  let shuffled = shuffle(originalChoices);

  // Try a few times to avoid showing the exact same arrangement when it is avoidable.
  if (originalChoices.length > 1 && new Set(originalChoices.map(String)).size > 1) {
    let attempts = 0;
    while (shuffled.map(String).join("|||ALL_CHOICES|||") === originalSignature && attempts < 8) {
      shuffled = shuffle(originalChoices);
      attempts++;
    }
  }

  const shuffledCorrectIndex = shuffled.findIndex(
    (choice) => normalizeAnswerText(choice) === normalizeAnswerText(correctAnswerText)
  );

  return {
    ...question,
    choices: shuffled,
    answer: shuffledCorrectIndex,
    correctAnswerText
  };
}

function randomizedChoices(question) {
  return shuffleChoicesForDisplay(question);
}

function buildGroupedQuiz(bank, categoryLabel, fileName) {
  const grouped = groupByGroup(bank);
  const groupNames = Object.keys(grouped);

  if (groupNames.length < QUIZ_LENGTH) {
    throw new Error(`${categoryLabel} requires at least ${QUIZ_LENGTH} available courses/groups in ${fileName}.`);
  }

  const selectedGroups = shuffle(groupNames).slice(0, QUIZ_LENGTH);
  const selected = selectedGroups.map((group) => chooseRandom(grouped[group])).filter(Boolean);

  if (selected.length < QUIZ_LENGTH) {
    throw new Error(`${categoryLabel} could not build a complete ${QUIZ_LENGTH}-question attempt.`);
  }

  return shuffle(selected).map(randomizedChoices);
}

function buildProfEdQuiz() {
  const bank = Array.isArray(window.PROFED_QUESTIONS) ? window.PROFED_QUESTIONS : [];
  return buildGroupedQuiz(bank, "ProfEd Crown Race", "profed-questions.js");
}

function buildGenEdQuiz() {
  const bank = Array.isArray(window.GENED_QUESTIONS) ? window.GENED_QUESTIONS : [];
  return buildGroupedQuiz(bank, "GenEd Crown Race", "gened-questions.js");
}

function buildQuiz(mode) {
  return mode === "profed" ? buildProfEdQuiz() : buildGenEdQuiz();
}

function getPHTParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") parts[part.type] = part.value;
  });
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function dateKeyFromUTCDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekInfoFromDate(date = new Date(), offsetWeeks = 0) {
  const pht = getPHTParts(date);
  const phtCalendarUTC = Date.UTC(pht.year, pht.month - 1, pht.day);
  const dayOfWeek = new Date(phtCalendarUTC).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const weekStartMs = phtCalendarUTC - daysSinceMonday * ONE_DAY + offsetWeeks * 7 * ONE_DAY;
  const weekEndMs = weekStartMs + 6 * ONE_DAY;
  const weekStartDate = new Date(weekStartMs);
  const weekEndDate = new Date(weekEndMs);
  return {
    weekKey: dateKeyFromUTCDate(weekStartDate),
    weekStartMs,
    weekEndMs,
    weekLabel: `${formatDateOnlyPHTLike(weekStartDate)}–${formatDateOnlyPHTLike(weekEndDate)}`
  };
}

function formatDateOnlyPHTLike(utcDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(utcDate);
}

function formatDateTimePHT(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PHT_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatTime(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function compareRankingEntries(a, b) {
  const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
  if (scoreDiff !== 0) return scoreDiff;
  const timeDiff = Number(a.timeSeconds || 999999) - Number(b.timeSeconds || 999999);
  if (timeDiff !== 0) return timeDiff;
  return Number(a.submittedAtMs || 0) - Number(b.submittedAtMs || 0);
}

function sortRankings(entries) {
  return [...entries].sort(compareRankingEntries);
}

function normalizePlayerField(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getPlayerKey(entry) {
  return `${normalizePlayerField(entry.name)}|||${normalizePlayerField(entry.section)}`;
}

function isBetterAttempt(candidate, currentBest) {
  if (!currentBest) return true;
  return compareRankingEntries(candidate, currentBest) < 0;
}

function getBestAttemptsByPlayer(entries) {
  const bestByPlayer = new Map();

  entries.forEach((entry) => {
    const playerKey = getPlayerKey(entry);
    if (!playerKey || playerKey === "|||") return;
    const currentBest = bestByPlayer.get(playerKey);
    if (isBetterAttempt(entry, currentBest)) {
      bestByPlayer.set(playerKey, entry);
    }
  });

  return Array.from(bestByPlayer.values());
}

function getPlayerInfo() {
  return {
    name: $("studentName").value.trim(),
    section: $("studentSection").value.trim()
  };
}

function showScreen(id) {
  const targetScreen = $(id);
  if (!targetScreen) {
    console.error(`Screen not found: ${id}`);
    return;
  }
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  targetScreen.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setMode(mode) {
  selectedMode = mode;
  document.querySelectorAll(".mode-card").forEach((card) => card.classList.toggle("selected", card.dataset.mode === mode));
  const ruleBox = $("modeRuleBox");
  if (ruleBox) {
    ruleBox.textContent = "Answer 10 questions and aim for the weekly crown.";
  }
}

function startGame() {
  const player = getPlayerInfo();
  if (!player.name || !player.section) {
    $("entryError").classList.add("show");
    showScreen("setupScreen");
    return;
  }
  $("entryError").classList.remove("show");

  try {
    currentQuiz = buildQuiz(selectedMode);
  } catch (error) {
    alert(error.message);
    return;
  }

  currentQuestionIndex = 0;
  currentScore = 0;
  latestResult = null;
  scoreSubmitted = false;
  answeredCurrentQuestion = false;
  timerStartedAt = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);

  $("playerPill").textContent = player.name;
  $("modePill").textContent = CATEGORY_CONFIG[selectedMode].label;
  $("scorePill").textContent = "Score: 0";
  $("timerPill").textContent = "Time: 0s";
  showScreen("gameScreen");
  renderQuestion();
}

function updateTimer() {
  if (!timerStartedAt) return;
  const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
  $("timerPill").textContent = `Time: ${formatTime(elapsed)}`;
}

function renderQuestion() {
  const question = currentQuiz[currentQuestionIndex];
  answeredCurrentQuestion = false;
  $("questionPill").textContent = `Question ${currentQuestionIndex + 1} of ${QUIZ_LENGTH}`;
  $("scorePill").textContent = `Score: ${currentScore}`;
  $("progressBar").style.width = `${(currentQuestionIndex / QUIZ_LENGTH) * 100}%`;
  $("groupLine").textContent = question.group || "Course";
  $("questionText").textContent = question.question;
  $("feedbackBox").className = "feedback";
  $("feedbackBox").textContent = "";
  $("nextButton").style.display = "none";

  $("choicesBox").innerHTML = question.choices.map((choice, index) => `
    <button type="button" class="choice-btn" data-choice-index="${index}">
      <strong>${String.fromCharCode(65 + index)}.</strong> ${safeText(choice)}
    </button>
  `).join("");
}

function answerQuestion(choiceIndex) {
  if (answeredCurrentQuestion) return;
  answeredCurrentQuestion = true;
  const question = currentQuiz[currentQuestionIndex];
  const selectedAnswerText = question.choices[choiceIndex];
  const correctAnswerText = question.correctAnswerText ?? getCorrectAnswerText(question);
  const correctDisplayIndex = question.choices.findIndex(
    (choice) => normalizeAnswerText(choice) === normalizeAnswerText(correctAnswerText)
  );
  const isCorrect = normalizeAnswerText(selectedAnswerText) === normalizeAnswerText(correctAnswerText);
  if (isCorrect) currentScore++;

  document.querySelectorAll(".choice-btn").forEach((button) => {
    const index = Number(button.dataset.choiceIndex);
    button.disabled = true;
    if (index === correctDisplayIndex) button.classList.add("correct");
    if (index === choiceIndex && !isCorrect) button.classList.add("incorrect");
  });

  $("scorePill").textContent = `Score: ${currentScore}`;
  const feedback = $("feedbackBox");
  feedback.className = `feedback show ${isCorrect ? "correct" : "incorrect"}`;
  feedback.textContent = isCorrect
    ? "Correct!"
    : `Incorrect. Correct answer: ${String.fromCharCode(65 + correctDisplayIndex)}. ${correctAnswerText}`;

  $("nextButton").style.display = "inline-flex";
}

function nextQuestion() {
  if (!answeredCurrentQuestion) {
    alert("Please select an answer first.");
    return;
  }
  currentQuestionIndex++;
  if (currentQuestionIndex >= QUIZ_LENGTH) {
    finishGame();
  } else {
    renderQuestion();
  }
}

function finishGame() {
  clearInterval(timerInterval);
  const timeSeconds = Math.floor((Date.now() - timerStartedAt) / 1000);
  const player = getPlayerInfo();
  const currentWeek = weekInfoFromDate(new Date());
  latestResult = {
    ...player,
    mode: selectedMode,
    categoryLabel: CATEGORY_CONFIG[selectedMode].label,
    score: currentScore,
    total: QUIZ_LENGTH,
    percentage: Math.round((currentScore / QUIZ_LENGTH) * 100),
    timeSeconds,
    weekKey: currentWeek.weekKey,
    weekStartMs: currentWeek.weekStartMs,
    weekLabel: currentWeek.weekLabel,
    groups: [...new Set(currentQuiz.map((q) => q.group))]
  };

  $("progressBar").style.width = "100%";
  $("resultSummary").textContent = `${latestResult.categoryLabel} • ${latestResult.score}/${latestResult.total} • ${formatTime(timeSeconds)}`;
  $("scoreOrb").textContent = `${latestResult.score}/${latestResult.total}`;
  $("resultTitle").textContent = currentScore === QUIZ_LENGTH ? "Excellent Crown Race Performance!" : "Good Crown Race Attempt!";
  $("resultMessage").textContent = currentScore === QUIZ_LENGTH
    ? "You completed the Crown Race with a perfect score. Submit your result to join the weekly race."
    : "You completed the Crown Race. Submit your score if you want to join this week's ranking.";
  $("performanceBreakdown").innerHTML = `
    <div class="breakdown-card"><strong>${latestResult.score}/${latestResult.total}</strong><span>Score</span></div>
    <div class="breakdown-card"><strong>${latestResult.percentage}%</strong><span>Accuracy</span></div>
    <div class="breakdown-card"><strong>${formatTime(latestResult.timeSeconds)}</strong><span>Time Used</span></div>
    <div class="breakdown-card"><strong>${latestResult.categoryLabel}</strong><span>Category</span></div>
  `;
  $("submitScoreButton").disabled = false;
  $("submitStatus").textContent = "Your score has not been submitted yet.";
  showScreen("resultScreen");
}

function quitGame() {
  const confirmQuit = confirm("Quit this Crown Race and return to setup?");
  if (!confirmQuit) return;
  clearInterval(timerInterval);
  showScreen("setupScreen");
}

async function initFirebase() {
  try {
    const appModule = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
    const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    const app = appModule.initializeApp(firebaseConfig);
    db = firestoreModule.getFirestore(app);
    firestore = firestoreModule;
    firebaseReady = true;
    firebaseErrorMessage = "";
  } catch (error) {
    firebaseReady = false;
    firebaseErrorMessage = error?.message || "Firebase is unavailable.";
    console.warn("Firebase unavailable. Local testing mode is active.", error);
  }
  updateStorageStatus();
}

function updateStorageStatus() {
  const status = $("firebaseStatus");
  if (!status) return;
  status.textContent = firebaseReady
    ? "Leaderboard is ready."
    : "Leaderboard is temporarily unavailable. Please try again later.";
}

function readLocalArray(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function writeLocalArray(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function withFirebaseFallback(operation, fallback) {
  if (!firebaseReady) return fallback();
  try {
    return await operation();
  } catch (error) {
    firebaseReady = false;
    firebaseErrorMessage = error?.message || "Firebase request failed.";
    updateStorageStatus();
    console.warn("Firebase request failed. Local testing mode is active.", error);
    return fallback();
  }
}

async function saveScoreEntry(entry) {
  const config = CATEGORY_CONFIG[entry.mode];
  const submittedAtMs = Date.now();
  const payload = {
    ...entry,
    submittedAtMs,
    submittedAtText: formatDateTimePHT(submittedAtMs),
    createdAt: firebaseReady && firestore.serverTimestamp ? firestore.serverTimestamp() : submittedAtMs
  };

  return withFirebaseFallback(
    async () => {
      await firestore.addDoc(firestore.collection(db, config.scoresCollection), payload);
      return payload;
    },
    () => {
      const scores = readLocalArray(config.localScoresKey);
      scores.push({ ...payload, id: `local-${submittedAtMs}` });
      writeLocalArray(config.localScoresKey, scores);
      return payload;
    }
  );
}

async function getScores(category, weekKey) {
  const config = CATEGORY_CONFIG[category];
  return withFirebaseFallback(
    async () => {
      const q = firestore.query(
        firestore.collection(db, config.scoresCollection),
        firestore.where("weekKey", "==", weekKey)
      );
      const snapshot = await firestore.getDocs(q);
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    },
    () => readLocalArray(config.localScoresKey).filter((entry) => entry.weekKey === weekKey)
  );
}

async function getChampions(category) {
  const config = CATEGORY_CONFIG[category];
  return withFirebaseFallback(
    async () => {
      const snapshot = await firestore.getDocs(firestore.collection(db, config.championsCollection));
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    },
    () => readLocalArray(config.localChampionsKey)
  );
}

async function saveChampion(category, champion) {
  const config = CATEGORY_CONFIG[category];
  const payload = {
    ...champion,
    finalizedAtMs: Date.now(),
    finalizedAtText: formatDateTimePHT(Date.now()),
    finalizedAt: firebaseReady && firestore.serverTimestamp ? firestore.serverTimestamp() : Date.now()
  };
  return withFirebaseFallback(
    async () => {
      await firestore.setDoc(firestore.doc(db, config.championsCollection, champion.weekKey), payload, { merge: true });
      return payload;
    },
    () => {
      const champions = readLocalArray(config.localChampionsKey).filter((entry) => entry.weekKey !== champion.weekKey);
      champions.push(payload);
      writeLocalArray(config.localChampionsKey, champions);
      return payload;
    }
  );
}

async function finalizeWeek(category, weekInfo) {
  const champions = await getChampions(category);
  if (champions.some((champion) => champion.weekKey === weekInfo.weekKey)) return;

  const scores = await getScores(category, weekInfo.weekKey);
  if (!scores.length) return;

  const winner = sortRankings(getBestAttemptsByPlayer(scores))[0];
  if (!winner) return;
  await saveChampion(category, {
    mode: category,
    categoryLabel: CATEGORY_CONFIG[category].label,
    title: CATEGORY_CONFIG[category].title,
    weekKey: weekInfo.weekKey,
    weekStartMs: weekInfo.weekStartMs,
    weekEndMs: weekInfo.weekEndMs,
    weekLabel: weekInfo.weekLabel,
    name: winner.name,
    section: winner.section,
    score: winner.score,
    total: winner.total,
    percentage: winner.percentage,
    timeSeconds: winner.timeSeconds,
    submittedAtMs: winner.submittedAtMs,
    submittedAtText: winner.submittedAtText
  });
}

async function finalizeRecentWeeks() {
  for (const category of ["profed", "gened"]) {
    for (let offset = -1; offset >= -8; offset--) {
      await finalizeWeek(category, weekInfoFromDate(new Date(), offset));
    }
  }
}

function latestChampions(champions, count = 5) {
  return [...champions]
    .sort((a, b) => Number(b.weekStartMs || 0) - Number(a.weekStartMs || 0))
    .slice(0, count);
}

async function submitScore() {
  if (!latestResult || scoreSubmitted) return;
  $("submitScoreButton").disabled = true;
  $("submitStatus").textContent = "Submitting score...";
  try {
    await saveScoreEntry(latestResult);
    scoreSubmitted = true;
    $("submitStatus").textContent = "Score submitted successfully. You are now part of this week's ranking.";
    await refreshAllLeaderboards();
  } catch (error) {
    $("submitScoreButton").disabled = false;
    $("submitStatus").textContent = "Score submission is temporarily unavailable. Please try again later.";
    console.error(error);
  }
}

function renderChampionBox(elementId, champion) {
  const box = $(elementId);
  if (!champion) {
    box.innerHTML = `<p class="muted">No weekly champion recorded yet.</p>`;
    return;
  }
  box.innerHTML = `
    <span class="leader-name">${safeText(champion.name)}</span>
    <span class="leader-detail">${safeText(champion.section)}</span>
    <span class="leader-detail">Week: ${safeText(champion.weekLabel)}</span>
    <span class="leader-score">${Number(champion.score)}/${Number(champion.total)} • ${formatTime(champion.timeSeconds)}</span>
  `;
}

function renderTopContenderText(elementId, contender) {
  const element = $(elementId);
  if (!contender) {
    element.textContent = "No contender yet";
    return;
  }
  element.textContent = `${contender.name} — ${contender.score}/${contender.total} • ${formatTime(contender.timeSeconds)}`;
}

function renderChampionsTable(elementId, champions) {
  const container = $(elementId);
  const ordered = latestChampions(champions, 5);
  if (!ordered.length) {
    container.innerHTML = `<p class="muted" style="padding:14px; margin:0;">No weekly champions recorded yet.</p>`;
    return;
  }
  container.innerHTML = `
    <table>
      <thead><tr><th>Week</th><th>Crown Holder</th><th>Year & Section</th><th>Score</th><th>Time</th></tr></thead>
      <tbody>
        ${ordered.map((champion) => `
          <tr>
            <td>${safeText(champion.weekLabel)}</td>
            <td><strong>${safeText(champion.name)}</strong></td>
            <td>${safeText(champion.section)}</td>
            <td>${Number(champion.score)}/${Number(champion.total)}</td>
            <td>${formatTime(champion.timeSeconds)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderContendersTable(elementId, contenders) {
  const container = $(elementId);
  const ordered = sortRankings(getBestAttemptsByPlayer(contenders)).slice(0, 5);
  if (!ordered.length) {
    container.innerHTML = `<p class="muted" style="padding:14px; margin:0;">No contenders for the current week yet.</p>`;
    return;
  }
  container.innerHTML = `
    <table>
      <thead><tr><th>Rank</th><th>Player</th><th>Year & Section</th><th>Score</th><th>Time</th><th>Submitted</th></tr></thead>
      <tbody>
        ${ordered.map((entry, index) => `
          <tr>
            <td><span class="rank-badge">${index + 1}</span></td>
            <td><strong>${safeText(entry.name)}</strong></td>
            <td>${safeText(entry.section)}</td>
            <td>${Number(entry.score)}/${Number(entry.total)}</td>
            <td>${formatTime(entry.timeSeconds)}</td>
            <td>${safeText(entry.submittedAtText || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function loadHomepage() {
  await finalizeRecentWeeks();
  const currentWeek = weekInfoFromDate(new Date());

  const [profedChampions, genedChampions, profedScores, genedScores] = await Promise.all([
    getChampions("profed"),
    getChampions("gened"),
    getScores("profed", currentWeek.weekKey),
    getScores("gened", currentWeek.weekKey)
  ]);

  renderChampionBox("homeProfedChampion", latestChampions(profedChampions, 1)[0]);
  renderChampionBox("homeGenedChampion", latestChampions(genedChampions, 1)[0]);
  renderTopContenderText("homeProfedContender", sortRankings(getBestAttemptsByPlayer(profedScores))[0]);
  renderTopContenderText("homeGenedContender", sortRankings(getBestAttemptsByPlayer(genedScores))[0]);
}

async function loadLeaderboards() {
  await finalizeRecentWeeks();
  const currentWeek = weekInfoFromDate(new Date());
  const [profedChampions, genedChampions, profedScores, genedScores] = await Promise.all([
    getChampions("profed"),
    getChampions("gened"),
    getScores("profed", currentWeek.weekKey),
    getScores("gened", currentWeek.weekKey)
  ]);

  renderChampionsTable("profedChampionsList", profedChampions);
  renderContendersTable("profedContendersList", profedScores);
  renderChampionsTable("genedChampionsList", genedChampions);
  renderContendersTable("genedContendersList", genedScores);
  updateStorageStatus();
}

async function refreshAllLeaderboards() {
  await Promise.all([loadHomepage(), loadLeaderboards()]);
}

function attachEventListeners() {
  document.addEventListener("click", async (event) => {
    const modeCard = event.target.closest(".mode-card[data-mode]");
    if (modeCard) {
      event.preventDefault();
      setMode(modeCard.dataset.mode);
      return;
    }

    const choice = event.target.closest(".choice-btn[data-choice-index]");
    if (choice) {
      event.preventDefault();
      answerQuestion(Number(choice.dataset.choiceIndex));
      return;
    }

    const refreshButton = event.target.closest("[data-refresh]");
    if (refreshButton) {
      event.preventDefault();
      await loadLeaderboards();
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;

    event.preventDefault();
    const action = actionButton.dataset.action;

    try {
      if (action === "go-home") {
        showScreen("homeScreen");
        loadHomepage().catch((error) => console.warn("Homepage data could not be loaded.", error));
      } else if (action === "go-setup") {
        showScreen("setupScreen");
      } else if (action === "go-leaderboard") {
        showScreen("leaderboardScreen");
        loadLeaderboards().catch((error) => console.warn("Leaderboard data could not be loaded.", error));
      } else if (action === "start-game") {
        startGame();
      } else if (action === "next-question") {
        nextQuestion();
      } else if (action === "quit-game") {
        quitGame();
      } else if (action === "submit-score") {
        await submitScore();
      } else if (action === "refresh-all") {
        await refreshAllLeaderboards();
      }
    } catch (error) {
      console.error(`Action failed: ${action}`, error);
      alert("Something went wrong. Please refresh the page and try again.");
    }
  });
}

async function boot() {
  attachEventListeners();
  setMode("profed");
  await initFirebase();
  loadHomepage().catch((error) => console.warn("Homepage data could not be loaded.", error));
}

function startApp() {
  boot().catch((error) => {
    console.error("ACES LET Crown Challenge failed to initialize.", error);
    const status = $("firebaseStatus");
    if (status) status.textContent = "Leaderboard is temporarily unavailable. Please try again later.";
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
