const RE_QUESTION_KEY = /^(\d+)_(\d+)(?:_(\d+))?(?:__st_(\d+))?$/;
const MAX_SHUFFLE_REROLLS = 5;

function isUnsafeKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function cloneAnswerValue(val) {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(cloneAnswerValue);
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (isUnsafeKey(k)) continue;
    out[k] = cloneAnswerValue(v);
  }
  return out;
}

function cloneQuestionWithOrigIdx(q, origIdx) {
  if (!q || typeof q !== 'object') return q;
  if (q.type === 'group' && Array.isArray(q.questions)) {
    return {
      ...q,
      questions: q.questions.slice(),
      _origQIdx: origIdx
    };
  }
  return {
    ...q,
    _origQIdx: origIdx
  };
}

function resolveOrigIdx(q, fallbackIdx, maxLen) {
  const raw = q?._origQIdx;
  if (Number.isInteger(raw) && raw >= 0 && (maxLen === undefined || raw < maxLen)) {
    return raw;
  }
  return fallbackIdx;
}

function isValidPermutation(perm, len) {
  if (!Array.isArray(perm) || perm.length !== len) return false;
  const seen = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const idx = perm[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= len || seen[idx]) {
      return false;
    }
    seen[idx] = 1;
  }
  return true;
}

function isIdentityPermutation(perm) {
  for (let i = 0; i < perm.length; i++) {
    if (perm[i] !== i) return false;
  }
  return true;
}

function buildFisherYatesPermutation(len, rand) {
  const perm = Array.from({ length: len }, (_, i) => i);
  for (let i = len - 1; i > 0; i--) {
    const raw = Number(rand());
    const r = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON) : Math.random();
    const j = Math.min(i, Math.floor(r * (i + 1)));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  return perm;
}

function buildDistinctShuffledPermutation(len, rand) {
  if (len <= 0) return [];
  if (len === 1) return [0];

  let perm = buildFisherYatesPermutation(len, rand);
  for (let attempt = 0; attempt < MAX_SHUFFLE_REROLLS && isIdentityPermutation(perm); attempt++) {
    perm = buildFisherYatesPermutation(len, rand);
  }
  if (isIdentityPermutation(perm)) {
    const tmp = perm[0];
    perm[0] = perm[1];
    perm[1] = tmp;
  }
  return perm;
}

function remapKeyBySectionMap(key, oldToNewBySection) {
  const m = RE_QUESTION_KEY.exec(key);
  if (!m) return key;
  const sIdx = Number(m[1]);
  const oldQIdx = Number(m[2]);
  const subIdx = m[3];
  const stIdx = m[4];
  const secMap = oldToNewBySection[sIdx];
  if (!secMap || !secMap.has(oldQIdx)) return key;
  const newQIdx = secMap.get(oldQIdx);
  let out = `${sIdx}_${newQIdx}`;
  if (subIdx !== undefined) out += `_${subIdx}`;
  if (stIdx !== undefined) out += `__st_${stIdx}`;
  return out;
}

/**
 * Shallow-clone an exam and tag every top-level question in every section
 * with its canonical `_origQIdx: qIdx` without mutating the input exam.
 * Sub-questions inside `type: 'group'` remain in their original internal order.
 */
export function tagCanonicalIndices(exam) {
  if (!exam || typeof exam !== 'object') return exam;
  const sections = Array.isArray(exam.sections) ? exam.sections : [];
  return {
    ...exam,
    sections: sections.map((sec) => {
      if (!sec || typeof sec !== 'object') return sec;
      const qs = Array.isArray(sec.questions) ? sec.questions : [];
      return {
        ...sec,
        questions: qs.map((q, qIdx) => cloneQuestionWithOrigIdx(q, qIdx))
      };
    })
  };
}

/**
 * Shuffle top-level questions within each section independently using Fisher-Yates,
 * guaranteeing a different order whenever a section has >= 2 questions, and remap
 * both `userAnswers` and `turboChecked` keys from old to new positions.
 */
