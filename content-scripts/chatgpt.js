/**
 * ChatGPT integration supports two runtime modes:
 * 1) Signed-in chat UI where the extension can directly type and submit prompts.
 * 2) Logged-out or restricted UI where we still detect readiness/health and report
 *    deterministic errors back to PrairieLearn for fallback handling.
 *
 * The focus-hold logic below exists to keep the composer stable while synthetic input
 * events are dispatched, which prevents intermittent prompt loss in dynamic UI updates.
 */
let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
const PROVIDER_NAME = "chatgpt";

const CHAT_INPUT_SELECTORS = [
  "#prompt-textarea",
  '[contenteditable="true"][data-testid*="composer"]',
  '[contenteditable="true"][id*="prompt"]',
  '[contenteditable="true"][placeholder*="Message"]',
  '[contenteditable="true"][placeholder*="Ask"]',
  '[contenteditable="true"].ProseMirror',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="Ask"]',
  "textarea",
  'div[contenteditable="true"]',
];

const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="Send"]',
  'button[data-testid*="send"]',
  'form button[type="submit"]',
];

const { buildPromptText } = globalThis.PLAAnswerUtils || {};

const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid*="conversation-turn"]',
  'main article',
  '[role="main"] article',
  '[role="presentation"] article',
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ received: true, ready: true, provider: PROVIDER_NAME });
    return true;
  }

  if (message.type === "getProviderContext") {
    sendResponse({
      received: true,
      provider: PROVIDER_NAME,
      mode: getPageMode(),
    });
    return true;
  }

  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = getAssistantMessages();
    messageCountAtQuestion = messages.length;
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        logChatGPT("Prompt delivery failed", { error: error.message });
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function logChatGPT(message, details) {
  if (details === undefined) {
    console.log(`[AutoPrairieLearn ChatGPT] ${message}`);
    return;
  }

  console.log(`[AutoPrairieLearn ChatGPT] ${message}`, details);
}

function reportProviderHealth(health, message) {
  chrome.runtime.sendMessage({
    type: "providerHealth",
    status: {
      provider: PROVIDER_NAME,
      health,
      message,
      mode: getPageMode(),
    },
  }).catch(() => {});
}

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function isVisibleElement(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    (element.offsetWidth > 0 || element.offsetHeight > 0)
  );
}

function getPageMode() {
  if (
    document.querySelector('button[data-testid="login-button"]') ||
    document.querySelector('a[href*="auth"]') ||
    document.body.textContent.includes("Log in")
  ) {
    return "logged_out";
  }

  if (document.querySelector('[data-message-author-role="assistant"]')) {
    return "logged_in";
  }

  return "unknown";
}

function getComposerState() {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;

    const disabled =
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.getAttribute("contenteditable") === "false";

    const state = {
      element,
      selector,
      disabled,
      visible: isVisibleElement(element),
      mode: getPageMode(),
    };

    if (!state.visible) continue;
    return state;
  }

  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (!isVisibleElement(button)) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function findSendButton() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    const button = document.querySelector(selector);
    if (isButtonUsable(button)) {
      return button;
    }
  }

  const allButtons = Array.from(document.querySelectorAll("button"));
  return (
    allButtons.find((button) => {
      const label = (
        button.getAttribute("aria-label") ||
        button.textContent ||
        ""
      ).toLowerCase();
      return label.includes("send") && isButtonUsable(button);
    }) || null
  );
}

function updateTextInputValue(input, text) {
  const prototype = Object.getPrototypeOf(input);
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (valueSetter) {
    valueSetter.call(input, text);
  } else {
    input.value = text;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value === text;
}

function updateContentEditableValue(input, text) {
  input.focus();

  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection.addRange(range);
  }

  try {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  } catch (error) {}

  if (!input.textContent || input.textContent.trim() !== text.trim()) {
    input.textContent = text;
  }

  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text,
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return input.textContent.trim().length > 0;
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    return updateTextInputValue(chatInput, text);
  }

  if (chatInput.isContentEditable) {
    return updateContentEditableValue(chatInput, text);
  }

  return false;
}

function canUseEnterToSubmit(input) {
  if (!input) return false;
  if (input instanceof HTMLTextAreaElement) return false;
  return !!input.isContentEditable;
}

function dispatchSubmitWithEnter(input) {
  logChatGPT("Attempting keyboard submit fallback");

  const events = [
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
    new KeyboardEvent("keypress", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  ];

  for (const event of events) {
    input.dispatchEvent(event);
  }
}

function getComposerValue(input) {
  if (!input) return "";
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    return (input.value || "").trim();
  }

  if (input.isContentEditable) {
    return (input.textContent || "").trim();
  }

  return "";
}

function hasGenerationIndicator() {
  return !!(
    document.querySelector('[aria-label*="Stop generating"]') ||
    document.querySelector('[data-testid*="stop-button"]') ||
    document.querySelector(".result-streaming")
  );
}

async function verifyPromptSubmission(input, expectedText, timeoutMs = 3500) {
  const expected = (expectedText || "").trim();
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (hasGenerationIndicator()) {
      return true;
    }

    const composerValue = getComposerValue(input);
    if (!composerValue) {
      return true;
    }

    if (expected && composerValue !== expected && composerValue.length < expected.length) {
      return true;
    }

    const sendButton = findSendButton();
    if (!sendButton) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return false;
}

