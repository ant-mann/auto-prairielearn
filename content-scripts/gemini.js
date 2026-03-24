let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
const PROVIDER_NAME = "gemini";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ received: true, ready: true, provider: PROVIDER_NAME });
    return true;
  }

  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll("model-response");
    messageCountAtQuestion = messages.length;
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

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

function reportProviderHealth(health, message) {
  chrome.runtime.sendMessage({
    type: "providerHealth",
    status: {
      provider: PROVIDER_NAME,
      health,
      message,
    },
  }).catch(() => {});
}

function waitForIdle(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const sendButton = document.querySelector(".send-button");
      if (!sendButton || !sendButton.classList.contains("stop")) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for Gemini to finish responding"));
      }
    }, 500);
  });
}

function normalizeComposerText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n/g, "\n");
}

function setGeminiComposerTextSafe(inputArea, text) {
  if (!inputArea) return false;

  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  inputArea.focus();
  inputArea.innerHTML = "";

  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const paragraph = document.createElement("p");
    if (line.length === 0) {
      paragraph.appendChild(document.createElement("br"));
    } else {
      paragraph.textContent = line;
    }
    fragment.appendChild(paragraph);
  }

  inputArea.appendChild(fragment);
  inputArea.dispatchEvent(new Event("input", { bubbles: true }));
  inputArea.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function verifyGeminiComposerText(inputArea, expectedText) {
  if (!inputArea) {
    return { ok: false, reason: "Gemini input area not found." };
  }

  const expected = normalizeComposerText(expectedText);
  const actual = normalizeComposerText(inputArea.textContent || "");

  if (!actual.trim()) {
    return { ok: false, reason: "Gemini composer remained empty after insertion." };
  }

  if (expected.includes("<") && !actual.includes("<")) {
    return { ok: false, reason: "Gemini composer lost '<' characters from code." };
  }

  if (expected.includes(">") && !actual.includes(">")) {
    return { ok: false, reason: "Gemini composer lost '>' characters from code." };
  }

  const expectedLines = expected
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (expectedLines.length) {
    const trailingLine = expectedLines[expectedLines.length - 1];
    if (trailingLine && !actual.includes(trailingLine)) {
      return { ok: false, reason: "Gemini composer is missing the trailing prompt lines." };
    }
  }

  return { ok: true };
}

async function insertQuestion(questionData) {
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
        '\n\nCRITICAL: Return only valid JSON. The "answer" value must be an array of exact option strings copied from the list.';
    } else {
      text +=
        '\n\nCRITICAL: Return only valid JSON with an exact option string in "answer".';
    }
  } else if (promptStrategy === "retry_feedback") {
    if (type === "multiple_select") {
      text +=
        '\n\nDouble-check every selected option and return all correct selections as an exact string array in valid JSON.';
    } else {
      text +=
        '\n\nDouble-check the answer and return one exact option string in valid JSON.';
    }
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return new Promise((resolve, reject) => {
    waitForIdle()
      .then(() => {
        const inputArea = document.querySelector(".ql-editor");
        if (inputArea) {
          setTimeout(() => {
            if (!setGeminiComposerTextSafe(inputArea, text)) {
              reportProviderHealth("error", "Gemini composer could not be filled.");
              reject(new Error("Unable to fill Gemini composer"));
              return;
            }

            const verification = verifyGeminiComposerText(inputArea, text);
            if (!verification.ok) {
              reportProviderHealth("error", verification.reason);
              reject(new Error(verification.reason));
              return;
            }

            setTimeout(() => {
              const sendButton = document.querySelector(".send-button");
              if (sendButton) {
                reportProviderHealth("ready", "Gemini accepted the prompt.");
                sendButton.click();
                startObserving();
                resolve();
              } else {
                reportProviderHealth("blocked", "Gemini send button not found.");
                reject(new Error("Send button not found"));
              }
            }, 300);
          }, 300);
        } else {
          reportProviderHealth("blocked", "Gemini input area not found.");
          reject(new Error("Input area not found"));
        }
      })
      .catch(reject);
  });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      reportProviderHealth("timeout", "Timed out waiting for Gemini to respond.");
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver((mutations) => {
    if (hasResponded) return;

    const messages = document.querySelectorAll("model-response");
    if (!messages.length) return;

    if (messages.length <= messageCountAtQuestion) return;

    const latestMessage = messages[messages.length - 1];

    const codeBlocks = latestMessage.querySelectorAll("pre code");
    let responseText = "";

    for (const block of codeBlocks) {
      if (block.className.includes("hljs-") || block.closest(".code-block")) {
        responseText = block.textContent.trim();
        break;
      }
    }

    if (!responseText) {
      responseText = latestMessage.textContent.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) responseText = jsonMatch[0];
    }

    responseText = responseText
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();

    try {
      const parsed = JSON.parse(responseText);
      if (parsed.answer && !hasResponded) {
        hasResponded = true;
        chrome.runtime
          .sendMessage({
            type: "geminiResponse",
            response: responseText,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            console.error("Error sending response:", error);
          });
      }
    } catch (e) {
      const isGenerating =
        latestMessage.querySelector(".cursor") ||
        latestMessage.classList.contains("generating");

      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const responseText = latestMessage.textContent.trim();
        try {
          const jsonPattern =
            /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
          const jsonMatch = responseText.match(jsonPattern);

          if (jsonMatch && !hasResponded) {
            hasResponded = true;
            chrome.runtime.sendMessage({
              type: "geminiResponse",
              response: jsonMatch[0],
            });
            resetObservation();
          }
        } catch (e) {}
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
