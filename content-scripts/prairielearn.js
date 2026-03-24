const AUTOMATION_STATE_KEY = "autoPrairieLearnState";
const MAX_VARIANT_ATTEMPTS = 6;
const RESUME_DEBOUNCE_MS = 150;
const PHASE_POLL_MS = 1000;
const SAVE_GRADE_WAIT_MS = 10000;
const SAVE_GRADE_POLL_MS = 250;
const BUTTON_STATE_DEBOUNCE_MS = 120;
const PAGE_CLASS_CACHE_TTL_MS = 250;
const AI_ATTENTION_NUDGE_DELAY_MS = 8000;

const DEFAULT_SYNC_SETTINGS = {
  aiModel: "chatgpt",
  submissionMode: "fillOnly",
  maxVariantsPerQuestion: 6,
  autoAdvanceQuestions: true,
  carryWrongAnswerFeedbackToNextPrompt: true,
  responseTimeoutSeconds: 90,
  focusAITabWhileSending: true,
  fallbackProvider: "",
  stopOnProviderError: false,
  showInlineStatusBadge: true,
  debugMode: false,
  promptStrategy: "strict_json",
};

let messageListener = null;
let isAutomating = false;
let buttonAdded = false;
let resumeInFlight = false;
let resumeTimer = null;
let observerSuspended = false;
let immediateStopRequested = false;
let observer = null;
let currentRunId = 0;
let hasRunInitialResume = false;
let phaseWatchInterval = null;
let cachedSettings = { ...DEFAULT_SYNC_SETTINGS };
let currentTabId = null;
let currentWindowId = null;
let pageClassCache = { value: "unsupported", at: 0 };
let buttonUpdateTimer = null;
let buttonUpdateInFlight = false;
let completionAlertedRunId = 0;
let lastKnownAutomationState = null;

function getDefaultAutomationState() {
  return {
    active: false,
    runId: 0,
    phase: "idle",
    ownerTabId: null,
    ownerRunToken: null,
    questionKey: null,
    questionIndex: null,
    pageClass: "unsupported",
    provider: null,
    variantAttempts: 0,
    lastIncorrectQuestion: null,
    lastIncorrectAnswer: null,
    previousCorrectionPending: false,
    pendingQuestionText: null,
    pendingSelectedAnswer: null,
    invalidResponseRetries: 0,
    lastError: null,
    lastStatusMessage: null,
    providerHealth: null,
    attentionNudgeRequested: false,
    phaseStartedAt: 0,
  };
}

function createRunToken() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStorageValue(area, key) {
  const storageArea =
    area === "local"
      ? chrome.storage?.local
      : area === "sync"
        ? chrome.storage?.sync
        : null;

  return new Promise((resolve) => {
    if (!storageArea || !chrome.runtime?.id) {
      resolve(undefined);
      return;
    }

    storageArea.get(key, (result) => {
      resolve(result[key]);
    });
  });
}

function setStorageValue(area, data) {
  const storageArea =
    area === "local"
      ? chrome.storage?.local
      : area === "sync"
        ? chrome.storage?.sync
        : null;

  return new Promise((resolve) => {
    if (!storageArea || !chrome.runtime?.id) {
      resolve();
      return;
    }

    storageArea.set(data, () => resolve());
  });
}

function hasLiveExtensionContext() {
  return !!(chrome?.runtime?.id);
}

function safeSendRuntimeMessage(message) {
  if (!hasLiveExtensionContext()) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (error) {
      resolve(false);
    }
  });
}

function safeSendRuntimeMessageWithResponse(message) {
  if (!hasLiveExtensionContext()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

async function getAutomationState() {
  const storedState = await getStorageValue("local", AUTOMATION_STATE_KEY);
  const nextState = {
    ...getDefaultAutomationState(),
    ...(storedState || {}),
  };
  lastKnownAutomationState = nextState;
  return nextState;
}

async function getSettings(forceRefresh = false) {
  if (!forceRefresh && cachedSettings) {
    return cachedSettings;
  }

  const stored = await new Promise((resolve) => {
    if (!chrome.storage?.sync || !chrome.runtime?.id) {
      resolve({});
      return;
    }

    chrome.storage.sync.get(Object.keys(DEFAULT_SYNC_SETTINGS), resolve);
  });

  cachedSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(stored || {}),
  };
  return cachedSettings;
}

async function refreshTabContext() {
  if (!hasLiveExtensionContext()) return;

  try {
    const context = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSenderContext" }, (response) => {
        resolve(response || null);
      });
    });

    if (context?.received) {
      currentTabId = context.tabId ?? null;
      currentWindowId = context.windowId ?? null;
    }
  } catch (error) {}
}

function clearPhaseWatchInterval() {
  if (phaseWatchInterval) {
    clearInterval(phaseWatchInterval);
    phaseWatchInterval = null;
  }
}

function ensurePhaseWatchInterval() {
  if (phaseWatchInterval) return;

  phaseWatchInterval = window.setInterval(() => {
    checkForPhaseTimeout();
  }, PHASE_POLL_MS);
}

function invalidatePageClassCache() {
  pageClassCache.at = 0;
}

async function saveAutomationState(nextState) {
  await setStorageValue("local", {
    [AUTOMATION_STATE_KEY]: nextState,
  });
  lastKnownAutomationState = nextState;
  isAutomating = !!nextState.active;
  currentRunId = nextState.runId || 0;
  if (nextState.active && isSupportedPage()) {
    ensurePhaseWatchInterval();
  } else {
    clearPhaseWatchInterval();
  }
  updateButtonStateImmediate(nextState, cachedSettings);
}

async function patchAutomationState(partialState) {
  const currentState = await getAutomationState();
  const nextState = {
    ...currentState,
    ...partialState,
  };
  await saveAutomationState(nextState);
  return nextState;
}

function getQuestionContainer() {
  return document.querySelector(".question-container");
}

