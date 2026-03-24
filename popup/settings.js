let availabilityPollIntervalId = null;

const PROVIDERS = ["chatgpt", "gemini", "deepseek"];

const DEFAULT_SETTINGS = {
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

const PROVIDER_QUERY_PATTERNS = {
  chatgpt: ["https://chatgpt.com/*"],
  gemini: ["https://gemini.google.com/*"],
  deepseek: ["https://chat.deepseek.com/*", "https://deepseek.chat/*"],
};

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    chatgptButton: document.getElementById("chatgpt"),
    geminiButton: document.getElementById("gemini"),
    deepseekButton: document.getElementById("deepseek"),
    statusMessage: document.getElementById("status-message"),
    submissionModeToggle: document.getElementById("submission-mode-toggle"),
    autoAdvanceToggle: document.getElementById("auto-advance-toggle"),
    carryFeedbackToggle: document.getElementById("carry-feedback-toggle"),
    showBadgeToggle: document.getElementById("show-badge-toggle"),
    maxVariantsInput: document.getElementById("max-variants-input"),
    responseTimeoutInput: document.getElementById("response-timeout-input"),
    promptStrategySelect: document.getElementById("prompt-strategy-select"),
    focusAITabToggle: document.getElementById("focus-ai-toggle"),
    stopOnErrorToggle: document.getElementById("stop-on-error-toggle"),
    fallbackProviderSelect: document.getElementById("fallback-provider-select"),
    debugModeToggle: document.getElementById("debug-mode-toggle"),
    footerVersionElement: document.getElementById("footer-version"),
    availability: {
      chatgpt: document.getElementById("chatgpt-availability"),
      gemini: document.getElementById("gemini-availability"),
      deepseek: document.getElementById("deepseek-availability"),
    },
  };

  const manifest = chrome.runtime.getManifest();
  elements.footerVersionElement.textContent = `v${manifest.version}`;

  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  renderSettings(settings, elements);
  bindEvents(elements, settings);
  refreshAvailability(settings.aiModel, elements);
  availabilityPollIntervalId = setInterval(() => {
    refreshAvailability(settings.aiModel, elements);
  }, 5000);
});

window.addEventListener("unload", () => {
  if (availabilityPollIntervalId) {
    clearInterval(availabilityPollIntervalId);
    availabilityPollIntervalId = null;
  }
});

function renderSettings(settings, elements) {
  setActiveButton(settings.aiModel, elements);
  elements.submissionModeToggle.checked = settings.submissionMode === "autoGrade";
  elements.autoAdvanceToggle.checked = !!settings.autoAdvanceQuestions;
  elements.carryFeedbackToggle.checked = !!settings.carryWrongAnswerFeedbackToNextPrompt;
  elements.showBadgeToggle.checked = !!settings.showInlineStatusBadge;
  elements.maxVariantsInput.value = settings.maxVariantsPerQuestion;
  elements.responseTimeoutInput.value = settings.responseTimeoutSeconds;
  elements.promptStrategySelect.value = settings.promptStrategy;
  elements.focusAITabToggle.checked = !!settings.focusAITabWhileSending;
  elements.stopOnErrorToggle.checked = !!settings.stopOnProviderError;
  elements.fallbackProviderSelect.value = settings.fallbackProvider || "";
  elements.debugModeToggle.checked = !!settings.debugMode;
}

