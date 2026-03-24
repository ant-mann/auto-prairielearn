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
  const { type, question, options, previousCorrection, promptStrategy } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (previousCorrection && previousCorrection.question) {
    if (previousCorrection.correctAnswer) {
      text =
        `CORRECTION FROM PREVIOUS ANSWER: For the question "${
          previousCorrection.question
        }", your answer was incorrect. The correct answer was: ${JSON.stringify(
          previousCorrection.correctAnswer
        )}\n\nNow answer this new question:\n\n` + text;
    } else if (previousCorrection.incorrectAnswer) {
      text =
        `FEEDBACK FROM PREVIOUS VARIANT: For the question "${
          previousCorrection.question
        }", your previous answer ${JSON.stringify(
          previousCorrection.incorrectAnswer
        )} was incorrect.\n\nNow answer this new question:\n\n` + text;
    } else {
      text =
        `FEEDBACK FROM PREVIOUS VARIANT: Your previous answer for the question "${
          previousCorrection.question
        }" was incorrect.\n\nNow answer this new question:\n\n` + text;
    }
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      "\n\nPlease match each prompt with the correct choice. Format your answer as an array where each element is 'Prompt -> Choice'.";
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (type === "multiple_select") {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nIMPORTANT: This is a select-all-that-apply question. The "answer" field must be a JSON array containing every correct option exactly as written. If only one option applies, still return an array with one string.';
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  if (promptStrategy === "strict_json") {
    if (type === "multiple_select") {
      text +=
        '\n\nCRITICAL: Return only compact JSON. Do not wrap JSON in markdown. The "answer" value must be an array of exact option strings from the list.';
    } else {
      text +=
        '\n\nCRITICAL: Return only compact JSON. Do not wrap the JSON in markdown. The "answer" value must be a single option string copied exactly from the list.';
    }
  } else if (promptStrategy === "retry_feedback") {
    if (type === "multiple_select") {
      text +=
        '\n\nBe extra careful. If your previous answer was wrong or malformed, correct that behavior now. Return all correct options as an exact string array in valid JSON.';
    } else {
      text +=
        '\n\nBe extra careful. If your previous answer was wrong or malformed, correct that behavior now. Return one exact option string in valid JSON.';
    }
  } else {
    text +=
      '\n\nChoose the best answer, then explain it briefly in one sentence.';
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
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
