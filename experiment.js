"use strict";

// Add the DataPipe experiment ID here before data collection. Configure two
// conditions in DataPipe: 0 = gain_larger, 1 = loss_larger.
const DATAPIPE_EXPERIMENT_ID = "IYVU1vExfBFD";

const INITIAL_ENDOWMENT = 45;
const CENTS_PER_TOKEN = 5;
const MIN_STRATEGY_WORDS = 20;
const MIN_FULLSCREEN_WIDTH = 900;
const MIN_FULLSCREEN_HEIGHT = 600;
const experimentStartPerf = performance.now();

const CONDITION_TABLE = [
  { conditionIndex: 0, conditionLabel: "gain_larger", gainLarge: 1 },
  { conditionIndex: 1, conditionLabel: "loss_larger", gainLarge: 0 }
];

const PRACTICE_TEMPLATE = [
  { gain: 1, loss: 2, gainOnLeft: 1 },
  { gain: 2, loss: 1, gainOnLeft: 0 },
  { gain: 1, loss: 2, gainOnLeft: 0 }
];

const TEXT = {
  postComprehension: "You are about to begin the decision-making part of the study.\n\nOn the next page, the background will change to gray. You will only need the keyboard to complete the practice trials and the main task; you will not need a mouse or trackpad.\n\nWhen you are ready, press the Enter key to continue to the next page.",
  practice: "You will now complete three practice trials.\n\nPractice trials will not be selected to determine your final payment.\n\n\nWhen you are ready, press the \"SPACEBAR\" to start the practice trials",
  start: "Practice completed! The main task is about to begin.\n\nYour decision time will be recorded,\nso once the task begins, please do not get distracted.\nPlease stay focused until you finish the task.\n\nIf you are ready,\npress the \"Enter\" to start immediately."
};

const screens = {
  welcome: document.getElementById("welcome-screen"),
  content: document.getElementById("content-screen"),
  message: document.getElementById("message-screen"),
  fixation: document.getElementById("fixation-screen"),
  stimulus: document.getElementById("stimulus-screen")
};

const contentElement = document.getElementById("content");
const messageElement = document.getElementById("message");
const leftStimulus = document.getElementById("left-stimulus");
const rightStimulus = document.getElementById("right-stimulus");
const consentCheckbox = document.getElementById("ethics-consent");
const fullscreenStartButton = document.getElementById("fullscreen-start");
const welcomeError = document.getElementById("welcome-error");

const urlParameters = new URLSearchParams(window.location.search);
const prolificPid = urlParameters.get("PROLIFIC_PID") || "missing";
const studyId = urlParameters.get("STUDY_ID") || "missing";
const sessionId = urlParameters.get("SESSION_ID") || randomId(12);
const subjectId = prolificPid !== "missing" ? prolificPid : getOrCreateAnonymousSubjectId();
const previewMode = urlParameters.get("preview") === "1" || prolificPid === "missing";
const studyLockKey = `gamble_task_status_${subjectId}_${studyId}`;
const dataFilename = `${safeFilename(subjectId)}_${safeFilename(sessionId)}_${Date.now()}_gamble.csv`;

let assignedCondition = null;
let trials = [];
let results = [];
let comprehensionAttempts = 0;
let comprehensionPassed = false;
let comprehensionRecords = [];
let postTaskResponses = {
  fontSizeRating: "",
  decisionStrategy: "",
  strategyWordCount: 0,
  completed: false
};
let paymentResult = null;
let phase = "welcome";
let aborted = false;
let activeWait = null;
let fullscreenAbortArmed = false;
let plannedFullscreenExit = false;
let pageIsUnloading = false;
let fullscreenExitTimer = null;
let dataDownloaded = false;
let dataPipeSaved = false;
let dataPipeSaveError = null;

function randomId(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function getOrCreateAnonymousSubjectId() {
  const key = "gamble_task_anonymous_subject_id";
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return stored;
    const created = randomId(10);
    window.localStorage.setItem(key, created);
    return created;
  } catch (error) {
    return randomId(10);
  }
}

function randomUnit() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 4294967296;
}

function secureRandomIndex(length) {
  return Math.floor(randomUnit() * length);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = secureRandomIndex(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}

async function enterFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen || root.mozRequestFullScreen || root.msRequestFullscreen;
  if (!request) throw new Error("Fullscreen is not supported by this browser.");
  await request.call(root);
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (!exit || !currentFullscreenElement()) return Promise.resolve();
  try {
    return Promise.resolve(exit.call(document));
  } catch (error) {
    return Promise.reject(error);
  }
}

function getStoredStudyStatus() {
  if (previewMode) return null;
  try {
    const stored = window.localStorage.getItem(studyLockKey);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    return null;
  }
}

function setStoredStudyStatus(status, extra = {}) {
  if (previewMode) return;
  try {
    window.localStorage.setItem(studyLockKey, JSON.stringify({
      status,
      timestamp: Date.now(),
      prolific_pid: prolificPid,
      study_id: studyId,
      ...extra
    }));
  } catch (error) {
    // Continue if localStorage is unavailable.
  }
}

function isLockedStudyStatus(statusRecord) {
  return Boolean(statusRecord && [
    "in_progress",
    "fullscreen_exit",
    "excluded_comprehension",
    "completed",
    "technical_error"
  ].includes(statusRecord.status));
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => {
    element.classList.toggle("hidden", key !== name);
  });
  const practiceIntroVisible = name === "content" && contentElement.classList.contains("practice-intro-page");
  document.body.classList.toggle("task-mode", practiceIntroVisible || ["message", "fixation", "stimulus"].includes(name));
}

function showContent(html, extraClass = "") {
  phase = "content";
  contentElement.className = `content-page ${extraClass}`.trim();
  contentElement.innerHTML = html;
  screens.content.classList.toggle("practice-intro-screen", contentElement.classList.contains("practice-intro-page"));
  screens.content.scrollTop = 0;
  showScreen("content");
}

