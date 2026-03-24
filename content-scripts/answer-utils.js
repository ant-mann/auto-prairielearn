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

  const exported = {
    normalizeChoiceText,
    stripOptionPrefix,
    extractOptionIndex,
    extractOptionIndexLoose,
    isAnswerMatch,
    stripWrappingQuotes,
    resolveOptionByToken,
    parseMultipleAnswerTokens,
  };

  globalScope.PLAAnswerUtils = exported;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