export function shuffleExamState({ exam, userAnswers = {}, turboChecked = {}, rng = Math.random } = {}) {
  const safeAnswers = userAnswers && typeof userAnswers === 'object' && !Array.isArray(userAnswers)
    ? userAnswers
    : {};
  const safeTurbo = turboChecked && typeof turboChecked === 'object' && !Array.isArray(turboChecked)
    ? turboChecked
    : {};
  const rand = typeof rng === 'function' ? rng : Math.random;

  if (!exam || typeof exam !== 'object' || !Array.isArray(exam.sections)) {
    return {
      exam,
      userAnswers: cloneAnswerValue(safeAnswers),
      turboChecked: cloneAnswerValue(safeTurbo),
      shuffled: false
    };
  }

  let shuffled = false;
  const oldToNewBySection = [];

  const nextSections = exam.sections.map((sec) => {
    if (!sec || typeof sec !== 'object') {
      oldToNewBySection.push(new Map());
      return sec;
    }
    const qs = Array.isArray(sec.questions) ? sec.questions : [];
    const taggedQs = qs.map((q, qIdx) => cloneQuestionWithOrigIdx(q, resolveOrigIdx(q, qIdx, qs.length)));

    const oldToNew = new Map();
    if (taggedQs.length < 2) {
      for (let i = 0; i < taggedQs.length; i++) {
        oldToNew.set(i, i);
      }
      oldToNewBySection.push(oldToNew);
      return {
        ...sec,
        questions: taggedQs
      };
    }

    const perm = buildDistinctShuffledPermutation(taggedQs.length, rand);
    if (!isIdentityPermutation(perm)) {
      shuffled = true;
    }
    const reorderedQs = perm.map((oldQIdx, newQIdx) => {
      oldToNew.set(oldQIdx, newQIdx);
      return taggedQs[oldQIdx];
    });
    oldToNewBySection.push(oldToNew);

    return {
      ...sec,
      questions: reorderedQs
    };
  });

  const remappedAnswers = {};
  for (const [key, val] of Object.entries(safeAnswers)) {
    if (isUnsafeKey(key)) continue;
    const newKey = remapKeyBySectionMap(key, oldToNewBySection);
    remappedAnswers[newKey] = cloneAnswerValue(val);
  }

  const remappedTurboChecked = {};
  for (const [key, val] of Object.entries(safeTurbo)) {
    if (isUnsafeKey(key)) continue;
    const newKey = remapKeyBySectionMap(key, oldToNewBySection);
    remappedTurboChecked[newKey] = cloneAnswerValue(val);
  }

  return {
    exam: {
      ...exam,
      sections: nextSections
    },
    userAnswers: remappedAnswers,
    turboChecked: remappedTurboChecked,
    shuffled
  };
}

/**
 * Remap answer keys from the current (possibly shuffled) exam back to
 * original canonical `_origQIdx` positions so history review & export align
 * 100% with the original unshuffled YAML.
 */
export function remapAnswersToCanonical(exam, userAnswers = {}) {
  const safeAnswers = userAnswers && typeof userAnswers === 'object' && !Array.isArray(userAnswers)
    ? userAnswers
    : {};
  const sections = Array.isArray(exam?.sections) ? exam.sections : [];

  const curToCanonBySection = sections.map((sec) => {
    const map = new Map();
    const qs = Array.isArray(sec?.questions) ? sec.questions : [];
    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      map.set(qIdx, resolveOrigIdx(qs[qIdx], qIdx, qs.length));
    }
    return map;
  });

  const remapped = {};
  for (const [key, val] of Object.entries(safeAnswers)) {
    if (isUnsafeKey(key)) continue;
    const newKey = remapKeyBySectionMap(key, curToCanonBySection);
    remapped[newKey] = cloneAnswerValue(val);
  }
  return remapped;
}

/**
 * Return `number[][]` of `_origQIdx` values per section, or `null` if all
 * sections are already in canonical order `[0, 1, ..., n-1]`.
 */
export function getShuffleOrder(exam) {
  if (!exam || typeof exam !== 'object' || !Array.isArray(exam.sections) || exam.sections.length === 0) {
    return null;
  }

  let hasNonCanonical = false;
  const orderBySection = exam.sections.map((sec) => {
    const qs = Array.isArray(sec?.questions) ? sec.questions : [];
    return qs.map((q, qIdx) => {
      const origIdx = resolveOrigIdx(q, qIdx, qs.length);
      if (origIdx !== qIdx) {
        hasNonCanonical = true;
      }
      return origIdx;
    });
  });

  return hasNonCanonical ? orderBySection : null;
}

/**
 * Given a freshly parsed canonical exam and a saved `orderBySection`,
 * validate each section's permutation of `0..len-1` (falling back safely to
 * canonical order if mismatched/invalid) and return the reordered exam tagged
 * with `_origQIdx`.
 */
export function applyShuffleOrder(exam, orderBySection) {
  if (!exam || typeof exam !== 'object') return exam;
  const canonical = tagCanonicalIndices(exam);
  const sections = canonical.sections;

  if (!Array.isArray(orderBySection) || orderBySection.length !== sections.length) {
    return canonical;
  }

  return {
    ...canonical,
    sections: sections.map((sec, sIdx) => {
      if (!sec || typeof sec !== 'object') return sec;
      const qs = Array.isArray(sec.questions) ? sec.questions : [];
      const perm = orderBySection[sIdx];
      if (!isValidPermutation(perm, qs.length)) {
        return sec;
      }
      return {
        ...sec,
        questions: perm.map((origIdx) => qs[origIdx])
      };
    })
  };
}