function showMessage(text, extraClass = "") {
  phase = "message";
  messageElement.className = `message ${extraClass}`.trim();
  messageElement.textContent = text;
  showScreen("message");
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitForKey(allowedCodes) {
  return new Promise((resolve) => {
    activeWait = { allowedCodes, resolve };
  });
}

function settleActiveWait(code) {
  if (!activeWait || !activeWait.allowedCodes.includes(code)) return false;
  const { resolve } = activeWait;
  activeWait = null;
  resolve(code);
  return true;
}

async function messageAndWait(text, allowedCodes = ["Space"], extraClass = "", delay = 200) {
  showMessage(text, extraClass);
  await sleep(delay);
  if (aborted) return false;
  await waitForKey(allowedCodes);
  return !aborted;
}

function isDataPipeConfigured() {
  return Boolean(DATAPIPE_EXPERIMENT_ID.trim());
}

async function getDataPipeCondition() {
  if (!isDataPipeConfigured()) {
    return {
      conditionNumber: secureRandomIndex(CONDITION_TABLE.length),
      source: "fallback_datapipe_not_configured"
    };
  }

  try {
    const response = await fetch("https://pipe.jspsych.org/api/condition/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experimentID: DATAPIPE_EXPERIMENT_ID })
    });
    if (!response.ok) throw new Error(`DataPipe condition request failed (${response.status}).`);
    const payload = await response.json();
    const conditionNumber = Number(payload.condition);
    if (Number.isInteger(conditionNumber) && conditionNumber >= 0 && conditionNumber < CONDITION_TABLE.length) {
      return { conditionNumber, source: "datapipe" };
    }
    return {
      conditionNumber: secureRandomIndex(CONDITION_TABLE.length),
      source: "fallback_invalid_datapipe_condition"
    };
  } catch (error) {
    console.warn("DataPipe condition assignment failed. Falling back to random assignment.", error);
    return {
      conditionNumber: secureRandomIndex(CONDITION_TABLE.length),
      source: "fallback_datapipe_error"
    };
  }
}

async function assignConditionAndPrepareTrials() {
  showContent("<h2>Loading study...</h2><p>Please do not close this page.</p>", "loading-page");
  const assignment = await getDataPipeCondition();
  if (aborted) return false;
  assignedCondition = {
    ...CONDITION_TABLE[assignment.conditionNumber],
    source: assignment.source
  };
  trials = createTrials();
  prepareResults();
  return true;
}

function createTrials() {
  const generated = [];
  for (let gain = 3; gain <= 9; gain += 1) {
    for (let loss = 3; loss <= 9; loss += 1) {
      generated.push({
        gain,
        loss,
        gainOnLeft: randomUnit() < 0.5 ? 0 : 1,
        gainLarge: assignedCondition.gainLarge
      });
    }
  }
  return shuffle(generated);
}

function prepareResults() {
  results = trials.map((trial, index) => ({
    Phase: "choice",
    Subject: subjectId,
    prolific_pid: prolificPid,
    study_id: studyId,
    session_id: sessionId,
    datapipe_experiment_id: DATAPIPE_EXPERIMENT_ID,
    datapipe_condition_source: assignedCondition.source,
    ConditionIndex: assignedCondition.conditionIndex,
    ConditionLabel: assignedCondition.conditionLabel,
    AcceptKey: 1,
    Gain: trial.gain,
    Loss: trial.loss,
    Fontsize: trial.gainLarge,
    GainOnLeft: trial.gainOnLeft,
    Choice: "",
    RT: "",
    KeyResponse: "",
    Trial: index + 1,
    ComprehensionAttempts: "",
    ComprehensionPassed: "",
    ComprehensionIncorrectItems: "",
    ComprehensionResponseJSON: "",
    PostTaskFontSizeRating: "",
    PostTaskDecisionStrategy: "",
    PostTaskStrategyWordCount: 0,
    PostTaskCompleted: 0,
    SelectedForPayment: 0,
    PaymentOutcome: "",
    FinalTokens: "",
    FinalCents: "",
    FinalDollars: "",
    StudyStatus: ""
  }));
}

function instructionImagePath() {
  const fontCondition = assignedCondition.gainLarge === 1 ? 1 : 2;
  return `stimuli_G7_L4_F${fontCondition}_P1.png`;
}

function comprehensionImagePath() {
  const fontCondition = assignedCondition.gainLarge === 1 ? 1 : 2;
  return `stimuli_G5_L3_F${fontCondition}_P0.png`;
}

