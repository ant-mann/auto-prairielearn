(function (globalScope) {
  function normalizeChoiceText(text) {
    if (typeof text !== "string") return "";

    return text
      .replace(/\u00a0/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "");
  }

  function stripOptionPrefix(text) {
    if (typeof text !== "string") return "";

    return text
      .trim()
      .replace(/^([A-Z]|\d+)[.):\-]\s*/i, "")
      .trim();
  }

  function extractOptionIndex(text) {
    if (typeof text !== "string") return null;

    const trimmed = text.trim();
    const numericMatch = trimmed.match(/^(\d+)[.):\-]\s*/);
    if (numericMatch) {
      const index = Number.parseInt(numericMatch[1], 10) - 1;
      return Number.isNaN(index) ? null : index;
    }

    const letterMatch = trimmed.match(/^([A-Z])[.):\-]\s*/i);
    if (letterMatch) {
      return letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    }

    return null;
  }

  function extractOptionIndexLoose(text) {
    if (typeof text !== "string") return null;

    const trimmed = text.trim();
    if (!trimmed) return null;

    const strictIndex = extractOptionIndex(trimmed);
    if (strictIndex !== null) {
      return strictIndex;
    }

    if (/^\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed, 10) - 1;
      return Number.isNaN(index) ? null : index;
    }

    if (/^[A-Z]$/i.test(trimmed)) {
      return trimmed.toUpperCase().charCodeAt(0) - 65;
    }

    const optionMatch = trimmed.match(/^option\s+([A-Z]|\d+)$/i);
    if (optionMatch) {
      const token = optionMatch[1];
      if (/^\d+$/.test(token)) {
        const optionIndex = Number.parseInt(token, 10) - 1;
        return Number.isNaN(optionIndex) ? null : optionIndex;
      }
      return token.toUpperCase().charCodeAt(0) - 65;
    }

    return null;
  }

  function isAnswerMatch(choiceText, answerText) {
    if (!choiceText || answerText === null || answerText === undefined) {
      return false;
    }

    const choice = String(choiceText).trim();
    const answer = String(answerText).trim();
    if (!choice || !answer) return false;

    if (choice === answer) return true;

    const choiceWithoutPeriod = choice.replace(/\.$/, "");
    const answerWithoutPeriod = answer.replace(/\.$/, "");
    if (choiceWithoutPeriod === answerWithoutPeriod) return true;

    if (choice === answer + ".") return true;

    const normalizedChoice = normalizeChoiceText(choice);
    const normalizedAnswer = normalizeChoiceText(answer);
    if (normalizedChoice === normalizedAnswer) return true;

    const strippedChoice = normalizeChoiceText(stripOptionPrefix(choice));
    const strippedAnswer = normalizeChoiceText(stripOptionPrefix(answer));

    return strippedChoice === strippedAnswer;
  }

  function stripWrappingQuotes(text) {
    if (typeof text !== "string") return "";
    return text.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  }

  function resolveOptionByToken(options, token, { allowLooseIndex = false } = {}) {
    if (!Array.isArray(options) || !options.length) return null;
    if (token === null || token === undefined) return null;

    const rawToken = stripWrappingQuotes(String(token));
    if (!rawToken) return null;

    const index = allowLooseIndex
      ? extractOptionIndexLoose(rawToken)
      : extractOptionIndex(rawToken);
    if (index !== null && index >= 0 && index < options.length) {
      return options[index];
    }

    for (const option of options) {
      if (isAnswerMatch(option.text, rawToken)) {
        return option;
      }
    }

    const normalizedToken = normalizeChoiceText(rawToken);
    for (const option of options) {
      if (normalizeChoiceText(option.value || "") === normalizedToken) {
        return option;
      }
    }

    return null;
  }

  function parseMultipleAnswerTokens(answer, options) {
    if (Array.isArray(answer)) {
      const tokens = answer
        .map((item) => stripWrappingQuotes(String(item ?? "")))
        .filter(Boolean);

      return tokens.length
        ? { tokens }
        : { tokens: [], error: "AI response did not include any selections." };
    }

    if (answer === null || answer === undefined) {
      return { tokens: [], error: "AI response did not include an answer." };
    }

    const rawAnswer = stripWrappingQuotes(String(answer));
    if (!rawAnswer) {
      return { tokens: [], error: "AI response returned an empty answer." };
    }

    if (rawAnswer.startsWith("[") && rawAnswer.endsWith("]")) {
      try {
        const parsed = JSON.parse(rawAnswer);
        return parseMultipleAnswerTokens(parsed, options);
      } catch (error) {}
    }

    if (
      Array.isArray(options) &&
      options.some((option) => isAnswerMatch(option.text, rawAnswer))
    ) {
      return { tokens: [rawAnswer] };
    }

    const lineTokens = rawAnswer
      .split(/\r?\n/)
      .map((item) => stripWrappingQuotes(item))
      .filter(Boolean);
    if (lineTokens.length > 1) {
      return { tokens: lineTokens };
    }

    const commaTokens = rawAnswer
      .split(/\s*(?:,|;|\|)\s*/)
      .map((item) => stripWrappingQuotes(item))
      .filter(Boolean);
    if (commaTokens.length > 1) {
      return { tokens: commaTokens };
    }

    const andTokens = rawAnswer
      .split(/\s+(?:and|&)\s+/i)
      .map((item) => stripWrappingQuotes(item))
      .filter(Boolean);
    if (andTokens.length > 1) {
      return { tokens: andTokens };
    }

    return { tokens: [rawAnswer] };
  }

  function buildPromptText(questionData, profile = "default") {
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

    const strategyCopy = {
      default: {
        strictSingle:
          '\n\nCRITICAL: Return only valid JSON with one exact option string in "answer".',
        strictMulti:
          '\n\nCRITICAL: Return only valid JSON. The "answer" value must be an array of exact option strings copied from the list.',
        retrySingle:
          '\n\nDouble-check the answer and return one exact option string in valid JSON.',
        retryMulti:
          '\n\nDouble-check every selected option and return all correct selections as an exact string array in valid JSON.',
        explainFallback: "",
      },
      chatgpt: {
        strictSingle:
          '\n\nCRITICAL: Return only compact JSON. Do not wrap the JSON in markdown. The "answer" value must be a single option string copied exactly from the list.',
        strictMulti:
          '\n\nCRITICAL: Return only compact JSON. Do not wrap JSON in markdown. The "answer" value must be an array of exact option strings from the list.',
        retrySingle:
          '\n\nBe extra careful. If your previous answer was wrong or malformed, correct that behavior now. Return one exact option string in valid JSON.',
        retryMulti:
          '\n\nBe extra careful. If your previous answer was wrong or malformed, correct that behavior now. Return all correct options as an exact string array in valid JSON.',
        explainFallback:
          '\n\nChoose the best answer, then explain it briefly in one sentence.',
      },
      deepseek: {
        strictSingle:
          '\n\nCRITICAL: Return only valid JSON with one exact option string in "answer".',
        strictMulti:
          '\n\nCRITICAL: Return only valid JSON. The "answer" value must be an array of exact option strings copied from the list.',
        retrySingle: '\n\nDouble-check the option text and return clean JSON only.',
        retryMulti:
          '\n\nDouble-check every selected option and return all correct selections as an exact string array in clean JSON.',
        explainFallback: "",
      },
    };

    const copy = strategyCopy[profile] || strategyCopy.default;

    if (promptStrategy === "strict_json") {
      text += type === "multiple_select" ? copy.strictMulti : copy.strictSingle;
    } else if (promptStrategy === "retry_feedback") {
      text += type === "multiple_select" ? copy.retryMulti : copy.retrySingle;
    } else if (copy.explainFallback) {
      text += copy.explainFallback;
    }

    text +=
      '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

    return text;
  }

  const exported = {
    normalizeChoiceText,
    stripOptionPrefix,
    extractOptionIndex,
    extractOptionIndexLoose,
    isAnswerMatch,
    stripWrappingQuotes,
    resolveOptionByToken,
    parseMultipleAnswerTokens,
    buildPromptText,
  };

  globalScope.PLAAnswerUtils = exported;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
