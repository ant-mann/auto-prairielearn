# Auto-PrairieLearn

Chrome extension that automates PrairieLearn question solving by sending each question to an AI provider tab (ChatGPT, Gemini, or DeepSeek), selecting returned answers on PrairieLearn, and optionally grading/navigating automatically.

## Current capabilities

- Supports PrairieLearn student question pages under:
  - `https://*/pl/course_instance/*/instance_question/*`
- Extracts prompt text from `.card-body.question-body` and answer choices from `input[name="only-answer"]`.
- Supports both:
  - single-answer multiple choice (`type="radio"`)
  - select-all multiple choice (`type="checkbox"`)
- Sends a structured prompt to the selected provider and expects JSON:
  - `{"answer": ..., "explanation": ...}`
- Applies answer matching with punctuation/whitespace tolerance.
- `fillOnly` mode:
  - selects answers and stops.
- `autoGrade` mode:
  - clicks `Save & Grade`
  - retries new variants until full question points are reached
  - advances to next question when complete
  - stops cleanly at final completion
  - enforces a configurable max-variant limit per question.

## Reliability features

- Run ownership is tab-bound (prevents stale runs from jumping to unrelated PrairieLearn tabs).
- Phase-driven automation state machine with timeout handling.
- Observer throttling/debouncing to reduce runaway loops and browser slowdown.
- Receiver bootstrapping in background messaging to recover when scripts are not attached yet.
- Inline status badge (provider, phase, variant count, health).
- Immediate button label rendering to avoid first-paint empty-button flash.
- PrairieLearn-safe wrong-answer memory:
  - when PrairieLearn marks an attempt wrong, next prompt can include that previous selected answer was incorrect (without claiming the correct answer).

## Provider notes

- Gemini (best-supported):
  - plain-text-safe composer insertion for code prompts (`<`, `>`, etc.) to avoid truncation.
- ChatGPT:
  - logged-in and best-effort logged-out support.
  - logged-out mode uses extra readiness checks and focus-hold handling for reliability.
- DeepSeek:
  - JSON-oriented response capture path.

## Settings (popup)

- `aiModel`: `chatgpt | gemini | deepseek`
- `submissionMode`: `fillOnly | autoGrade`
- `maxVariantsPerQuestion`: number (default `6`)
- `autoAdvanceQuestions`: boolean
- `carryWrongAnswerFeedbackToNextPrompt`: boolean
- `responseTimeoutSeconds`: number
- `focusAITabWhileSending`: boolean
- `fallbackProvider`: optional provider
- `stopOnProviderError`: boolean
- `showInlineStatusBadge`: boolean
- `debugMode`: boolean
- `promptStrategy`: `strict_json | answer_explain | retry_feedback`

## Install (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `auto-prairielearn` folder.
5. Open PrairieLearn and at least one provider tab (ChatGPT, Gemini, or DeepSeek).

## Known limits

- Does not yet support:
  - free-response/numeric/text entry questions
  - multipart/compound question formats outside the current `only-answer` layout.
- Provider site DOM changes can require maintenance updates.

## Disclaimer

This project is provided for educational and research purposes. You are responsible for complying with your course, institution, and platform policies, including academic integrity requirements. Use this software at your own risk.

## Attribution

- This project includes code adapted from **Auto-McGraw**:
  - Source: <https://github.com/GooglyBlox/auto-mcgraw>
  - Original license: MIT
  - Original copyright: Copyright (c) 2025 GooglyBlox
- PrairieLearn extraction shape was initially adapted from the workspace `bookmarklet.js` flow.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).

Portions derived from Auto-McGraw remain under the MIT License and retain the original copyright notice.

For third-party license notices, see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