function bindEvents(elements, settings) {
  elements.chatgptButton.addEventListener("click", () => setActiveModel("chatgpt", elements, settings));
  elements.geminiButton.addEventListener("click", () => setActiveModel("gemini", elements, settings));
  elements.deepseekButton.addEventListener("click", () => setActiveModel("deepseek", elements, settings));

  elements.submissionModeToggle.addEventListener("change", async () => {
    settings.submissionMode = elements.submissionModeToggle.checked ? "autoGrade" : "fillOnly";
    await persist(settings);
  });

  elements.autoAdvanceToggle.addEventListener("change", async () => {
    settings.autoAdvanceQuestions = elements.autoAdvanceToggle.checked;
    await persist(settings);
  });

  elements.carryFeedbackToggle.addEventListener("change", async () => {
    settings.carryWrongAnswerFeedbackToNextPrompt = elements.carryFeedbackToggle.checked;
    await persist(settings);
  });

  elements.showBadgeToggle.addEventListener("change", async () => {
    settings.showInlineStatusBadge = elements.showBadgeToggle.checked;
    await persist(settings);
  });

  elements.focusAITabToggle.addEventListener("change", async () => {
    settings.focusAITabWhileSending = elements.focusAITabToggle.checked;
    await persist(settings);
  });

  elements.stopOnErrorToggle.addEventListener("change", async () => {
    settings.stopOnProviderError = elements.stopOnErrorToggle.checked;
    await persist(settings);
  });

  elements.debugModeToggle.addEventListener("change", async () => {
    settings.debugMode = elements.debugModeToggle.checked;
    await persist(settings);
  });

  elements.maxVariantsInput.addEventListener("change", async () => {
    settings.maxVariantsPerQuestion = clampNumber(elements.maxVariantsInput.value, 1, 20, DEFAULT_SETTINGS.maxVariantsPerQuestion);
    elements.maxVariantsInput.value = settings.maxVariantsPerQuestion;
    await persist(settings);
  });

  elements.responseTimeoutInput.addEventListener("change", async () => {
    settings.responseTimeoutSeconds = clampNumber(elements.responseTimeoutInput.value, 15, 300, DEFAULT_SETTINGS.responseTimeoutSeconds);
    elements.responseTimeoutInput.value = settings.responseTimeoutSeconds;
    await persist(settings);
  });

  elements.promptStrategySelect.addEventListener("change", async () => {
    settings.promptStrategy = elements.promptStrategySelect.value;
    await persist(settings);
  });

  elements.fallbackProviderSelect.addEventListener("change", async () => {
    settings.fallbackProvider =
      elements.fallbackProviderSelect.value === settings.aiModel
        ? ""
        : elements.fallbackProviderSelect.value;
    elements.fallbackProviderSelect.value = settings.fallbackProvider;
    await persist(settings);
  });
}

async function setActiveModel(model, elements, settings) {
  settings.aiModel = model;
  if (settings.fallbackProvider === model) {
    settings.fallbackProvider = "";
    elements.fallbackProviderSelect.value = "";
  }
  await persist(settings);
  setActiveButton(model, elements);
  refreshAvailability(model, elements);
}

function setActiveButton(model, elements) {
  elements.chatgptButton.classList.toggle("active", model === "chatgpt");
  elements.geminiButton.classList.toggle("active", model === "gemini");
  elements.deepseekButton.classList.toggle("active", model === "deepseek");
}

async function persist(settings) {
  await chrome.storage.sync.set(settings);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function refreshAvailability(currentModel, elements) {
  elements.statusMessage.textContent = "Checking assistant availability...";
  elements.statusMessage.className = "";

  const statuses = {};
  for (const provider of PROVIDERS) {
    statuses[provider] = await getProviderStatus(provider);
    updateAvailabilityPill(provider, statuses[provider], elements.availability[provider]);
  }

  const currentStatus = statuses[currentModel];
  if (currentStatus.ready) {
    elements.statusMessage.textContent = `${labelForProvider(currentModel)} tab is open and ready.`;
    elements.statusMessage.className = "success";
  } else {
    elements.statusMessage.textContent = currentStatus.reason;
    elements.statusMessage.className = "error";
  }
}

async function getProviderStatus(provider) {
  const patterns = PROVIDER_QUERY_PATTERNS[provider] || [];
  const query = patterns.length === 1 ? { url: patterns[0] } : { url: patterns };
  const tabs = await chrome.tabs.query(query);

  if (!tabs.length) {
    return {
      ready: false,
      reason: `Please open ${labelForProvider(provider)} in another tab to use this assistant.`,
    };
  }

  return {
    ready: true,
    reason: `${labelForProvider(provider)} tab is open.`,
  };
}

function updateAvailabilityPill(provider, status, node) {
  if (!node) return;
  node.textContent = status.ready ? "Ready" : "Missing";
  node.className = `availability ${status.ready ? "ready" : "error"}`;
}

function labelForProvider(provider) {
  if (provider === "chatgpt") return "ChatGPT";
  if (provider === "gemini") return "Gemini";
  return "DeepSeek";
}