function getQuestionIndex() {
  const container = getQuestionContainer();
  if (!container?.id) return null;
  const match = container.id.match(/question-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getQuestionKey() {
  const container = getQuestionContainer();
  if (!container) {
    return window.location.pathname + window.location.search;
  }

  return (
    container.dataset.instanceQuestionId ||
    container.dataset.questionId ||
    window.location.pathname + window.location.search
  );
}

function getQuestionText() {
  const body = document.querySelector(".card-body.question-body");
  if (!body) return null;

  const clone = body.cloneNode(true);
  clone
    .querySelectorAll(".form-check, script, style, a[data-toggle]")
    .forEach((el) => el.remove());

  return clone.textContent
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function getOptionLabel(input) {
  return (
    document.querySelector(`label[for="${input.id}"] .ml-1`) ||
    document.querySelector(`label[for="${input.id}"] .mr-1`) ||
    document.querySelector(`label[for="${input.id}"]`)
  );
}

function getOptions() {
  return Array.from(document.querySelectorAll('input[name="only-answer"]'))
    .map((input) => {
      const label = getOptionLabel(input);
      return {
        id: input.id,
        value: input.value,
        inputType: (input.type || "").toLowerCase(),
        text: label ? label.textContent.trim() : "",
        disabled: input.disabled,
      };
    })
    .filter((option) => option.text);
}

function getQuestionInputType() {
  const firstInput = document.querySelector('input[name="only-answer"]');
  const inputType = (firstInput?.type || "").toLowerCase();
  return inputType === "checkbox" ? "checkbox" : "radio";
}

function getQuestionType() {
  return getQuestionInputType() === "checkbox"
    ? "multiple_select"
    : "multiple_choice";
}

function isSupportedPage() {
  return !!(
    document.querySelector(".question-form") &&
    document.querySelector(".card-body.question-body") &&
    getOptions().length
  );
}

function isFreshQuestionPage() {
  if (!isSupportedPage()) return false;

  const gradeButton = document.querySelector(
    'button[name="__action"][value="grade"]'
  );
  const hasTryVariantLink = !!findTryNewVariantLink();
  const allInputsDisabled = getOptions().every((option) => option.disabled);

  return !!gradeButton && !gradeButton.disabled && !hasTryVariantLink && !allInputsDisabled;
}

function findQuestionScorePanel() {
  return document.querySelector("#question-score-panel");
}

function findTryNewVariantLink() {
  const footer = document.querySelector("#question-panel-footer");
  const footerLink = footer
    ? Array.from(footer.querySelectorAll("a")).find((link) =>
        link.textContent.trim().toLowerCase().includes("try a new variant")
      )
    : null;

  if (footerLink) {
    return footerLink;
  }

  return Array.from(document.querySelectorAll("a")).find((link) =>
    link.textContent.trim().toLowerCase().includes("try a new variant")
  );
}

function findNextQuestionLink() {
  const directLink = document.querySelector("#question-nav-next");
  const fallbackLink = Array.from(document.querySelectorAll("a")).find((link) =>
    link.textContent.trim().toLowerCase().includes("next question")
  );
  const link = directLink || fallbackLink;
  if (!link) return null;
  if (link.classList.contains("disabled")) return null;
  if (!link.href) return null;
  return link;
}

function parseSubmissionStatus() {
  const scorePanel = findQuestionScorePanel();
  if (!scorePanel) return null;

  const rows = Array.from(scorePanel.querySelectorAll("tr"));
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) continue;
    const label = cells[0].textContent.trim().toLowerCase();
    if (label === "submission status:") {
      return cells[1].textContent.trim().toLowerCase();
    }
  }

  return null;
}

function parseQuestionPoints() {
  const scorePanel = findQuestionScorePanel();
  if (!scorePanel) return null;

  const parsePointsPair = (text) => {
    if (!text) return null;
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;

    const awarded = Number.parseInt(match[1], 10);
    const max = Number.parseInt(match[2], 10);
    if (Number.isNaN(awarded) || Number.isNaN(max)) {
      return null;
    }

    return { awarded, max };
  };

  const rowPoints = Array.from(scorePanel.querySelectorAll("tr"))
    .map((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 2) return null;
      const label = cells[0].textContent.trim().toLowerCase().replace(/\s+/g, " ");
      if (!label.includes("total points")) return null;
      return parsePointsPair(cells[1].textContent || "");
    })
    .find((value) => !!value);

  if (rowPoints) {
    return rowPoints;
  }

  const awardedElement = scorePanel.querySelector('[data-testid="awarded-points"]');
  if (awardedElement) {
    const maxTextFromMuted =
      awardedElement.parentElement?.querySelector(".text-muted")?.textContent;
    const awarded = Number.parseInt(awardedElement.textContent.trim(), 10);
    let max = Number.parseInt((maxTextFromMuted || "").trim(), 10);

    if (Number.isNaN(max)) {
      const compactPair = parsePointsPair(awardedElement.parentElement?.textContent || "");
      if (compactPair) {
        return compactPair;
      }
    }

    if (!Number.isNaN(awarded) && !Number.isNaN(max)) {
      return { awarded, max };
    }
  }

  const panelText = scorePanel.textContent || "";
  const totalPointsSectionMatch = panelText.match(
    /total points[^0-9]*(\d+\s*\/\s*\d+)/i
  );
  if (totalPointsSectionMatch) {
    const fallbackPair = parsePointsPair(totalPointsSectionMatch[1]);
    if (fallbackPair) return fallbackPair;
  }

  return null;
}

function isGradedPage() {
  return hasSubmittedResult();
}

function isQuestionComplete() {
  const points = parseQuestionPoints();
  if (points) {
    return points.awarded >= points.max;
  }

  const status = parseSubmissionStatus();
  return status ? status.includes("correct") : false;
}

function getProviderDisplayName(providerRaw) {
  if (providerRaw === "gemini") return "Gemini";
  if (providerRaw === "deepseek") return "DeepSeek";
  return "ChatGPT";
}