function showInstructionPage(pageNumber, incorrectQuestions = []) {
  if (pageNumber === 1) {
    const feedback = incorrectQuestions.length > 0
      ? `<div class="error-summary" role="alert"><strong>Incorrect response.</strong><p>Question${incorrectQuestions.length > 1 ? "s" : ""} ${incorrectQuestions.join(", ")} ${incorrectQuestions.length > 1 ? "were" : "was"} answered incorrectly. Please reread the instructions carefully before trying again.</p></div>`
      : "";
    showContent(`
      ${feedback}
      <h1>Instructions</h1>
      <p>In this game, you will start with an initial endowment of <strong class="emphasis-red">45 tokens</strong>. At the end of the experiment, all the tokens you have earned will be converted into real cash at a rate of <strong class="emphasis-red">1 token = 5 cents</strong> <strong>(or $0.05)</strong>. In total, you will make approximately <strong class="emphasis-red">50 choices</strong>, deciding whether or not to participate in the gamble for each round.</p>
      <p>As shown in the figure below, each gamble shows a possible gain, marked with a <strong>“ + ”</strong>, and a possible loss, marked with a <strong>“ - ”</strong>. For each gamble, you have two options: Accept or Reject. If you accept, you have a <strong class="emphasis-red">50%</strong> chance of gaining the number of tokens shown and a <strong class="emphasis-red">50%</strong> chance of losing the number shown. Press the <strong class="key-highlight">“↑”</strong> key to <strong class="key-highlight">accept</strong> the gamble, and press the <strong class="key-highlight">“↓”</strong> key to <strong class="key-highlight">reject</strong> it.</p>
      <p>Please note that the probabilities of winning and losing in each gamble are equal, both being <strong class="emphasis-red">50%</strong>.</p>
      <figure class="instruction-figure">
        <img src="${instructionImagePath()}" alt="Example gamble showing a possible gain of 7 tokens and a possible loss of 4 tokens.">
      </figure>
      <p>Your decisions will be recorded but not carried out immediately. After all rounds are completed, the computer will <strong>randomly select <span class="emphasis-red">one round</span></strong> to determine your payment.</p>
      <p class="instruction-section-break">For example, suppose the “+7/−4” gamble shown above is selected:</p>
      <p>If you chose to <strong class="emphasis-red">“Accept”</strong>, the computer will simulate a fair coin toss:</p>
      <ul class="instruction-list">
        <li>If the coin lands heads, <span class="instruction-underline">you will gain 7 tokens and receive 45 + 7 = 52 tokens = 260 cents ($2.60);</span></li>
        <li>If the coin lands tails, <span class="instruction-underline">you will lose 4 tokens and receive 45 − 4 = 41 tokens = 205 cents ($2.05).</span></li>
      </ul>
      <p>If you chose to <strong class="emphasis-red">“Reject”</strong>, it will not be played.</p>
      <ul class="instruction-list">
        <li><span class="instruction-underline">You will keep 45 tokens = 225 cents ($2.25).</span></li>
      </ul>
      <p class="instruction-section-break">The gain and loss amounts will appear in <strong>different font sizes</strong>, and their <strong>left–right positions</strong> will vary randomly. However, these display formats are completely unrelated to the game rules and will not affect your final payout. There is <strong>no time limit</strong> for each choice.</p>
      <button id="instruction-next" class="content-button" type="button">Next</button>
    `, "instruction-page");
    document.getElementById("instruction-next").addEventListener("click", () => showInstructionPage(2));
    return;
  }

  showContent(`
    <h1>Instructions</h1>
    <p>Before each gamble appears, a circular fixation point (as shown below) will be displayed in the center of the screen for a random period of 2–3 seconds. Please look at the fixation point without pressing any key. The gamble will then appear automatically.</p>
    <figure class="fixation-figure">
      <div class="fixation-demo" role="img" aria-label="A white circular fixation point in the center of a gray background with a 4:3 aspect ratio.">
        <span class="fixation-demo-dot" aria-hidden="true"></span>
      </div>
    </figure>
    <p>To reiterate:</p>
    <ol class="reiteration-list">
      <li><strong>Independent and Random</strong>: Every round in the task has an <strong class="emphasis-red">equal probability</strong> of being selected. That is, your choice in any given round could be the one that determines your actual payout. Therefore, please treat every decision seriously.</li>
      <li><strong>Exactly One</strong>: Only <strong class="emphasis-red">one decision</strong> will be executed in the end, meaning your earnings depend solely on that chosen round, completely independent of your choices in other rounds. Therefore, please evaluate each round independently.</li>
    </ol>
    <p>If you have no questions, please click “Next” to proceed to the comprehension test.</p>
    <div class="instruction-navigation">
      <button id="instruction-back" class="content-button secondary-button" type="button">Back</button>
      <button id="comprehension-next" class="content-button" type="button">Next</button>
    </div>
  `, "instruction-page");
  document.getElementById("instruction-back").addEventListener("click", () => showInstructionPage(1));
  document.getElementById("comprehension-next").addEventListener("click", showComprehensionTest);
}

function comprehensionQuestions() {
  const example = `<figure class="quiz-figure"><img src="${comprehensionImagePath()}" alt="Example gamble showing a possible gain of 5 tokens and a possible loss of 3 tokens."></figure>`;
  return [
    {
      number: 1,
      name: "probabilities",
      text: "What are the probabilities of the gain and loss outcomes in each gamble?",
      options: [
        ["depend_amounts", "The probabilities depend on the token amounts."],
        ["equal_50_50", "Every gamble has a 50% probability of a gain and a 50% probability of a loss."]
      ],
      correct: "equal_50_50"
    },
    {
      number: 2,
      name: "timing",
      text: "After you accept or reject a gamble:",
      options: [
        ["recorded_not_immediate", "Your decision is recorded but not carried out immediately."],
        ["recorded_immediate", "Your decision is recorded and carried out immediately."]
      ],
      correct: "recorded_not_immediate"
    },
    {
      number: 3,
      name: "reject_payment",
      text: "Suppose the gamble shown below is selected. If you chose “Reject”, what would your payment be?",
      exampleHtml: example,
      options: [
        ["reject_keep", "You would keep 45 tokens, equivalent to 225 cents ($2.25)."],
        ["reject_lose", "You would lose 3 tokens, leaving 42 tokens, equivalent to 210 cents ($2.10)."],
        ["reject_gain", "You would gain 5 tokens, giving you 50 tokens, equivalent to 250 cents ($2.50)."],
        ["reject_coin", "You would have a 50% chance of receiving 250 cents ($2.50) and a 50% chance of receiving 210 cents ($2.10)."]
      ],
      correct: "reject_keep"
    },
    {
      number: 4,
      name: "accept_payment",
      text: "Suppose the gamble shown below is selected. If you chose “Accept”, what would your payment be?",
      exampleHtml: example,
      options: [
        ["accept_keep", "You would keep 45 tokens, equivalent to 225 cents ($2.25)."],
        ["accept_lose", "You would lose 3 tokens, leaving 42 tokens, equivalent to 210 cents ($2.10)."],
        ["accept_gain", "You would gain 5 tokens, giving you 50 tokens, equivalent to 250 cents ($2.50)."],
        ["accept_coin", "You would have a 50% chance of receiving 250 cents ($2.50) and a 50% chance of receiving 210 cents ($2.10)."]
      ],
      correct: "accept_coin"
    },
    {
      number: 5,
      name: "selection",
      text: "Which trial is most likely to be selected for real payment?",
      options: [
        ["reject_trial", "A trial in which you chose “Reject.”"],
        ["accept_trial", "A trial in which you chose “Accept.”"],
        ["equal_chance", "Every trial has an equal chance of being selected, regardless of your decision."]
      ],
      correct: "equal_chance"
    },
    {
      number: 6,
      name: "response_keys",
      text: "Which response-key mapping is correct?",
      options: [
        ["up_accept", "Press the “↑” key to accept and the “↓” key to reject."],
        ["down_accept", "Press the “↓” key to accept and the “↑” key to reject."]
      ],
      correct: "up_accept"
    }
  ];
}

