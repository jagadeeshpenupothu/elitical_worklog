const SMART_PUNCTUATION_REPLACEMENTS = Object.freeze({
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": "\"",
  "\u201d": "\"",
  "\u2013": "-",
  "\u2014": "-",
});

export const ELITICAL_DOCKET_DESCRIPTION_REQUIRED_MESSAGE = "Description is required.";
export const ELITICAL_DOCKET_STATE_REQUIRED_MESSAGE = "Docket State is required.";

export function normalizeEliticalDescription(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014]/g, (match) =>
      SMART_PUNCTUATION_REPLACEMENTS[match] || match
    )
    .trim();
}

export function validateEliticalDescription(value) {
  return normalizeEliticalDescription(value)
    ? ""
    : ELITICAL_DOCKET_DESCRIPTION_REQUIRED_MESSAGE;
}

export function normalizeEliticalCreateDescriptionFields(payload = {}) {
  const description = normalizeEliticalDescription(
    payload.description ?? payload.descr
  );

  return {
    ...payload,
    description,
    descr: description,
  };
}