function isAutoGradeModeActive() {
  return (cachedSettings.submissionMode || "fillOnly") === "autoGrade";
}

async function stopForCompletionOnce(runId, runToken, message) {
  if (completionAlertedRunId === runId) {
    await stopAutomation(null, { silent: true });
    return;
  }

  await safeSendRuntimeMessageWithResponse({
    type: "requestPrairieFocus",
    runId,
    runToken,
  });

  completionAlertedRunId = runId;
  await stopAutomation(message, { silent: false });
}

function classifyPageClass() {
  if (!isSupportedPage()) return "unsupported";

  if (isFreshQuestionPage()) {
    return "fresh_unanswered";
  }

  if (hasSubmittedResult()) {
    const status = parseSubmissionStatus() || "";
    if (status.includes("correct")) {
      return "graded_correct";
    }

    if (status.includes("incorrect") || status.includes("wrong")) {
      return "graded_incorrect";
    }
  }

  const gradeButton = document.querySelector(
    'button[name="__action"][value="grade"]'
  );

  if (gradeButton && gradeButton.disabled) {
    return "transitioning";
  }

  return "transitioning";
}

function getPageClass(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    pageClassCache.at > 0 &&
    now - pageClassCache.at < PAGE_CLASS_CACHE_TTL_MS
  ) {
    return pageClassCache.value;
  }

  const value = classifyPageClass();
  pageClassCache = { value, at: now };
  return value;
}

const { resolveOptionByToken, parseMultipleAnswerTokens } =
  globalThis.PLAAnswerUtils || {};

async function parseQuestion() {
  if (!isSupportedPage()) return null;

  const state = await getAutomationState();
  const questionText = getQuestionText();
  const options = getOptions().map((option) => option.text);
  const questionType = getQuestionType();

  if (!questionText || !options.length) {
    return null;
  }

  const previousCorrection =
    cachedSettings.carryWrongAnswerFeedbackToNextPrompt &&
    state.previousCorrectionPending &&
    state.lastIncorrectQuestion
      ? {
          question: state.lastIncorrectQuestion,
          incorrectAnswer: state.lastIncorrectAnswer,
        }
      : null;

  return {
    type: questionType,
    question: questionText,
    options,
    previousCorrection,
    promptStrategy: cachedSettings.promptStrategy,
    provider: cachedSettings.aiModel,
  };
}

function clearResumeTimer() {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
}

function suspendObserverWork() {
  observerSuspended = true;
  clearResumeTimer();
}

function resumeObserverWorkSoon() {
  setTimeout(() => {
    observerSuspended = false;
  }, RESUME_DEBOUNCE_MS);
}

async function stopAutomation(reason, options = {}) {
  const { silent = false } = options;

  immediateStopRequested = true;
  isAutomating = false;
  suspendObserverWork();
  updateButtonStateImmediate(
    {
      ...(lastKnownAutomationState || getDefaultAutomationState()),
      active: false,
      phase: "idle",
    },
    cachedSettings
  );
  scheduleButtonStateUpdate();

  const previousState = await getAutomationState();
  const nextState = {
    ...getDefaultAutomationState(),
    runId: (previousState.runId || 0) + 1,
    pageClass: getPageClass(true),
  };

  await saveAutomationState(nextState);
  immediateStopRequested = false;
  resumeObserverWorkSoon();
  scheduleButtonStateUpdate();

  if (reason && !silent) {
    alert(`Automation stopped: ${reason}`);
  }
}

function logAutomation(message, details) {
  if (!cachedSettings.debugMode) {
    return;
  }

  if (details === undefined) {
    console.log(`[AutoPrairieLearn][run:${currentRunId}] ${message}`);
    return;
  }

  console.log(`[AutoPrairieLearn][run:${currentRunId}] ${message}`, details);
}

async function initializeAutomationRuntimeState() {
  await refreshTabContext();
  await getSettings(true);
  let state = await getAutomationState();

  if (
    state.active &&
    currentTabId !== null &&
    (!state.ownerRunToken ||
      state.ownerTabId === null ||
      state.ownerTabId !== currentTabId)
  ) {
    state = {
      ...getDefaultAutomationState(),
      runId: (state.runId || 0) + 1,
    };
    await saveAutomationState(state);
  }

  isAutomating = !!state.active;
  currentRunId = state.runId || 0;
  lastKnownAutomationState = state;
  updateStatusBadge(state);
  return state;
}

function ensureStatusBadge() {
  let badge = document.querySelector(".autoprairielearn-status");
  if (badge || !buttonAdded) {
    return badge;
  }

  const controls = document.querySelector(".autoprairielearn-controls");
  if (!controls) return null;

  badge = document.createElement("div");
  badge.className = "autoprairielearn-status";
  badge.style.display = "flex";
  badge.style.alignItems = "center";
  badge.style.gap = "8px";
  badge.style.padding = "7px 10px";
  badge.style.border = "1px solid #d1d5db";
  badge.style.borderRadius = "10px";
  badge.style.background = "#f8fafc";
  badge.style.color = "#334155";
  badge.style.fontSize = "11px";
  badge.style.lineHeight = "1";
  badge.style.whiteSpace = "nowrap";
  badge.style.maxWidth = "280px";
  badge.style.overflow = "hidden";
  badge.textContent = "Ready";
  controls.parentElement?.appendChild(badge);
  return badge;
}

function updateStatusBadge(state) {
  const badge = ensureStatusBadge();
  if (!badge) return;

  if (!cachedSettings.showInlineStatusBadge) {
    badge.style.display = "none";
    return;
  }

  badge.style.display = "flex";
  const providerRaw = state.provider || cachedSettings.aiModel || "chatgpt";
  const providerLabel =
    providerRaw === "chatgpt"
      ? "ChatGPT"
      : providerRaw === "gemini"
        ? "Gemini"
        : "DeepSeek";
  const phaseLabel = state.active
    ? state.phase.replace(/_/g, " ")
    : "ready";
  const attemptsLabel = `V:${state.variantAttempts || 0}`;
  const statusLine = state.lastError
    ? "error"
    : state.providerHealth === "timeout"
      ? "timeout"
      : "ok";

  badge.innerHTML = `
    <strong style="font-weight:600;">${providerLabel}</strong>
    <span style="color:#64748b;">${phaseLabel}</span>
    <span style="color:#64748b;">${attemptsLabel}</span>
    <span style="margin-left:auto;color:#64748b;">${statusLine}</span>
  `;
}