function showComprehensionTest() {
  const questions = comprehensionQuestions();
  showContent(`
    <form id="comprehension-form" novalidate>
      <h1>Comprehension Test</h1>
      <p class="comprehension-intro">Please answer the following questions to confirm your understanding of the game.</p>
      ${questions.map((question) => `
        <div class="form-question">
          <div class="question-text">${question.number}. ${question.text}</div>
          ${question.exampleHtml || ""}
          <div class="single-choice-list" role="radiogroup" aria-label="Question ${question.number}">
            ${question.options.map(([value, label]) => `
              <label class="single-choice-option">
                <input type="radio" name="${question.name}" value="${value}">
                <span>${label}</span>
              </label>
            `).join("")}
          </div>
          <div class="question-required" data-required-for="${question.name}">Please answer this question.</div>
        </div>
      `).join("")}
      <button class="content-button" type="submit">Submit answers</button>
      <div id="comprehension-required" class="required-note" role="alert">Please answer all questions before continuing.</div>
    </form>
  `, "comprehension-page");

  const pageStart = performance.now();
  const form = document.getElementById("comprehension-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const response = Object.fromEntries(formData.entries());
    form.querySelectorAll(".question-required").forEach((element) => {
      element.style.display = "none";
    });
    const unanswered = questions.filter((question) => !response[question.name]);
    const warning = document.getElementById("comprehension-required");
    if (unanswered.length > 0) {
      unanswered.forEach((question) => {
        const note = form.querySelector(`[data-required-for="${question.name}"]`);
        if (note) note.style.display = "block";
      });
      warning.textContent = unanswered.length === 1
        ? "Please answer this question before continuing."
        : "Please answer all questions before continuing.";
      warning.style.display = "block";
      return;
    }

    warning.style.display = "none";
    comprehensionAttempts += 1;
    const incorrect = questions
      .filter((question) => response[question.name] !== question.correct)
      .map((question) => question.number);
    comprehensionPassed = incorrect.length === 0;
    comprehensionRecords.push({
      attempt: comprehensionAttempts,
      passed: comprehensionPassed ? 1 : 0,
      incorrect,
      response,
      rtMilliseconds: Math.round(performance.now() - pageStart)
    });

    if (comprehensionPassed) {
      runTask().catch(handleUnexpectedError);
    } else if (comprehensionAttempts === 1) {
      showInstructionPage(1, incorrect);
    } else {
      excludeForComprehension(incorrect);
    }
  });
}

function drawStimulus(trial) {
  const gainElement = trial.gainOnLeft === 1 ? leftStimulus : rightStimulus;
  const lossElement = trial.gainOnLeft === 1 ? rightStimulus : leftStimulus;
  gainElement.textContent = `+${trial.gain}`;
  lossElement.textContent = `-${trial.loss}`;
  gainElement.className = `stimulus ${trial.gainLarge === 1 ? "large" : "small"}`;
  lossElement.className = `stimulus ${trial.gainLarge === 1 ? "small" : "large"}`;
  showScreen("stimulus");
}

async function runTrial(trial, resultRow = null) {
  phase = "fixation";
  showScreen("fixation");
  await sleep(2000 + randomUnit() * 1000);
  if (aborted) return;

  phase = "response";
  drawStimulus(trial);
  const startedAt = performance.now();
  const code = await waitForKey(["ArrowUp", "ArrowDown"]);
  if (aborted) return;

  if (resultRow) {
    resultRow.KeyResponse = code === "ArrowUp" ? 1 : 2;
    resultRow.RT = (performance.now() - startedAt) / 1000;
    resultRow.Choice = code === "ArrowUp" ? 1 : 0;
  }

  showScreen("message");
  messageElement.textContent = "";
}

async function runTask() {
  if (!await postComprehensionAndWait()) return;
  if (!await practiceInstructionAndWait()) return;
  const practiceTrials = PRACTICE_TEMPLATE.map((trial) => ({
    ...trial,
    gainLarge: assignedCondition.gainLarge
  }));

  for (const trial of practiceTrials) {
    await runTrial(trial);
    if (aborted) return;
  }

  if (!await messageAndWait(TEXT.start, ["Enter", "NumpadEnter"], "main-intro-message")) return;

  for (let i = 0; i < trials.length; i += 1) {
    await runTrial(trials[i], results[i]);
    if (aborted) return;
  }

  showMessage("The decision phase is complete. Please wait...");
  phase = "post_task_transition";
  await sleep(2000);
  if (aborted) return;
  if (!await postTaskQuestionsAndWait()) return;

  paymentResult = drawPaymentResult();
  applySummaryToResults("completed");
  showContent("<h2>Saving your data...</h2><p>Please do not close this page.</p>", "loading-page");
  const savedToPipe = await saveToDataPipe("completed");
  if (aborted) return;
  if (!savedToPipe) {
    showDataPipeSaveFailure();
    return;
  }
  completeStudyAfterSave();
}