function getAssistantMessages() {
  const messages = [];
  const seen = new Set();

  for (const selector of ASSISTANT_MESSAGE_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (!isVisibleElement(node) || seen.has(node)) continue;

      const text = (node.textContent || "").trim();
      if (!text) continue;

      if (
        selector !== '[data-message-author-role="assistant"]' &&
        !node.querySelector('[data-message-author-role="assistant"]') &&
        !/answer|explanation|\{|\}/i.test(text)
      ) {
        continue;
      }

      seen.add(node);
      messages.push(node);
    }
  }

  return messages;
}

function extractResponseText(messageNode) {
  if (!messageNode) return "";

  const codeBlocks = messageNode.querySelectorAll("pre code");
  for (const block of codeBlocks) {
    const className = block.className || "";
    if (className.includes("language-json") || /\{[\s\S]*\}/.test(block.textContent)) {
      return block.textContent.trim();
    }
  }

  const markdownCodeBlocks = messageNode.querySelectorAll("code");
  for (const block of markdownCodeBlocks) {
    const text = block.textContent.trim();
    if (text.startsWith("{") && text.includes('"answer"')) {
      return text;
    }
  }

  const responseText = messageNode.textContent.trim();
  const jsonMatch = responseText.match(/\{[\s\S]*"answer"[\s\S]*"explanation"[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : responseText;
}

function normalizeResponseText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n\s*/g, " ")
    .trim();
}

function getPromptText(questionData) {
  return buildPromptText(questionData, "chatgpt");
}

function ensureComposerReady() {
  const composerState = getComposerState();
  if (!composerState) {
    logChatGPT("No usable composer found", { mode: getPageMode() });
    reportProviderHealth("blocked", "ChatGPT page is open but no usable composer was found.");
    throw new Error("ChatGPT page is open but no usable composer was found.");
  }

  logChatGPT("Composer detected", {
    mode: composerState.mode,
    selector: composerState.selector,
    disabled: composerState.disabled,
  });

  if (composerState.disabled) {
    reportProviderHealth("blocked", "ChatGPT page is open but not ready for guest prompting.");
    throw new Error("ChatGPT page is open but not ready for guest prompting.");
  }

  return composerState;
}

async function deliverPrompt(text) {
  const composerState = ensureComposerReady();
  const inputArea = composerState.element;

  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!updateChatInputValue(inputArea, text)) {
    reportProviderHealth("error", "ChatGPT composer could not be filled.");
    throw new Error("Unable to fill the ChatGPT composer.");
  }

  await new Promise((resolve) => setTimeout(resolve, 250));

  const sendButton = findSendButton();
  if (sendButton) {
    logChatGPT("Sending with button", {
      mode: composerState.mode,
      selector: sendButton.getAttribute("data-testid") || sendButton.getAttribute("aria-label") || sendButton.textContent?.trim() || "button",
    });
    sendButton.click();

    const submitted = await verifyPromptSubmission(inputArea, text);
    if (!submitted) {
      reportProviderHealth(
        "error",
        "ChatGPT prompt was entered but submission did not start."
      );
      throw new Error(
        "ChatGPT prompt was entered but submission did not start."
      );
    }

    reportProviderHealth("ready", "ChatGPT accepted the prompt.");
    return;
  }

  if (canUseEnterToSubmit(inputArea)) {
    dispatchSubmitWithEnter(inputArea);

    const submitted = await verifyPromptSubmission(inputArea, text);
    if (!submitted) {
      reportProviderHealth(
        "error",
        "ChatGPT prompt was entered but keyboard submission did not start."
      );
      throw new Error(
        "ChatGPT prompt was entered but keyboard submission did not start."
      );
    }

    reportProviderHealth("ready", "ChatGPT accepted the prompt.");
    return;
  }

  reportProviderHealth("error", "ChatGPT composer was filled, but no send action was available.");
  throw new Error("ChatGPT composer was filled, but no send action was available.");
}

async function insertQuestion(questionData) {
  const text = getPromptText(questionData);
  await deliverPrompt(text);
  startObserving();
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      logChatGPT("Timed out waiting for ChatGPT response");
      reportProviderHealth("timeout", "Timed out waiting for ChatGPT to respond.");
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver(() => {
    if (hasResponded) return;

    const messages = getAssistantMessages();
    if (!messages.length) return;
    if (messages.length <= messageCountAtQuestion) return;

    const latestMessage = messages[messages.length - 1];
    let responseText = normalizeResponseText(extractResponseText(latestMessage));

    try {
      const parsed = JSON.parse(responseText);
      if (parsed.answer && !hasResponded) {
        hasResponded = true;
        logChatGPT("Captured JSON response", {
          mode: getPageMode(),
        });
        chrome.runtime
          .sendMessage({
            type: "chatGPTResponse",
            response: responseText,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            console.error("Error sending response:", error);
          });
      }
    } catch (error) {
      const isGenerating =
        latestMessage.querySelector(".result-streaming") ||
        latestMessage.querySelector('[data-testid*="stop-button"]') ||
        document.querySelector('[aria-label*="Stop generating"]');

      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const fallbackText = normalizeResponseText(latestMessage.textContent.trim());
        const jsonPattern = /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
        const jsonMatch = fallbackText.match(jsonPattern);

        if (jsonMatch && !hasResponded) {
          hasResponded = true;
          logChatGPT("Captured fallback JSON response", {
            mode: getPageMode(),
          });
          chrome.runtime.sendMessage({
            type: "chatGPTResponse",
            response: jsonMatch[0],
          });
          resetObservation();
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