function updatePhase(state, phase, extra = {}) {
  return saveAutomationState({
    ...state,
    ...extra,
    phase,
    pageClass: getPageClass(true),
    phaseStartedAt: Date.now(),
  });
}

function markNavigationStarted() {
  suspendObserverWork();
  invalidatePageClassCache();
  window.setTimeout(() => {
    resumeObserverWorkSoon();
  }, 1200);
}

function navigateWithFallback(link, description) {
  if (!link || !link.href) {
    return false;
  }

  const startingHref = window.location.href;
  logAutomation(`Navigating via ${description}`, {
    href: link.href,
    currentUrl: startingHref,
  });

  markNavigationStarted();

  try {
    link.click();
  } catch (error) {
    logAutomation(`Click failed for ${description}, falling back immediately`, {
      error: error.message,
      href: link.href,
    });
    window.location.assign(link.href);
    return true;
  }

  window.setTimeout(() => {
    if (window.location.href === startingHref) {
      logAutomation(`Fallback navigation for ${description}`, {
        href: link.href,
      });
      window.location.assign(link.href);
    }
  }, 300);

  return true;
}

function isOwnedByCurrentTab(state) {
  if (currentTabId === null) return false;
  return state.ownerTabId === currentTabId;
}

async function ensureQuestionStateInitialized() {
  const questionKey = getQuestionKey();
  const state = await getAutomationState();

  if (state.questionKey !== questionKey) {
    await saveAutomationState({
      ...state,
      questionKey,
      questionIndex: getQuestionIndex(),
      pageClass: getPageClass(true),
      variantAttempts: 0,
      pendingQuestionText: null,
      pendingSelectedAnswer: null,
      active: state.active,
      runId: state.runId,
      phase: state.phase,
    });
  }
}

function isRunActive(state, runId, runToken = state.ownerRunToken) {
  return (
    !!state.active &&
    state.runId === runId &&
    !immediateStopRequested &&
    isOwnedByCurrentTab(state) &&
    !!runToken &&
    state.ownerRunToken === runToken
  );
}

async function sendCurrentQuestionToAI(runId, runToken = null) {
  if (!isAutomating || immediateStopRequested) return;

  await ensureQuestionStateInitialized();
  const stateBeforeSend = await getAutomationState();
  const effectiveRunToken = runToken || stateBeforeSend.ownerRunToken;
  if (!isRunActive(stateBeforeSend, runId, effectiveRunToken)) return;

  if (
    stateBeforeSend.phase === "sending_to_ai" ||
    stateBeforeSend.phase === "waiting_for_ai"
  ) {
    return;
  }

  await saveAutomationState({
    ...stateBeforeSend,
    provider: cachedSettings.aiModel,
    lastError: null,
    lastStatusMessage: `Sending to ${cachedSettings.aiModel}...`,
    attentionNudgeRequested: false,
    phase: "sending_to_ai",
    pageClass: getPageClass(true),
    phaseStartedAt: Date.now(),
  });

  const questionData = await parseQuestion();
  const stateAfterParse = await getAutomationState();
  if (!isRunActive(stateAfterParse, runId, effectiveRunToken)) return;

  if (!questionData) {
    await stopAutomation(
      "No supported PrairieLearn answer options were found."
    );
    return;
  }

  await saveAutomationState({
    ...stateAfterParse,
    phase: "waiting_for_ai",
    provider: cachedSettings.aiModel,
    lastStatusMessage: `Waiting for ${cachedSettings.aiModel} response...`,
    attentionNudgeRequested: false,
    pageClass: getPageClass(true),
    phaseStartedAt: Date.now(),
  });

  const stateBeforeMessage = await getAutomationState();
  if (!isRunActive(stateBeforeMessage, runId, effectiveRunToken)) return;

  const sent = await safeSendRuntimeMessage({
    type: "sendQuestionToChatGPT",
    question: questionData,
  });

  const stateAfterMessage = await getAutomationState();
  if (!isRunActive(stateAfterMessage, runId, effectiveRunToken)) return;

  if (!sent) {
    await stopAutomation("Error communicating with the selected AI tab.");
    return;
  }

  if (stateAfterMessage.previousCorrectionPending) {
    await saveAutomationState({
      ...stateAfterMessage,
      lastIncorrectQuestion: null,
      lastIncorrectAnswer: null,
      previousCorrectionPending: false,
      lastStatusMessage: "Correction memory consumed.",
    });
  }
}

function selectMatchingSingleOption(answer) {
  const options = getOptions();
  const matchedOption = resolveOptionByToken(options, answer, {
    allowLooseIndex: false,
  });
  if (!matchedOption) {
    return null;
  }

  const radio = document.getElementById(matchedOption.id);
  if (!radio) {
    return null;
  }

  const label = document.querySelector(`label[for="${radio.id}"]`);
  if (label) {
    label.click();
  } else {
    radio.click();
  }

  radio.checked = true;
  radio.dispatchEvent(new Event("input", { bubbles: true }));
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  return matchedOption.text;
}

