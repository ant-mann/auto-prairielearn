const AUTOMATION_STATE_KEY = "autoPrairieLearnState";

const DEFAULT_SYNC_SETTINGS = {
  aiModel: "chatgpt",
  fallbackProvider: "",
  focusAITabWhileSending: true,
  stopOnProviderError: false,
  debugMode: false,
};

const ROLE_CONFIG = {
  prairie: {
    scriptFile: "content-scripts/prairielearn.js",
    label: "PrairieLearn",
    isSupportedUrl: (url = "") =>
      /^https:\/\/[^/]+\/pl\/course_instance\/[^/]+\/instance_question\/[^/]+/i.test(
        url
      ),
  },
  chatgpt: {
    scriptFile: "content-scripts/chatgpt.js",
    label: "ChatGPT",
    queryUrls: ["https://chatgpt.com/*"],
    isSupportedUrl: (url = "") => url.includes("://chatgpt.com/"),
  },
  gemini: {
    scriptFile: "content-scripts/gemini.js",
    label: "Gemini",
    queryUrls: ["https://gemini.google.com/*"],
    isSupportedUrl: (url = "") => url.includes("://gemini.google.com/"),
  },
  deepseek: {
    scriptFile: "content-scripts/deepseek.js",
    label: "DeepSeek",
    queryUrls: ["https://chat.deepseek.com/*", "https://deepseek.chat/*"],
    isSupportedUrl: (url = "") =>
      url.includes("://chat.deepseek.com/") || url.includes("://deepseek.chat/"),
  },
};

const RESPONSE_TYPE_TO_PROVIDER = {
  chatGPTResponse: "chatgpt",
  geminiResponse: "gemini",
  deepseekResponse: "deepseek",
};

let lastActiveTabId = null;
let activePrairieTabId = null;
let activePrairieWindowId = null;
let activeRunId = 0;
let activeRunToken = null;
let settingsCache = { ...DEFAULT_SYNC_SETTINGS };
const providerTabIds = {
  chatgpt: null,
  gemini: null,
  deepseek: null,
};
const providerFocusHolds = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableErrorCode(code) {
  return (
    code === "RECEIVER_MISSING" ||
    code === "TAB_LOADING" ||
    code === "MESSAGE_PORT_CLOSED" ||
    code === "FRAME_GONE" ||
    code === "SEND_FAILED_RETRYABLE"
  );
}

function createTypedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeMessagingError(error) {
  const rawMessage = (error && error.message ? error.message : "").toLowerCase();
  const explicitCode = error && error.code ? error.code : null;

  if (explicitCode) {
    return {
      code: explicitCode,
      retryable: isRetryableErrorCode(explicitCode),
      message: error.message || "Unknown messaging error.",
      original: error,
    };
  }

  if (rawMessage.includes("receiving end does not exist")) {
    return {
      code: "RECEIVER_MISSING",
      retryable: true,
      message: error.message,
      original: error,
    };
  }

  if (rawMessage.includes("message port closed before a response was received")) {
    return {
      code: "MESSAGE_PORT_CLOSED",
      retryable: true,
      message: error.message,
      original: error,
    };
  }

  if (
    rawMessage.includes("no tab with id") ||
    rawMessage.includes("tab was closed")
  ) {
    return {
      code: "TAB_CLOSED",
      retryable: false,
      message: error.message,
      original: error,
    };
  }

  if (rawMessage.includes("frame with id") && rawMessage.includes("removed")) {
    return {
      code: "FRAME_GONE",
      retryable: true,
      message: error.message,
      original: error,
    };
  }

  if (rawMessage.includes("cannot access contents of url")) {
    return {
      code: "URL_UNSUPPORTED",
      retryable: false,
      message: error.message,
      original: error,
    };
  }

  return {
    code: "UNKNOWN",
    retryable: false,
    message: error && error.message ? error.message : "Unknown messaging error.",
    original: error,
  };
}

function normalizeProvider(provider) {
  if (provider === "chatgpt" || provider === "gemini" || provider === "deepseek") {
    return provider;
  }
  return "chatgpt";
}

function providerLabel(provider) {
  const role = ROLE_CONFIG[provider];
  return role ? role.label : "AI provider";
}