async function postComprehensionAndWait() {
  showContent(`<div class="message post-comprehension-copy">${TEXT.postComprehension}</div>`, "post-comprehension-page");
  phase = "post_comprehension";
  await sleep(200);
  if (aborted) return false;
  await waitForKey(["Enter", "NumpadEnter"]);
  return !aborted;
}

async function practiceInstructionAndWait() {
  showContent(`
    <div class="practice-intro-copy">
      <p>You will now complete three practice trials.</p>
      <p>Practice trials will not be selected to determine your final payment.</p>
      <p>Press the “↑” key to accept the gamble.<br>Press the “↓” key to reject it.</p>
      <p>When you are ready, press the "SPACEBAR" to start the practice trials</p>
    </div>
  `, "practice-intro-page");
  phase = "practice_intro";
  await sleep(200);
  if (aborted) return false;
  await waitForKey(["Space"]);
  return !aborted;
}

function countStrategyWords(text) {
  return (text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || []).length;
}

async function postTaskQuestionsAndWait() {
  showContent(`
    <h1>Two brief questions</h1>
    <p>Before we show your payment result, please answer two brief questions.</p>
    <form id="post-task-form" novalidate>
      <div class="form-question">
        <div id="font-size-question" class="question-text">1. In the gamble task you just completed, the potential gain and potential loss were presented in different font sizes. To what extent did the amount shown in the larger font appear numerically larger than the amount shown in the smaller font?</div>
        <p id="font-size-scale-description">Please respond on a scale from 1 to 7 (1 = not at all, 7 = very strong).</p>
        <div class="post-task-scale" role="radiogroup" aria-labelledby="font-size-question" aria-describedby="font-size-scale-description font-size-required" aria-required="true">
          <div class="post-task-scale-anchors" aria-hidden="true"><span>Not at all</span><span>Very strong</span></div>
          <div class="post-task-scale-options">
            ${[1, 2, 3, 4, 5, 6, 7].map((rating) => `
              <label class="post-task-scale-option">
                <input type="radio" name="font_size_rating" value="${rating}" required aria-label="${rating}${rating === 1 ? ' — Not at all' : rating === 7 ? ' — Very strong' : ''}">
                <span>${rating}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div id="font-size-required" class="question-required" role="alert">Please select a response from 1 to 7.</div>
      </div>
      <div class="form-question">
        <div class="question-text"><label for="decision-strategy">2. What strategy did you use when deciding whether to accept or reject the gambles?</label></div>
        <p id="strategy-instruction">Please describe your strategy in at least ${MIN_STRATEGY_WORDS} English words.</p>
        <textarea id="decision-strategy" class="post-task-strategy" name="decision_strategy" rows="6" required aria-describedby="strategy-instruction strategy-word-count strategy-required"></textarea>
        <p id="strategy-word-count" class="post-task-word-count" aria-live="polite">0 words (minimum: ${MIN_STRATEGY_WORDS})</p>
        <div id="strategy-required" class="question-required" role="alert">Please write at least ${MIN_STRATEGY_WORDS} words before continuing.</div>
      </div>
      <button id="post-task-submit" class="content-button" type="submit">Submit and view result</button>
    </form>
  `, "post-task-page");
  phase = "post_task_questions";

  const form = document.getElementById("post-task-form");
  const strategyInput = document.getElementById("decision-strategy");
  const wordCountElement = document.getElementById("strategy-word-count");
  const ratingWarning = document.getElementById("font-size-required");
  const strategyWarning = document.getElementById("strategy-required");
  const submitButton = document.getElementById("post-task-submit");
  const captureResponses = () => {
    const selectedRating = form.querySelector('input[name="font_size_rating"]:checked');
    postTaskResponses.fontSizeRating = selectedRating ? Number(selectedRating.value) : "";
    postTaskResponses.decisionStrategy = strategyInput.value.trim();
    postTaskResponses.strategyWordCount = countStrategyWords(postTaskResponses.decisionStrategy);
    wordCountElement.textContent = `${postTaskResponses.strategyWordCount} words (minimum: ${MIN_STRATEGY_WORDS})`;
    if (Number.isInteger(postTaskResponses.fontSizeRating) && postTaskResponses.fontSizeRating >= 1 && postTaskResponses.fontSizeRating <= 7) {
      ratingWarning.style.display = "none";
    }
    if (postTaskResponses.strategyWordCount >= MIN_STRATEGY_WORDS) {
      strategyWarning.style.display = "none";
      strategyInput.removeAttribute("aria-invalid");
    }
  };
  const updateDraft = () => {
    if (!aborted && phase === "post_task_questions") captureResponses();
  };
  form.addEventListener("input", updateDraft);
  form.addEventListener("change", updateDraft);

  await new Promise((resolve) => {
    // No key advances this form. Fullscreen termination can still end the wait.
    activeWait = { allowedCodes: [], resolve };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (aborted || phase !== "post_task_questions" || postTaskResponses.completed) return;
      captureResponses();
      const validRating = Number.isInteger(postTaskResponses.fontSizeRating) && postTaskResponses.fontSizeRating >= 1 && postTaskResponses.fontSizeRating <= 7;
      const validStrategy = postTaskResponses.strategyWordCount >= MIN_STRATEGY_WORDS;
      ratingWarning.style.display = validRating ? "none" : "block";
      strategyWarning.style.display = validStrategy ? "none" : "block";
      strategyInput.setAttribute("aria-invalid", String(!validStrategy));
      if (!validRating || !validStrategy) {
        if (!validRating) form.querySelector('input[name="font_size_rating"]').focus();
        else strategyInput.focus();
        return;
      }
      postTaskResponses.completed = true;
      submitButton.disabled = true;
      activeWait = null;
      phase = "post_task_submitted";
      resolve();
    });
  });
  return !aborted && postTaskResponses.completed;
}

function completeStudyAfterSave() {
  setStoredStudyStatus("completed", {
    selected_trial: paymentResult.trialNumber,
    final_tokens: paymentResult.finalTokens,
    final_cents: paymentResult.finalCents
  });
  showPaymentResult();
}

function showDataPipeSaveFailure() {
  showContent(`
    <h1>Data could not be saved online.</h1>
    <div class="termination-warning"><strong>Your responses have not yet been saved online.</strong><p>Please keep this page open and select Retry. You can also download a backup copy if needed.</p><p id="save-error-detail" role="status"></p></div>
    <button id="retry-save" class="content-button" type="button">Retry</button>
    <button id="download-backup" class="content-button" type="button">Download a backup copy</button>
  `, "end-page");
  phase = "save_error";
  if (dataPipeSaveError) {
    document.getElementById("save-error-detail").textContent = `Save error: ${dataPipeSaveError.code}. ${dataPipeSaveError.message}`;
  }
  const backupButton = document.getElementById("download-backup");
  backupButton.disabled = dataDownloaded;
  if (dataDownloaded) backupButton.textContent = "Backup downloaded";
  backupButton.addEventListener("click", () => {
    if (aborted || phase !== "save_error") return;
    downloadData("completed");
    backupButton.disabled = true;
    backupButton.textContent = "Backup downloaded";
  });
  document.getElementById("retry-save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Saving...";
    const saved = await saveToDataPipe("completed");
    if (aborted) return;
    if (saved) {
      completeStudyAfterSave();
    } else {
      showDataPipeSaveFailure();
    }
  });
}

function drawPaymentResult() {
  const selectedIndex = secureRandomIndex(results.length);
  const selectedTrial = trials[selectedIndex];
  const selectedRow = results[selectedIndex];
  const accepted = selectedRow.Choice === 1;
  let outcome = "not_played";
  let finalTokens = INITIAL_ENDOWMENT;

  if (accepted) {
    if (randomUnit() < 0.5) {
      outcome = "gain";
      finalTokens += selectedTrial.gain;
    } else {
      outcome = "loss";
      finalTokens -= selectedTrial.loss;
    }
  }

  return {
    selectedIndex,
    trialNumber: selectedIndex + 1,
    trial: selectedTrial,
    accepted,
    outcome,
    finalTokens,
    finalCents: finalTokens * CENTS_PER_TOKEN,
    finalDollars: (finalTokens * CENTS_PER_TOKEN / 100).toFixed(2)
  };
}

function paymentGambleHtml(trial) {
  const gainSide = trial.gainOnLeft === 1 ? "left" : "right";
  const lossSide = trial.gainOnLeft === 1 ? "right" : "left";
  const gainSize = trial.gainLarge === 1 ? "large" : "small";
  const lossSize = trial.gainLarge === 1 ? "small" : "large";
  return `
    <div class="payment-gamble" aria-label="Selected gamble: gain ${trial.gain} tokens or lose ${trial.loss} tokens">
      <div class="payment-value ${gainSide} ${gainSize}">+${trial.gain}</div>
      <div class="payment-value ${lossSide} ${lossSize}">−${trial.loss}</div>
    </div>
  `;
}

function showPaymentResult() {
  const result = paymentResult;
  let outcomeExplanation;
  if (!result.accepted) {
    outcomeExplanation = `<p>You chose <strong>Reject</strong>, so the selected gamble was not played. You keep your initial endowment of ${INITIAL_ENDOWMENT} tokens.</p>`;
  } else if (result.outcome === "gain") {
    outcomeExplanation = `<p>You chose <strong>Accept</strong>. The computer performed a fair 50/50 draw, and the <strong>gain</strong> outcome was selected.</p><p>${INITIAL_ENDOWMENT} + ${result.trial.gain} = <strong>${result.finalTokens} tokens</strong>.</p>`;
  } else {
    outcomeExplanation = `<p>You chose <strong>Accept</strong>. The computer performed a fair 50/50 draw, and the <strong>loss</strong> outcome was selected.</p><p>${INITIAL_ENDOWMENT} − ${result.trial.loss} = <strong>${result.finalTokens} tokens</strong>.</p>`;
  }

  showContent(`
    <h1>Payment Result</h1>
    <p>The computer randomly selected <strong>Round ${result.trialNumber}</strong> from the 49 rounds to determine your payment.</p>
    ${paymentGambleHtml(result.trial)}
    <div class="payment-summary">
      ${outcomeExplanation}
      <p class="payment-total">Your payment is ${result.finalTokens} tokens = ${result.finalCents} cents ($${result.finalDollars}).</p>
    </div>
    <button id="finish-study" class="content-button" type="button">Finish</button>
  `, "result-page");
  phase = "result";
  document.getElementById("finish-study").addEventListener("click", finishStudy);
}

function applySummaryToResults(status) {
  const incorrectItems = comprehensionRecords
    .map((record) => `attempt${record.attempt}:${record.incorrect.join("|") || "none"}`)
    .join(";");
  const responseJson = JSON.stringify(comprehensionRecords);
  results.forEach((row, index) => {
    row.ComprehensionAttempts = comprehensionAttempts;
    row.ComprehensionPassed = comprehensionPassed ? 1 : 0;
    row.ComprehensionIncorrectItems = incorrectItems;
    row.ComprehensionResponseJSON = responseJson;
    row.PostTaskFontSizeRating = postTaskResponses.fontSizeRating;
    row.PostTaskDecisionStrategy = postTaskResponses.decisionStrategy;
    row.PostTaskStrategyWordCount = postTaskResponses.strategyWordCount;
    row.PostTaskCompleted = postTaskResponses.completed ? 1 : 0;
    row.SelectedForPayment = paymentResult && index === paymentResult.selectedIndex ? 1 : 0;
    row.PaymentOutcome = paymentResult && index === paymentResult.selectedIndex ? paymentResult.outcome : "";
    row.FinalTokens = paymentResult && index === paymentResult.selectedIndex ? paymentResult.finalTokens : "";
    row.FinalCents = paymentResult && index === paymentResult.selectedIndex ? paymentResult.finalCents : "";
    row.FinalDollars = paymentResult && index === paymentResult.selectedIndex ? paymentResult.finalDollars : "";
    row.StudyStatus = status;
  });
}

function summaryOnlyRow(status) {
  return {
    Phase: "summary",
    Subject: subjectId,
    prolific_pid: prolificPid,
    study_id: studyId,
    session_id: sessionId,
    datapipe_experiment_id: DATAPIPE_EXPERIMENT_ID,
    datapipe_condition_source: assignedCondition ? assignedCondition.source : "",
    ConditionIndex: assignedCondition ? assignedCondition.conditionIndex : "",
    ConditionLabel: assignedCondition ? assignedCondition.conditionLabel : "",
    AcceptKey: 1,
    Gain: "",
    Loss: "",
    Fontsize: assignedCondition ? assignedCondition.gainLarge : "",
    GainOnLeft: "",
    Choice: "",
    RT: "",
    KeyResponse: "",
    Trial: "",
    ComprehensionAttempts: comprehensionAttempts,
    ComprehensionPassed: comprehensionPassed ? 1 : 0,
    ComprehensionIncorrectItems: comprehensionRecords.map((record) => `attempt${record.attempt}:${record.incorrect.join("|") || "none"}`).join(";"),
    ComprehensionResponseJSON: JSON.stringify(comprehensionRecords),
    PostTaskFontSizeRating: postTaskResponses.fontSizeRating,
    PostTaskDecisionStrategy: postTaskResponses.decisionStrategy,
    PostTaskStrategyWordCount: postTaskResponses.strategyWordCount,
    PostTaskCompleted: postTaskResponses.completed ? 1 : 0,
    SelectedForPayment: "",
    PaymentOutcome: "",
    FinalTokens: "",
    FinalCents: "",
    FinalDollars: "",
    StudyStatus: status
  };
}

function exportRows(status) {
  if (results.length === 0) return [summaryOnlyRow(status)];
  applySummaryToResults(status);
  return results;
}

function csvValue(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function buildCsv(status) {
  const rows = exportRows(status);
  const columns = Object.keys(rows[0]);
  return [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))
  ].join("\r\n");
}

function safeFilename(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "unknown";
}

function downloadData(status) {
  if (dataDownloaded) return;
  dataDownloaded = true;
  const blob = new Blob(["\uFEFF", buildCsv(status)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = dataFilename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveToDataPipe(status) {
  if (dataPipeSaved) return true;
  dataPipeSaveError = null;
  if (!isDataPipeConfigured()) {
    dataPipeSaveError = { code: "DATAPIPE_NOT_CONFIGURED", message: "The study's online data storage has not been configured. Please contact the researcher." };
    return false;
  }

  const requestBody = JSON.stringify({
    experimentID: DATAPIPE_EXPERIMENT_ID,
    filename: dataFilename,
    data: buildCsv(status)
  });
  const requestBytes = new Blob([requestBody]).size;
  try {
    const response = await fetch("https://pipe.jspsych.org/api/data/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      // Completed data can exceed the browser's 64 KiB keepalive quota.
      // Small termination reports may still continue after the page closes.
      keepalive: status !== "completed" && requestBytes < 64 * 1024
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || payload?.message !== "Success") {
      dataPipeSaveError = {
        code: String(payload?.error || (response.ok ? "UNEXPECTED_RESPONSE" : `HTTP_${response.status}`)),
        message: typeof payload?.message === "string" ? payload.message : "The server did not confirm that your data were saved. Please retry or contact the researcher."
      };
      console.error("DataPipe save was not confirmed.", { ...dataPipeSaveError, httpStatus: response.status, requestBytes });
      return false;
    }
    dataPipeSaved = true;
    return true;
  } catch (error) {
    dataPipeSaveError = {
      code: "NETWORK_ERROR",
      message: "The upload could not be completed. Please check your connection and select Retry."
    };
    console.error("DataPipe upload failed.", { ...dataPipeSaveError, requestBytes, error });
    return false;
  }
}

function excludeForComprehension(incorrectQuestions) {
  phase = "excluded";
  setStoredStudyStatus("excluded_comprehension", {
    comprehension_attempts: comprehensionAttempts,
    incorrect_questions: incorrectQuestions.join("|")
  });
  applySummaryToResults("excluded_comprehension");
  void saveToDataPipe("excluded_comprehension");
  showContent(`
    <h1>The study has ended.</h1>
    <div class="termination-warning"><strong>Based on your comprehension-test responses, you are not eligible to continue this study.</strong><p>You answered Question${incorrectQuestions.length > 1 ? "s" : ""} ${incorrectQuestions.join(", ")} incorrectly on your second attempt.</p></div>
    <p>Please return this study on Prolific. Do not submit a completion code.</p>
    <button id="excluded-exit" class="content-button" type="button">Exit</button>
  `, "end-page");
  phase = "excluded";
  document.getElementById("excluded-exit").addEventListener("click", () => {
    plannedFullscreenExit = true;
    fullscreenAbortArmed = false;
    exitFullscreen().catch(() => {});
  });
}

function handleFullscreenChange() {
  if (fullscreenAbortArmed && !plannedFullscreenExit && !currentFullscreenElement()) {
    if (fullscreenExitTimer) window.clearTimeout(fullscreenExitTimer);
    fullscreenExitTimer = window.setTimeout(() => {
      if (pageIsUnloading || plannedFullscreenExit || currentFullscreenElement() || !fullscreenAbortArmed) return;
      const storedStatus = getStoredStudyStatus();
      if (storedStatus && storedStatus.status === "completed") {
        fullscreenAbortArmed = false;
        showLockedStatus(storedStatus);
        return;
      }
      setStoredStudyStatus("fullscreen_exit", {
        fullscreen_exit_abort: 1,
        fullscreen_exit_abort_time_ms: Math.round(performance.now() - experimentStartPerf)
      });
      fullscreenAbortArmed = false;
      aborted = true;
      if (activeWait) {
        const { resolve } = activeWait;
        activeWait = null;
        resolve("Escape");
      }
      applySummaryToResults("fullscreen_exit");
      void saveToDataPipe("fullscreen_exit");
      showContent(`
        <h1>The study has ended.</h1>
        <div class="termination-warning"><strong>You exited fullscreen mode during the study.</strong></div>
        <p>Please return this study on Prolific. Do not submit a completion code.</p>
      `, "end-page");
      phase = "terminated";
    }, 250);
  }
}

function showLockedStatus(statusRecord) {
  aborted = true;
  fullscreenAbortArmed = false;
  const completed = statusRecord && statusRecord.status === "completed";
  showContent(`
    <h1>${completed ? "Your response has been saved." : "The study has ended."}</h1>
    <div class="${completed ? "" : "termination-warning"}">
      <strong>${completed ? "Thank you for completing this study." : "You are not eligible to continue this study."}</strong>
    </div>
    ${completed ? "" : "<p>Please return this study on Prolific. Do not submit a completion code.</p>"}
  `, "end-page");
  phase = "locked";
}

function finishStudy() {
  phase = "finished";
  plannedFullscreenExit = true;
  fullscreenAbortArmed = false;
  exitFullscreen().catch(() => {});
  showContent("<h1>Your response has been saved.</h1><p>Thank you for completing this study.</p>", "end-page");
  phase = "finished";
}

function handleUnexpectedError(error) {
  console.error(error);
  if (aborted) return;
  aborted = true;
  setStoredStudyStatus("technical_error");
  applySummaryToResults("technical_error");
  void saveToDataPipe("technical_error");
  showContent("<h1>The study has ended.</h1><div class=\"termination-warning\"><strong>The experiment stopped because of an unexpected error.</strong></div><p>Please keep this page open while we attempt to save your data online.</p>", "end-page");
  phase = "terminated";
}

consentCheckbox.addEventListener("change", () => {
  fullscreenStartButton.disabled = !consentCheckbox.checked;
  fullscreenStartButton.classList.toggle("is-disabled", !consentCheckbox.checked);
});

fullscreenStartButton.addEventListener("click", async () => {
  if (!consentCheckbox.checked) return;
  const statusBeforeEntry = getStoredStudyStatus();
  if (isLockedStudyStatus(statusBeforeEntry)) {
    showLockedStatus(statusBeforeEntry);
    return;
  }
  fullscreenStartButton.disabled = true;
  welcomeError.textContent = "";
  try {
    await enterFullscreen();
  } catch (error) {
    welcomeError.textContent = "Fullscreen mode is required to take part. Please allow fullscreen and try again.";
    fullscreenStartButton.disabled = false;
    return;
  }

  const statusAfterEntry = getStoredStudyStatus();
  if (isLockedStudyStatus(statusAfterEntry)) {
    plannedFullscreenExit = true;
    fullscreenAbortArmed = false;
    await exitFullscreen().catch(() => {});
    showLockedStatus(statusAfterEntry);
    return;
  }

  plannedFullscreenExit = false;
  fullscreenAbortArmed = true;
  if (window.innerWidth < MIN_FULLSCREEN_WIDTH || window.innerHeight < MIN_FULLSCREEN_HEIGHT) {
    fullscreenAbortArmed = false;
    plannedFullscreenExit = true;
    showContent(`
      <h1>Screen size too small</h1>
      <div class="termination-warning"><strong>This study requires a fullscreen display of at least ${MIN_FULLSCREEN_WIDTH} × ${MIN_FULLSCREEN_HEIGHT} pixels.</strong></div>
      <p>Please return the study on Prolific and do not submit a completion code.</p>
      <p>Detected fullscreen size: ${window.innerWidth} × ${window.innerHeight}</p>
    `, "end-page");
    exitFullscreen().catch(() => {});
    return;
  }

  setStoredStudyStatus("in_progress", { session_id: sessionId });
  try {
    const ready = await assignConditionAndPrepareTrials();
    if (ready && !aborted) showInstructionPage(1);
  } catch (error) {
    handleUnexpectedError(error);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (phase === "response" && ["ArrowUp", "ArrowDown"].includes(event.code)) {
    event.preventDefault();
    settleActiveWait(event.code);
  } else if (["message", "practice_intro", "post_comprehension"].includes(phase) && ["Space", "Enter", "NumpadEnter"].includes(event.code)) {
    event.preventDefault();
    settleActiveWait(event.code);
  }
});

window.addEventListener("beforeunload", () => {
  pageIsUnloading = true;
});
window.addEventListener("pagehide", () => {
  pageIsUnloading = true;
});
document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
document.addEventListener("mozfullscreenchange", handleFullscreenChange);
document.addEventListener("MSFullscreenChange", handleFullscreenChange);

const storedStatus = getStoredStudyStatus();
if (isLockedStudyStatus(storedStatus)) {
  showLockedStatus(storedStatus);
}