function setInputCheckedState(input, shouldBeChecked) {
  if (!input) return;

  const label = document.querySelector(`label[for="${input.id}"]`);
  if (input.checked !== shouldBeChecked) {
    if (label) {
      label.click();
    } else {
      input.click();
    }
  }

  if (input.checked !== shouldBeChecked) {
    input.checked = shouldBeChecked;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function selectMatchingMultipleOptions(answer) {
  const options = getOptions();
  if (!options.length) {
    return {
      selected: null,
      error: "No visible answer choices were found.",
    };
  }

  const parsed = parseMultipleAnswerTokens(answer, options);
  if (parsed.error) {
    return {
      selected: null,
      error: parsed.error,
    };
  }

  const selectedOptions = [];
  const selectedIds = new Set();

  for (const token of parsed.tokens) {
    const matchedOption = resolveOptionByToken(options, token, {
      allowLooseIndex: true,
    });

    if (!matchedOption) {
      return {
        selected: null,
        error:
          "AI response included a selection that did not match any visible choice.",
      };
    }

    if (!selectedIds.has(matchedOption.id)) {
      selectedIds.add(matchedOption.id);
      selectedOptions.push(matchedOption);
    }
  }

  if (!selectedOptions.length) {
    return {
      selected: null,
      error: "AI response did not include any valid selections.",
    };
  }

  for (const option of options) {
    const input = document.getElementById(option.id);
    if (!input) continue;
    const shouldBeChecked = selectedIds.has(option.id);
    setInputCheckedState(input, shouldBeChecked);
  }

  return {
    selected: selectedOptions.map((option) => option.text),
    error: null,
  };
}

function selectAnswerFromResponse(answer, questionType) {
  if (questionType === "multiple_select") {
    return selectMatchingMultipleOptions(answer);
  }

  const answerValue = Array.isArray(answer) ? answer[0] : answer;
  const selected = selectMatchingSingleOption(answerValue);
  if (!selected) {
    return {
      selected: null,
      error: "AI response did not match any visible answer choice.",
    };
  }

  return {
    selected,
    error: null,
  };
}

async function waitForEnabledGradeButton(runId, runToken, timeoutMs = SAVE_GRADE_WAIT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const latestState = await getAutomationState();
    if (!isRunActive(latestState, runId, runToken)) {
      return null;
    }

    const gradeButton = document.querySelector(
      'button[name="__action"][value="grade"]'
    );

    if (gradeButton && !gradeButton.disabled) {
      return gradeButton;
    }

    await new Promise((resolve) => setTimeout(resolve, SAVE_GRADE_POLL_MS));
  }

  return null;
}

async function maybeAutoGrade(selectedAnswerText) {
  const stateBeforeModeCheck = await getAutomationState();
  const runId = stateBeforeModeCheck.runId;
  const runToken = stateBeforeModeCheck.ownerRunToken;
  if (!isRunActive(stateBeforeModeCheck, runId, runToken)) return;

  const submissionMode = await getStorageValue("sync", "submissionMode");
  const stateAfterModeCheck = await getAutomationState();
  if (!isRunActive(stateAfterModeCheck, runId, runToken)) return;

  if ((submissionMode || "fillOnly") !== "autoGrade") {
    await stopAutomation(null, { silent: true });
    return;
  }

  const state = stateAfterModeCheck;
  const questionText = getQuestionText();
  const questionKey = getQuestionKey();
  const attemptCount =
    state.questionKey === questionKey ? state.variantAttempts + 1 : 1;

  await saveAutomationState({
    ...state,
    active: true,
    questionKey,
    questionIndex: getQuestionIndex(),
    variantAttempts: attemptCount,
    pendingQuestionText: questionText,
    pendingSelectedAnswer: selectedAnswerText,
    phase: "grading",
    lastStatusMessage: "Submitting Save & Grade...",
    pageClass: getPageClass(true),
    phaseStartedAt: Date.now(),
  });

  const gradeButton = await waitForEnabledGradeButton(runId, runToken);
  if (!gradeButton) {
    await stopAutomation(
      "Could not find an enabled Save & Grade button within 10 seconds."
    );
    return;
  }

  const latestState = await getAutomationState();
  if (!isRunActive(latestState, runId, runToken)) return;

  await saveAutomationState({
    ...latestState,
    phase: "waiting_for_result",
    lastStatusMessage: "Waiting for PrairieLearn result...",
    pageClass: getPageClass(true),
    phaseStartedAt: Date.now(),
  });

  gradeButton.click();
}

async function processChatGPTResponse(responseText) {
  try {
    const state = await getAutomationState();
    const runId = state.runId;
    const runToken = state.ownerRunToken;
    if (
      !isRunActive(state, runId, runToken) ||
      state.phase !== "waiting_for_ai"
    ) {
      return;
    }

    const response = JSON.parse(responseText);
    const questionType = getQuestionType();
    const selectionResult = selectAnswerFromResponse(response.answer, questionType);
    const selectedAnswer = selectionResult.selected;

    if (!selectedAnswer) {
      if (
        cachedSettings.promptStrategy === "retry_feedback" &&
        state.invalidResponseRetries < 1
      ) {
        await saveAutomationState({
          ...state,
          invalidResponseRetries: state.invalidResponseRetries + 1,
          phase: "idle",
          lastStatusMessage: "Retrying after invalid AI answer format...",
          pageClass: getPageClass(true),
          phaseStartedAt: Date.now(),
        });
        await sendCurrentQuestionToAI(runId, runToken);
        return;
      }

      await stopAutomation(
        selectionResult.error || "AI response did not match any visible answer choice."
      );
      return;
    }

    const latestState = await getAutomationState();
    if (!isRunActive(latestState, runId, runToken)) return;

    const selectedSummary = Array.isArray(selectedAnswer)
      ? selectedAnswer.join(" | ")
      : selectedAnswer;

    await saveAutomationState({
      ...latestState,
      phase: "answer_selected",
      invalidResponseRetries: 0,
      lastStatusMessage: `Selected answer: ${selectedSummary}`,
      pageClass: getPageClass(true),
      phaseStartedAt: Date.now(),
    });

    await maybeAutoGrade(selectedAnswer);
  } catch (error) {
    console.error("Error processing AI response:", error);
    if (cachedSettings.promptStrategy === "retry_feedback") {
      const state = await getAutomationState();
      if (
        state.invalidResponseRetries < 1 &&
        isRunActive(state, state.runId, state.ownerRunToken)
      ) {
        await saveAutomationState({
          ...state,
          invalidResponseRetries: state.invalidResponseRetries + 1,
          phase: "idle",
          lastStatusMessage: "Retrying after malformed AI JSON...",
          pageClass: getPageClass(true),
          phaseStartedAt: Date.now(),
        });
        await sendCurrentQuestionToAI(state.runId, state.ownerRunToken);
        return;
      }
    }

    await stopAutomation("Error processing AI response: " + error.message);
  }
}

function hasSubmittedResult() {
  const hasTryVariantLink = !!findTryNewVariantLink();
  const options = getOptions();
  const allInputsDisabled = options.length > 0 && options.every((option) => option.disabled);
  const submissionStatus = parseSubmissionStatus();

  return (
    hasTryVariantLink ||
    allInputsDisabled ||
    (submissionStatus !== null && !submissionStatus.includes("unanswered"))
  );
}

function isIncorrectSubmissionStatus(status) {
  if (!status) return false;

  const normalizedStatus = status.toLowerCase();
  return (
    normalizedStatus.includes("incorrect") ||
    normalizedStatus.includes("wrong")
  );
}

async function resumeAfterGrade(runId, runToken) {
  const state = await getAutomationState();
  if (!isRunActive(state, runId, runToken)) return;

  if (!hasSubmittedResult()) {
    return;
  }

  const points = parseQuestionPoints();
  const tryVariantLink = findTryNewVariantLink();
  const nextQuestionLink = findNextQuestionLink();
  const submissionStatus = parseSubmissionStatus();
  const wasIncorrectSubmission = isIncorrectSubmissionStatus(submissionStatus);

  logAutomation("Resume after grade", {
    phase: state.phase,
    submissionStatus,
    points,
    hasTryVariantLink: !!tryVariantLink,
    hasNextQuestionLink: !!nextQuestionLink,
  });

  if (isQuestionComplete()) {
    const shouldAutoAdvance = isAutoGradeModeActive() || !!cachedSettings.autoAdvanceQuestions;
    if (!shouldAutoAdvance) {
      await stopAutomation("Question completed. Auto-advance is disabled.", {
        silent: false,
      });
      return;
    }

    const nextState = {
      ...state,
      variantAttempts: 0,
      pendingQuestionText: null,
      pendingSelectedAnswer: null,
      phase: nextQuestionLink ? "waiting_for_next_question_load" : "idle",
      pageClass: getPageClass(true),
      lastStatusMessage: nextQuestionLink
        ? "Question complete. Advancing..."
        : "Assignment complete.",
      phaseStartedAt: Date.now(),
    };
    await saveAutomationState(nextState);

    const stateAfterComplete = await getAutomationState();
    if (!isRunActive(stateAfterComplete, runId, runToken) && nextQuestionLink) return;

    if (nextQuestionLink) {
      logAutomation("Advancing to next question", {
        href: nextQuestionLink.href,
      });
      navigateWithFallback(nextQuestionLink, "next question");
      return;
    }

    await stopForCompletionOnce(runId, runToken, "Completed all available questions.");
    return;
  }

  const wrongState = {
    ...state,
    pendingQuestionText: null,
    pendingSelectedAnswer: null,
    phase: "waiting_for_variant_load",
    pageClass: getPageClass(true),
    lastStatusMessage: "Loading a new variant...",
    phaseStartedAt: Date.now(),
  };

  if (wasIncorrectSubmission) {
    wrongState.lastIncorrectQuestion = state.pendingQuestionText;
    wrongState.lastIncorrectAnswer = state.pendingSelectedAnswer;
    wrongState.previousCorrectionPending = true;
  }

  await saveAutomationState(wrongState);

  const stateAfterWrong = await getAutomationState();
  if (!isRunActive(stateAfterWrong, runId, runToken)) return;

  const attempts = wrongState.variantAttempts || 0;
  const maxAttempts = cachedSettings.maxVariantsPerQuestion || MAX_VARIANT_ATTEMPTS;
  if (attempts >= maxAttempts) {
    const scoreText = points ? `${points.awarded}/${points.max}` : "incomplete";
    await stopAutomation(
      `Stopped after ${maxAttempts} variants on this question without reaching full points. Current score: ${scoreText}.`
    );
    return;
  }

  if (tryVariantLink) {
    logAutomation("Opening new variant", {
      href: tryVariantLink.href,
      attempts,
    });
    navigateWithFallback(tryVariantLink, "try a new variant");
    return;
  }

  if (hasSubmittedResult()) {
    await stopAutomation(
      "Question was graded but no 'Try a new variant' link was found."
    );
  }
}

async function resumeAutomationIfNeeded() {
  if (resumeInFlight || observerSuspended || immediateStopRequested) return;

  const state = await getAutomationState();
  isAutomating = !!state.active;
  scheduleButtonStateUpdate();

  if (!state.active) return;

  const runId = state.runId;
  const runToken = state.ownerRunToken;
  resumeInFlight = true;

  try {
    const latestState = await getAutomationState();
    if (!isRunActive(latestState, runId, runToken)) return;

    const pageClass = getPageClass();
    if (latestState.pageClass !== pageClass) {
      await saveAutomationState({
        ...latestState,
        pageClass,
      });
    }

    if (
      (latestState.phase === "waiting_for_variant_load" ||
        latestState.phase === "waiting_for_next_question_load") &&
      pageClass === "fresh_unanswered"
    ) {
      const resetState = {
        ...latestState,
        phase: "idle",
        pageClass,
      };

      if (latestState.phase === "waiting_for_next_question_load") {
        resetState.variantAttempts = 0;
        resetState.pendingQuestionText = null;
        resetState.pendingSelectedAnswer = null;
      }

      logAutomation("Fresh question page detected after navigation", {
        previousPhase: latestState.phase,
        questionKey: getQuestionKey(),
      });

      await saveAutomationState(resetState);
      await sendCurrentQuestionToAI(runId, runToken);
      return;
    }

    if (
      latestState.phase === "waiting_for_result" ||
      latestState.phase === "grading" ||
      ((latestState.phase === "waiting_for_variant_load" ||
        latestState.phase === "waiting_for_next_question_load") &&
        (pageClass === "graded_correct" || pageClass === "graded_incorrect"))
    ) {
      await resumeAfterGrade(runId, runToken);
      return;
    }

    if (
      pageClass === "fresh_unanswered" &&
      (latestState.phase === "idle" ||
        latestState.phase === "sending_to_ai" ||
        latestState.phase === "waiting_for_variant_load" ||
        latestState.phase === "waiting_for_next_question_load")
    ) {
      await sendCurrentQuestionToAI(runId, runToken);
      return;
    }
  } finally {
    resumeInFlight = false;
  }
}

async function checkForPhaseTimeout() {
  if (!isSupportedPage()) {
    clearPhaseWatchInterval();
    return;
  }

  const state = await getAutomationState();
  if (!state.active || !state.phaseStartedAt) {
    clearPhaseWatchInterval();
    return;
  }

  if (!isOwnedByCurrentTab(state)) {
    await stopAutomation(null, { silent: true });
    return;
  }

  const timeoutMs = (cachedSettings.responseTimeoutSeconds || 90) * 1000;
  const ageMs = Date.now() - state.phaseStartedAt;

  const timedPhases = new Set([
    "waiting_for_ai",
    "waiting_for_result",
    "waiting_for_variant_load",
    "waiting_for_next_question_load",
  ]);

  if (!timedPhases.has(state.phase) || ageMs < timeoutMs) {
    if (
      state.phase === "waiting_for_ai" &&
      ageMs >= AI_ATTENTION_NUDGE_DELAY_MS &&
      !state.attentionNudgeRequested
    ) {
      const provider = state.provider || cachedSettings.aiModel || "chatgpt";
      const providerName = getProviderDisplayName(provider);

      await saveAutomationState({
        ...state,
        attentionNudgeRequested: true,
        lastStatusMessage: `Still waiting for ${providerName}. Nudging provider tab...`,
        phaseStartedAt: state.phaseStartedAt,
      });

      const nudgeResult = await safeSendRuntimeMessageWithResponse({
        type: "requestProviderAttention",
        runId: state.runId,
        runToken: state.ownerRunToken,
        provider,
      });

      const latestState = await getAutomationState();
      if (isRunActive(latestState, state.runId, state.ownerRunToken)) {
        await saveAutomationState({
          ...latestState,
          lastStatusMessage:
            nudgeResult?.received && nudgeResult.nudged
              ? `Waiting for ${providerName} response after tab nudge...`
              : `Waiting for ${providerName} response...`,
          phaseStartedAt: latestState.phaseStartedAt || state.phaseStartedAt,
        });
      }
    }
    return;
  }

  await stopAutomation(`Timed out during phase "${state.phase.replace(/_/g, " ")}".`);
}

function scheduleResumeIfNeeded() {
  if (observerSuspended || immediateStopRequested) return;
  clearResumeTimer();
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    resumeAutomationIfNeeded();
  }, RESUME_DEBOUNCE_MS);
}