function buildRunKey(runId, runToken, ownerTabId) {
  return `${runId || 0}:${runToken || "none"}:${ownerTabId || "none"}`;
}

function isHoldMatchingState(hold, state) {
  return !!(
    hold &&
    state &&
    state.active &&
    state.runId === hold.runId &&
    state.ownerRunToken === hold.runToken &&
    state.ownerTabId === hold.ownerTabId
  );
}

function registerProviderFocusHold(hold) {
  if (!hold || !hold.provider) return;
  providerFocusHolds.set(hold.provider, {
    ...hold,
    key: buildRunKey(hold.runId, hold.runToken, hold.ownerTabId),
    createdAt: Date.now(),
  });
}

function clearProviderFocusHold(provider) {
  providerFocusHolds.delete(provider);
}

function clearFocusHoldsForOwner(ownerTabId) {
  for (const [provider, hold] of providerFocusHolds.entries()) {
    if (hold.ownerTabId === ownerTabId) {
      providerFocusHolds.delete(provider);
    }
  }
}

function clearStaleFocusHoldsForState(state) {
  for (const [provider, hold] of providerFocusHolds.entries()) {
    if (!isHoldMatchingState(hold, state)) {
      providerFocusHolds.delete(provider);
    }
  }
}

function debugLog(message, details) {
  if (!settingsCache.debugMode) return;
  if (details === undefined) {
    console.log(`[AutoPrairieLearn BG] ${message}`);
    return;
  }
  console.log(`[AutoPrairieLearn BG] ${message}`, details);
}

async function getSyncSettings(forceRefresh = false) {
  if (!forceRefresh && settingsCache) {
    return settingsCache;
  }

  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SYNC_SETTINGS));
  settingsCache = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(stored || {}),
  };
  return settingsCache;
}

async function getAutomationState() {
  const stored = await chrome.storage.local.get(AUTOMATION_STATE_KEY);
  return stored[AUTOMATION_STATE_KEY] || null;
}

function updateRunPointersFromState(state) {
  if (!state) return;

  activeRunId = state.runId || 0;
  activeRunToken = state.ownerRunToken || null;

  if (state.active && Number.isInteger(state.ownerTabId)) {
    activePrairieTabId = state.ownerTabId;
  }
}

async function resetPersistedRun(reason = null) {
  const state = await getAutomationState();
  if (!state || !state.active) {
    providerFocusHolds.clear();
    return;
  }

  const nextState = {
    ...state,
    active: false,
    runId: (state.runId || 0) + 1,
    phase: "idle",
    ownerTabId: null,
    ownerRunToken: null,
    pageClass: "unsupported",
    lastStatusMessage: reason || "Stopped.",
    lastError: reason || state.lastError || null,
    phaseStartedAt: Date.now(),
  };

  await chrome.storage.local.set({ [AUTOMATION_STATE_KEY]: nextState });
  activeRunId = nextState.runId;
  activeRunToken = null;
  providerFocusHolds.clear();
}

async function getTabSafe(tabId) {
  if (!Number.isInteger(tabId)) return null;

  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

function isTabUrlSupportedForRole(role, url) {
  const config = ROLE_CONFIG[role];
  if (!config) return false;
  return config.isSupportedUrl(url || "");
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function waitForTabComplete(tabId, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await getTabSafe(tabId);
    if (!tab) {
      throw createTypedError("TAB_CLOSED", `Tab ${tabId} was closed.`);
    }

    if (tab.status === "complete") {
      return tab;
    }

    await sleep(200);
  }

  throw createTypedError(
    "TAB_LOADING",
    `Tab ${tabId} did not finish loading before timeout.`
  );
}

async function pingReceiver(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: "ping" });
    return !!(response && response.received);
  } catch (error) {
    const meta = normalizeMessagingError(error);
    if (meta.code === "RECEIVER_MISSING" || meta.code === "MESSAGE_PORT_CLOSED") {
      return false;
    }
    throw error;
  }
}

async function injectRoleScript(tabId, role) {
  const config = ROLE_CONFIG[role];
  if (!config) {
    throw createTypedError("ROLE_UNKNOWN", `Unknown role: ${role}`);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [config.scriptFile],
    });
  } catch (error) {
    throw createTypedError(
      "SCRIPT_INJECTION_FAILED",
      `Failed to inject ${config.scriptFile}: ${error.message}`,
      { tabId, role }
    );
  }
}

