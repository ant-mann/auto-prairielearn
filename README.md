# Auto-PrairieLearn

> A Chrome extension that automates PrairieLearn question solving by sending each question to an AI provider tab (ChatGPT, Gemini, or DeepSeek), selecting the returned answers, and optionally grading and navigating automatically.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Chrome](https://img.shields.io/badge/Platform-Chrome-blue.svg)
![Providers: ChatGPT · Gemini · DeepSeek](https://img.shields.io/badge/AI-ChatGPT%20%7C%20Gemini%20%7C%20DeepSeek-blueviolet)

---

## 🚀 Installation (Developer Mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `auto-prairielearn` folder
5. Open PrairieLearn and at least one provider tab (ChatGPT, Gemini, or DeepSeek)

---

## ⚠️ Known Limitations

- Does **not** yet support:
  - Free-response, numeric, or text entry questions
  - Multipart/compound question formats outside the `only-answer` layout
- Provider site DOM changes may require maintenance updates

---

## ✨ Features

Supports PrairieLearn student question pages at:
```
https://*/pl/course_instance/*/instance_question/*
```

- Extracts prompt text from `.card-body.question-body` and answer choices from `input[name="only-answer"]`
- Supports single-answer (`radio`) and select-all (`checkbox`) multiple choice
- Sends a structured prompt and expects a JSON response: `{"answer": ..., "explanation": ...}`
- Applies answer matching with punctuation/whitespace tolerance

### Submission Modes

| Mode | Behaviour |
|------|-----------|
| `fillOnly` | Selects the answer and stops |
| `autoGrade` | Clicks **Save & Grade**, retries new variants until full points are reached, then advances to the next question. Enforces a configurable max-variant limit. |

---

## 🤖 Provider Notes

| Provider | Notes |
|----------|-------|
| **Gemini** ⭐ best-supported | Plain-text-safe composer insertion for code prompts (`<`, `>`, etc.) to avoid truncation |
| **ChatGPT** | Supports logged-in and best-effort logged-out modes. Logged-out mode uses extra readiness checks and focus-hold handling |
| **DeepSeek** | JSON-oriented response capture path |

---

## 🛡️ Reliability Features

- **Tab-bound run ownership** — prevents stale runs from jumping to unrelated PrairieLearn tabs
- **Phase-driven state machine** with timeout handling
- **Observer throttling/debouncing** to reduce runaway loops and browser slowdown
- **Receiver bootstrapping** in background messaging to recover when scripts aren't attached yet
- **Inline status badge** showing provider, phase, variant count, and health
- **Immediate button label rendering** to avoid first-paint empty-button flash
- **Wrong-answer memory** — when PrairieLearn marks an attempt wrong, the next prompt can include that the previous answer was incorrect (without claiming the correct answer)

---

## ⚙️ Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `aiModel` | `chatgpt \| gemini \| deepseek` | — | AI provider to use |
| `submissionMode` | `fillOnly \| autoGrade` | — | How answers are submitted |
| `maxVariantsPerQuestion` | number | `6` | Max retries per question |
| `autoAdvanceQuestions` | boolean | — | Automatically move to the next question |
| `carryWrongAnswerFeedbackToNextPrompt` | boolean | — | Include previous wrong answer in next prompt |
| `responseTimeoutSeconds` | number | — | Seconds to wait for a provider response |
| `focusAITabWhileSending` | boolean | — | Switch focus to the AI tab while sending |
| `fallbackProvider` | provider | — | Optional fallback if primary provider fails |
| `stopOnProviderError` | boolean | — | Stop the run on a provider error |
| `showInlineStatusBadge` | boolean | — | Show the inline status badge on the page |
| `debugMode` | boolean | — | Enable verbose debug logging |
| `promptStrategy` | `strict_json \| answer_explain \| retry_feedback` | — | Prompt format strategy |

---

## 🧪 Testing

Run the regression tests for answer normalization/parsing logic:

```bash
npm test
```

These tests cover the shared `content-scripts/answer-utils.js` module used by the PrairieLearn content script.

---

## ⚠️ Disclaimer

This project is provided for educational and research purposes. You are responsible for complying with your course, institution, and platform policies, including academic integrity requirements. **Use this software at your own risk.**

---

## 🙏 Attribution

- Includes code adapted from [**Auto-McGraw**](https://github.com/GooglyBlox/auto-mcgraw) — MIT License, Copyright (c) 2025 GooglyBlox
- PrairieLearn extraction shape was initially adapted from the workspace `bookmarklet.js` flow

---

## 📄 License

This project is licensed under the **MIT License** — see [LICENSE](./LICENSE).

Portions derived from Auto-McGraw remain under the MIT License and retain the original copyright notice.

For third-party license notices, see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).