function checkForQuizAndAddButton() {
  if (buttonAdded || !isSupportedPage()) return;

  const footer = document.querySelector("#question-panel-footer .d-flex");
  if (!footer) return;

  addAssistantButton(footer);
  buttonAdded = true;
  scheduleButtonStateUpdate();
}

function nodeTouchesRelevantArea(node) {
  if (!(node instanceof Element)) return false;

  if (
    node.matches(
      "#question-panel-footer, .question-form, #question-score-panel, .autoprairielearn-controls, .autoprairielearn-status, input[name='only-answer'], button[name='__action'][value='grade'], #question-nav-next"
    )
  ) {
    return true;
  }

  if (
    node.closest(
      "#question-panel-footer, .question-form, #question-score-panel, .autoprairielearn-controls, .autoprairielearn-status"
    )
  ) {
    return true;
  }

  if (node.tagName === "A") {
    const text = (node.textContent || "").toLowerCase();
    if (text.includes("try a new variant") || text.includes("next question")) {
      return true;
    }
  }

  return false;
}

function mutationTouchesRelevantArea(mutations) {
  for (const mutation of mutations) {
    if (nodeTouchesRelevantArea(mutation.target)) return true;

    for (const addedNode of mutation.addedNodes) {
      if (nodeTouchesRelevantArea(addedNode)) return true;
    }

    for (const removedNode of mutation.removedNodes) {
      if (nodeTouchesRelevantArea(removedNode)) return true;
    }
  }

  return false;
}