async function ensureReceiver(tabId, role, timeoutBudgetMs = 12000) {
  const startedAt = Date.now();
  let injected = false;

  while (Date.now() - startedAt < timeoutBudgetMs) {
    const remainingMs = timeoutBudgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }

    const tab = await getTabSafe(tabId);
    if (!tab) {
      throw createTypedError("TAB_CLOSED", `Tab ${tabId} was closed.`, {
        tabId,
        role,
      });
    }

    if (!isTabUrlSupportedForRole(role, tab.url || "")) {
      throw createTypedError(
        "URL_UNSUPPORTED",
        `Tab ${tabId} URL is not supported for role "${role}".`,
        {
          tabId,
          role,
          url: tab.url,
        }
      );
    }

    try {
      await waitForTabComplete(tabId, Math.min(remainingMs, 3000));
    } catch (error) {
      const meta = normalizeMessagingError(error);
      if (!meta.retryable) {
        throw error;
      }

      debugLog("Receiver wait: tab not complete yet", { tabId, role });
      await sleep(200);
      continue;
    }

    try {
      const ready = await pingReceiver(tabId);
      if (ready) {
        return { ready: true, injected };
      }
    } catch (error) {
      const meta = normalizeMessagingError(error);
      if (!meta.retryable) {
        throw error;
      }
    }

    if (!injected) {
      debugLog("Receiver missing, injecting content script", { tabId, role });
      await injectRoleScript(tabId, role);
      injected = true;
      await sleep(150);
      continue;
    }

    await sleep(250);
  }

  throw createTypedError(
    "RECEIVER_UNAVAILABLE",
    `Receiver bootstrap timed out for ${role} tab ${tabId}.`,
    { tabId, role }
  );
}

async function sendMessageWithRecovery(
  tabId,
  role,
  message,
  options = {}
) {
  const timeoutBudgetMs = options.timeoutBudgetMs || 12000;
  const startedAt = Date.now();
  let backoffMs = 200;
  let lastError = null;

  while (Date.now() - startedAt < timeoutBudgetMs) {
    try {
      const remaining = timeoutBudgetMs - (Date.now() - startedAt);
      await ensureReceiver(tabId, role, Math.min(remaining, 6000));
      return await sendTabMessage(tabId, message);
    } catch (error) {
      const meta = normalizeMessagingError(error);
      lastError = error;

      debugLog("Send attempt failed", {
        tabId,
        role,
        errorCode: meta.code,
        retryable: meta.retryable,
        message: meta.message,
      });

      if (!meta.retryable) {
        throw error;
      }

      if (Date.now() - startedAt + backoffMs >= timeoutBudgetMs) {
        break;
      }

      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 1600);
    }
  }

  throw (
    lastError ||
    createTypedError(
      "SEND_FAILED_RETRYABLE",
      `Timed out sending message to role "${role}" on tab ${tabId}.`
    )
  );
}

async function getOwnedPrairieTab(options = {}) {
  const requireActive = options.requireActive !== false;
  const state = await getAutomationState();
  updateRunPointersFromState(state);

  if (requireActive && (!state || !state.active)) {
    return null;
  }

  const ownerTabId =
    state && state.active && Number.isInteger(state.ownerTabId)
      ? state.ownerTabId
      : activePrairieTabId;

  if (!Number.isInteger(ownerTabId)) {
    return null;
  }

  const tab = await getTabSafe(ownerTabId);
  if (!tab) {
    return null;
  }

  if (!isTabUrlSupportedForRole("prairie", tab.url || "")) {
    return null;
  }

  activePrairieTabId = tab.id;
  activePrairieWindowId = tab.windowId;
  return tab;
}

async function sendToPrairie(message, options = {}) {
  const prairieTab = await getOwnedPrairieTab({
    requireActive: options.requireActive !== false,
  });
  if (!prairieTab) {
    if (options.resetIfMissingOwner) {
      await resetPersistedRun("Origin PrairieLearn tab is no longer available.");
    }
    return false;
  }

  try {
    await sendMessageWithRecovery(prairieTab.id, "prairie", message, {
      timeoutBudgetMs: options.timeoutBudgetMs || 10000,
    });
    return true;
  } catch (error) {
    const meta = normalizeMessagingError(error);
    debugLog("Failed to send message to PrairieLearn", {
      tabId: prairieTab.id,
      errorCode: meta.code,
      message: meta.message,
      messageType: message.type,
    });

    if (meta.code === "TAB_CLOSED") {
      await resetPersistedRun("Origin PrairieLearn tab closed.");
      activePrairieTabId = null;
      activePrairieWindowId = null;
    }

    return false;
  }
}