function startPageObserver() {
  observer = new MutationObserver((mutations) => {
    if (observerSuspended || immediateStopRequested) return;
    if (!mutationTouchesRelevantArea(mutations)) return;

    invalidatePageClassCache();

    if (!buttonAdded) {
      checkForQuizAndAddButton();
    } else if (!document.querySelector(".autoprairielearn-btn") && isSupportedPage()) {
      buttonAdded = false;
      checkForQuizAndAddButton();
    } else {
      scheduleButtonStateUpdate();
    }

    scheduleResumeIfNeeded();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  checkForQuizAndAddButton();
  scheduleResumeIfNeeded();
  ensurePhaseWatchInterval();
}

function getButtonLabelFromState(state, settings) {
  const effectiveState = state || getDefaultAutomationState();
  const effectiveSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(settings || cachedSettings || {}),
  };
  const currentModel = effectiveSettings.aiModel || "chatgpt";
  const currentModelName = getProviderDisplayName(currentModel);

  if (effectiveState.active || isAutomating) {
    const labelMap = {
      sending_to_ai: "Stop Sending",
      waiting_for_ai: `Waiting for ${currentModelName}`,
      answer_selected: "Stop Before Grade",
      grading: "Grading...",
      waiting_for_result: "Waiting for Result",
      waiting_for_variant_load: "Opening Variant",
      waiting_for_next_question_load: "Next Question...",
    };
    return labelMap[effectiveState.phase] || "Stop Automation";
  }

  const submissionMode = effectiveSettings.submissionMode || "fillOnly";
  return submissionMode === "autoGrade"
    ? `Ask ${currentModelName} + Grade`
    : `Ask ${currentModelName}`;
}

function updateButtonStateImmediate(stateOverride = null, settingsOverride = null) {
  const btn = document.querySelector(".autoprairielearn-btn");
  if (!btn) return;

  const state = stateOverride || lastKnownAutomationState || getDefaultAutomationState();
  const settings = settingsOverride || cachedSettings;
  btn.textContent = getButtonLabelFromState(state, settings);
  updateStatusBadge(state);
}

function addAssistantButton(footer) {
  footer.style.flexWrap = "wrap";
  footer.style.rowGap = "8px";

  const wrapper = document.createElement("span");
  wrapper.className =
    "autoprairielearn-controls d-inline-flex align-items-center";
  wrapper.style.gap = "8px";
  wrapper.style.marginLeft = "auto";
  wrapper.style.alignItems = "center";
  wrapper.style.flexWrap = "nowrap";

  const mainButton = document.createElement("button");
  mainButton.type = "button";
  mainButton.className =
    "btn btn-outline-secondary btn-sm autoprairielearn-btn";
  mainButton.style.whiteSpace = "nowrap";
  mainButton.style.minWidth = "170px";
  mainButton.textContent = getButtonLabelFromState(
    lastKnownAutomationState || getDefaultAutomationState(),
    cachedSettings
  );
  mainButton.addEventListener("click", async () => {
    if (!isSupportedPage()) {
      alert("This PrairieLearn page layout is not supported yet.");
      return;
    }

    await refreshTabContext();
    await getSettings(true);
    if (currentTabId === null) {
      alert("Unable to determine PrairieLearn tab ownership. Please refresh and try again.");
      return;
    }

    const automationState = await getAutomationState();
    isAutomating = !!automationState.active;
    currentRunId = automationState.runId || 0;

    if (automationState.active) {
      await stopAutomation(null, { silent: true });
      return;
    }

    const initializedState = {
      ...getDefaultAutomationState(),
      active: true,
      runId: currentRunId + 1,
      ownerTabId: currentTabId,
      ownerRunToken: createRunToken(),
      phase: "idle",
      pageClass: getPageClass(true),
      provider: cachedSettings.aiModel,
      questionKey: getQuestionKey(),
      questionIndex: getQuestionIndex(),
      lastStatusMessage: `Starting with ${cachedSettings.aiModel}...`,
      phaseStartedAt: Date.now(),
    };
    await saveAutomationState(initializedState);
    updateButtonStateImmediate(initializedState, cachedSettings);
    scheduleButtonStateUpdate();
    await sendCurrentQuestionToAI(
      initializedState.runId,
      initializedState.ownerRunToken
    );
  });

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className =
    "btn btn-outline-secondary btn-sm autoprairielearn-settings-btn";
  settingsButton.style.whiteSpace = "nowrap";
  settingsButton.textContent = "Settings";
  settingsButton.addEventListener("click", () => {
    safeSendRuntimeMessage({ type: "openSettings" });
  });

  wrapper.appendChild(mainButton);
  wrapper.appendChild(settingsButton);
  footer.appendChild(wrapper);
  ensureStatusBadge();
  updateButtonStateImmediate(
    lastKnownAutomationState || getDefaultAutomationState(),
    cachedSettings
  );
}

function scheduleButtonStateUpdate() {
  if (buttonUpdateTimer) {
    clearTimeout(buttonUpdateTimer);
  }

  buttonUpdateTimer = setTimeout(() => {
    buttonUpdateTimer = null;
    updateButtonState();
  }, BUTTON_STATE_DEBOUNCE_MS);
}

async function updateButtonState() {
  if (buttonUpdateInFlight) return;
  buttonUpdateInFlight = true;

  const btn = document.querySelector(".autoprairielearn-btn");
  if (!btn) {
    buttonUpdateInFlight = false;
    return;
  }

  try {
    const automationState = await getAutomationState();
    const settings = await getSettings();
    updateButtonStateImmediate(automationState, settings);
  } finally {
    buttonUpdateInFlight = false;
  }
}

function setupMessageListener() {
  if (!hasLiveExtensionContext()) {
    return;
  }

  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      sendResponse({ received: true, ready: isSupportedPage() });
      return true;
    }

    if (message.type === "processChatGPTResponse") {
      processChatGPTResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "providerStatus") {
      getAutomationState().then((state) => {
        if (!state.active || !isOwnedByCurrentTab(state)) {
          return;
        }
        saveAutomationState({
          ...state,
          provider: message.status?.provider || state.provider,
          providerHealth: message.status?.health || state.providerHealth,
          lastStatusMessage: message.status?.message || state.lastStatusMessage,
          lastError:
            message.status?.health === "error"
              ? message.status?.message || state.lastError
              : state.lastError,
        });
      });
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      stopAutomation(null, { silent: true }).then(() => {
        sendResponse({ received: true });
      });
      return true;
    }

    return false;
  };

  if (hasLiveExtensionContext()) {
    chrome.runtime.onMessage.addListener(messageListener);
  }
}

function setupSettingsListener() {
  if (!chrome.storage?.onChanged) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    let didUpdate = false;

    for (const [key, change] of Object.entries(changes)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SYNC_SETTINGS, key)) {
        cachedSettings[key] = change.newValue;
        didUpdate = true;
      }
    }

    if (didUpdate) {
      scheduleButtonStateUpdate();
    }
  });
}

setupMessageListener();
setupSettingsListener();
initializeAutomationRuntimeState().then(() => {
  startPageObserver();

  if (!hasRunInitialResume) {
    hasRunInitialResume = true;
    window.setTimeout(() => {
      resumeAutomationIfNeeded();
    }, 0);
  }
});