async function focusTab(tabId) {
  const tab = await getTabSafe(tabId);
  if (!tab) return false;

  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function getProviderContextForDispatch(provider, providerTabId) {
  if (provider !== "chatgpt") {
    return { mode: "unknown" };
  }

  try {
    const response = await sendMessageWithRecovery(
      providerTabId,
      provider,
      { type: "getProviderContext" },
      { timeoutBudgetMs: 6000 }
    );

    return {
      mode: (response && response.mode) || "unknown",
    };
  } catch (error) {
    return { mode: "unknown" };
  }
}

async function restorePrairieFocusFromHold(provider, reason) {
  const hold = providerFocusHolds.get(provider);
  if (!hold) {
    return false;
  }

  providerFocusHolds.delete(provider);

  const state = await getAutomationState();
  if (!isHoldMatchingState(hold, state)) {
    debugLog("Ignoring stale provider focus hold", {
      provider,
      reason,
      holdRunId: hold.runId,
      stateRunId: state?.runId,
    });
    return false;
  }

  const focused = await focusTab(hold.ownerTabId);
  debugLog("Restored PrairieLearn focus from provider hold", {
    provider,
    reason,
    runId: hold.runId,
    ownerTabId: hold.ownerTabId,
    focused,
  });

  return focused;
}

async function findProviderTab(provider) {
  const config = ROLE_CONFIG[provider];
  if (!config || !Array.isArray(config.queryUrls)) {
    return null;
  }

  const rememberedId = providerTabIds[provider];
  if (Number.isInteger(rememberedId)) {
    const rememberedTab = await getTabSafe(rememberedId);
    if (
      rememberedTab &&
      isTabUrlSupportedForRole(provider, rememberedTab.url || "")
    ) {
      return rememberedTab;
    }
  }

  const tabs = await chrome.tabs.query({ url: config.queryUrls });
  if (!tabs.length) {
    return null;
  }

  const activeInPrairieWindow = tabs.find(
    (tab) =>
      tab.active &&
      Number.isInteger(activePrairieWindowId) &&
      tab.windowId === activePrairieWindowId
  );

  const activeTab = tabs.find((tab) => tab.active);
  const completeTab = tabs.find((tab) => tab.status === "complete");
  const chosen = activeInPrairieWindow || activeTab || completeTab || tabs[0];
  providerTabIds[provider] = chosen.id;
  return chosen;
}

function getProviderOrder(primary, fallback) {
  const first = normalizeProvider(primary);
  const order = [first];
  const normalizedFallback = normalizeProvider(fallback || "");

  if (fallback && normalizedFallback !== first) {
    order.push(normalizedFallback);
  }

  return order;
}

function formatProviderDispatchError(provider, error) {
  const meta = normalizeMessagingError(error);
  const label = providerLabel(provider);

  if (meta.code === "URL_UNSUPPORTED") {
    return `${label} tab URL is unsupported for automation.`;
  }
  if (meta.code === "TAB_CLOSED") {
    return `${label} tab was closed.`;
  }
  if (meta.code === "RECEIVER_UNAVAILABLE") {
    return `${label} tab is open but the extension receiver did not become ready in time.`;
  }
  if (meta.code === "SCRIPT_INJECTION_FAILED") {
    return `Failed to initialize extension script in ${label} tab.`;
  }
  if (meta.code === "TAB_LOADING") {
    return `${label} is still loading and did not become ready in time.`;
  }
  if (meta.code === "PROVIDER_REJECTED") {
    return `${label} refused the prompt: ${meta.message}`;
  }
  return `Error communicating with ${label}.`;
}

async function routeProviderStatus(provider, health, message, extra = {}) {
  await sendToPrairie({
    type: "providerStatus",
    status: {
      provider: normalizeProvider(provider),
      health: health || "ready",
      message: message || "",
      ...(extra || {}),
    },
  });
}

async function dispatchQuestionToProvider(provider, question, settings, runContext) {
  const providerTab = await findProviderTab(provider);
  if (!providerTab) {
    throw createTypedError(
      "PROVIDER_TAB_MISSING",
      `${providerLabel(provider)} tab is not open.`
    );
  }

  const providerContext = await getProviderContextForDispatch(provider, providerTab.id);
  const providerMode = providerContext.mode || "unknown";
  const shouldHoldFocus = provider === "chatgpt" && providerMode === "logged_out";

  let tabToRestore = null;
  const shouldFocus =
    shouldHoldFocus ||
    (!!settings.focusAITabWhileSending &&
      Number.isInteger(activePrairieWindowId) &&
      providerTab.windowId === activePrairieWindowId);

  if (shouldFocus) {
    tabToRestore = Number.isInteger(runContext?.ownerTabId)
      ? runContext.ownerTabId
      : Number.isInteger(lastActiveTabId)
        ? lastActiveTabId
        : activePrairieTabId;
    await focusTab(providerTab.id);
    await sleep(120);
  }

  let holdActivated = false;

  try {
    const response = await sendMessageWithRecovery(
      providerTab.id,
      provider,
      { type: "receiveQuestion", question },
      { timeoutBudgetMs: 15000 }
    );

    if (!response || response.received === false) {
      throw createTypedError(
        "PROVIDER_REJECTED",
        response && response.error
          ? response.error
          : `${providerLabel(provider)} rejected the prompt delivery.`
      );
    }

    if (
      shouldHoldFocus &&
      Number.isInteger(runContext?.runId) &&
      !!runContext?.runToken &&
      Number.isInteger(runContext?.ownerTabId)
    ) {
      registerProviderFocusHold({
        provider,
        runId: runContext.runId,
        runToken: runContext.runToken,
        ownerTabId: runContext.ownerTabId,
        providerTabId: providerTab.id,
        providerMode,
      });
      holdActivated = true;
      debugLog("Activated logged-out ChatGPT focus hold", {
        runId: runContext.runId,
        ownerTabId: runContext.ownerTabId,
        providerTabId: providerTab.id,
      });
    }

    return {
      providerMode,
      focusHoldActivated: holdActivated,
    };
  } finally {
    if (!holdActivated && tabToRestore && tabToRestore !== providerTab.id) {
      setTimeout(() => {
        focusTab(tabToRestore).catch(() => {});
      }, 700);
    }
  }
}

async function handleSendQuestion(message, sender) {
  const senderTab = sender && sender.tab ? sender.tab : null;
  if (!senderTab || !isTabUrlSupportedForRole("prairie", senderTab.url || "")) {
    return;
  }

  await getSyncSettings(true);

  const state = await getAutomationState();
  updateRunPointersFromState(state);
  clearStaleFocusHoldsForState(state);

  if (
    state &&
    state.active &&
    Number.isInteger(state.ownerTabId) &&
    state.ownerTabId !== senderTab.id
  ) {
    debugLog("Ignoring question dispatch from non-owner PrairieLearn tab", {
      senderTabId: senderTab.id,
      ownerTabId: state.ownerTabId,
    });
    return;
  }

  activePrairieTabId = senderTab.id;
  activePrairieWindowId = senderTab.windowId;
  const runContext = {
    runId: state?.runId || 0,
    runToken: state?.ownerRunToken || null,
    ownerTabId: state?.ownerTabId ?? senderTab.id,
  };

  const selectedProvider = normalizeProvider(
    (message.question && message.question.provider) || settingsCache.aiModel
  );
  const providerOrder = getProviderOrder(
    selectedProvider,
    settingsCache.fallbackProvider
  );

  let lastError = null;
  let usedProvider = selectedProvider;

  for (const provider of providerOrder) {
    usedProvider = provider;
    try {
      await routeProviderStatus(provider, "ready", `Sending to ${providerLabel(provider)}...`);
      const dispatchResult = await dispatchQuestionToProvider(
        provider,
        message.question,
        settingsCache,
        runContext
      );
      await routeProviderStatus(
        provider,
        "ready",
        `${providerLabel(provider)} accepted the prompt.`,
        { mode: dispatchResult?.providerMode || "unknown" }
      );
      return;
    } catch (error) {
      lastError = error;
      clearProviderFocusHold(provider);
      const providerMessage = formatProviderDispatchError(provider, error);
      await routeProviderStatus(provider, "error", providerMessage);
      debugLog("Provider dispatch failed", {
        provider,
        errorCode: normalizeMessagingError(error).code,
        providerMessage,
      });
    }
  }

  const fallbackNotice =
    providerOrder.length > 1
      ? ` Attempted fallback provider as well.`
      : "";
  const errorText =
    formatProviderDispatchError(usedProvider, lastError || new Error("Unknown")) +
    fallbackNotice;

  await sendToPrairie({
    type: "alertMessage",
    message: errorText,
  });
  await sendToPrairie({
    type: "stopAutomation",
  });
}

async function handleProviderResponse(message, sender, provider) {
  if (!message || typeof message.response !== "string") {
    return;
  }

  const senderTab = sender && sender.tab ? sender.tab : null;
  if (senderTab && Number.isInteger(senderTab.id)) {
    providerTabIds[provider] = senderTab.id;
  }

  await restorePrairieFocusFromHold(provider, "response");

  const prairieTab = await getOwnedPrairieTab({ requireActive: true });
  if (!prairieTab) {
    debugLog("Dropping provider response because owner PrairieLearn tab is gone", {
      provider,
    });
    await resetPersistedRun("Origin PrairieLearn tab is no longer available.");
    return;
  }

  await sendToPrairie(
    {
      type: "processChatGPTResponse",
      response: message.response,
    },
    { resetIfMissingOwner: true }
  );
}

async function handleProviderHealth(message, sender) {
  const status = message && message.status ? message.status : {};
  const senderTab = sender && sender.tab ? sender.tab : null;
  const inferredProvider =
    normalizeProvider(
      status.provider ||
        (senderTab && senderTab.url
          ? Object.keys(ROLE_CONFIG).find(
              (role) =>
                role !== "prairie" &&
                isTabUrlSupportedForRole(role, senderTab.url || "")
            )
          : "chatgpt")
    ) || "chatgpt";

  if (senderTab && Number.isInteger(senderTab.id)) {
    providerTabIds[inferredProvider] = senderTab.id;
  }

  const health = (status.health || "").toLowerCase();
  const isTerminalHealth =
    health === "error" || health === "blocked" || health === "timeout";
  if (isTerminalHealth) {
    await restorePrairieFocusFromHold(inferredProvider, `health:${health}`);
  }

  await routeProviderStatus(
    inferredProvider,
    status.health || "ready",
    status.message || "",
    { mode: status.mode || "unknown" }
  );

  if (
    isTerminalHealth &&
    settingsCache.stopOnProviderError
  ) {
    await sendToPrairie({
      type: "alertMessage",
      message:
        status.message ||
        `${providerLabel(inferredProvider)} reported a provider error.`,
    });
    await sendToPrairie({ type: "stopAutomation" });
  }
}

async function handlePrairieFocusRequest(message, sender) {
  const senderTab = sender && sender.tab ? sender.tab : null;
  if (!senderTab || !isTabUrlSupportedForRole("prairie", senderTab.url || "")) {
    return { received: false, reason: "invalid_sender" };
  }

  const state = await getAutomationState();
  if (!state || !state.active) {
    return { received: false, reason: "run_inactive" };
  }

  if (!Number.isInteger(state.ownerTabId) || state.ownerTabId !== senderTab.id) {
    return { received: false, reason: "not_owner_tab" };
  }

  if (Number.isInteger(message.runId) && state.runId !== message.runId) {
    return { received: false, reason: "run_mismatch" };
  }

  if (message.runToken && state.ownerRunToken !== message.runToken) {
    return { received: false, reason: "token_mismatch" };
  }

  const focused = await focusTab(senderTab.id);
  return { received: true, focused };
}

async function handleProviderAttentionRequest(message, sender) {
  const senderTab = sender && sender.tab ? sender.tab : null;
  if (!senderTab || !isTabUrlSupportedForRole("prairie", senderTab.url || "")) {
    return { received: false, reason: "invalid_sender" };
  }

  await getSyncSettings(true);
  const state = await getAutomationState();
  updateRunPointersFromState(state);

  if (!state || !state.active) {
    return { received: false, reason: "run_inactive" };
  }

  if (!Number.isInteger(state.ownerTabId) || state.ownerTabId !== senderTab.id) {
    return { received: false, reason: "not_owner_tab" };
  }

  if (Number.isInteger(message.runId) && state.runId !== message.runId) {
    return { received: false, reason: "run_mismatch" };
  }

  if (message.runToken && state.ownerRunToken !== message.runToken) {
    return { received: false, reason: "token_mismatch" };
  }

  const provider = normalizeProvider(
    message.provider || state.provider || settingsCache.aiModel
  );
  const providerTab = await findProviderTab(provider);
  if (!providerTab) {
    return { received: false, reason: "provider_tab_missing", provider };
  }

  if (providerTab.id === senderTab.id) {
    return { received: true, nudged: false, provider };
  }

  const focusedProvider = await focusTab(providerTab.id);
  if (!focusedProvider) {
    return { received: false, reason: "provider_focus_failed", provider };
  }

  await sleep(450);
  await focusTab(senderTab.id);

  debugLog("Provider attention nudge completed", {
    provider,
    runId: state.runId,
    prairieTabId: senderTab.id,
    providerTabId: providerTab.id,
  });

  return { received: true, nudged: true, provider };
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activePrairieTabId) {
    activePrairieTabId = null;
    activePrairieWindowId = null;
    clearFocusHoldsForOwner(tabId);
    resetPersistedRun("Origin PrairieLearn tab closed.").catch(() => {});
  } else {
    getAutomationState()
      .then((state) => {
        if (state && state.active && state.ownerTabId === tabId) {
          activePrairieTabId = null;
          activePrairieWindowId = null;
          clearFocusHoldsForOwner(tabId);
          return resetPersistedRun("Origin PrairieLearn tab closed.");
        }
        return null;
      })
      .catch(() => {});
  }

  for (const provider of Object.keys(providerTabIds)) {
    if (providerTabIds[provider] === tabId) {
      providerTabIds[provider] = null;
      clearProviderFocusHold(provider);
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  for (const [key, change] of Object.entries(changes)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SYNC_SETTINGS, key)) {
      settingsCache[key] = change.newValue;
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ received: false });
    return false;
  }

  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "getSenderContext") {
    sendResponse({
      received: true,
      tabId: sender && sender.tab ? sender.tab.id : null,
      windowId: sender && sender.tab ? sender.tab.windowId : null,
    });
    return true;
  }

  if (message.type === "openSettings") {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL("popup/settings.html"),
        type: "popup",
        width: 520,
        height: 700,
      },
      () => {
        sendResponse({ received: !chrome.runtime.lastError });
      }
    );
    return true;
  }

  if (message.type === "sendQuestionToChatGPT") {
    handleSendQuestion(message, sender)
      .then(() => {
        sendResponse({ received: true });
      })
      .catch((error) => {
        debugLog("Unhandled error in sendQuestionToChatGPT", {
          error: error.message,
        });
        sendResponse({ received: false });
      });
    return true;
  }

  if (message.type === "requestProviderAttention") {
    handleProviderAttentionRequest(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        debugLog("Unhandled error in requestProviderAttention", {
          error: error.message,
        });
        sendResponse({ received: false, reason: "internal_error" });
      });
    return true;
  }

  if (message.type === "requestPrairieFocus") {
    handlePrairieFocusRequest(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        debugLog("Unhandled error in requestPrairieFocus", {
          error: error.message,
        });
        sendResponse({ received: false, reason: "internal_error" });
      });
    return true;
  }

  if (message.type === "providerHealth") {
    handleProviderHealth(message, sender)
      .then(() => sendResponse({ received: true }))
      .catch(() => sendResponse({ received: false }));
    return true;
  }

  const providerFromResponse = RESPONSE_TYPE_TO_PROVIDER[message.type];
  if (providerFromResponse) {
    handleProviderResponse(message, sender, providerFromResponse)
      .then(() => sendResponse({ received: true }))
      .catch((error) => {
        debugLog("Unhandled error while handling provider response", {
          error: error.message,
          provider: providerFromResponse,
        });
        sendResponse({ received: false });
      });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

getSyncSettings(true).catch(() => {});
