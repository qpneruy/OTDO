/**
 * Precomputed 2-way YAML <-> Question line-range index for OTDO.
 *
 * Exports:
 *  - createYamlLineIndex(yamlStr) -> { entries, byKey, totalLines }
 *  - applyIncrementalChanges(index, changes) -> { shifted, structuralRisk }
 *  - lookupLineByQuestion(index, sIdx, qIdx, subIdx = null) -> Entry | null
 *  - lookupQuestionByLine(index, lineNumber) -> Entry | null
 */

const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?$/;
const LIST_ITEM_RE = /^-(?:\s|$)/;
const LIST_BLOCK_SCALAR_RE = /^-\s+([|>](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?)$/;
const MAPPING_KEY_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:(?:\s|$)/;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
const STRUCTURAL_RISK_RE = /(?:^|\s)-(?:\s|$)|\b(?:questions|sections)\s*:/;

/**
 * Extract the leading mapping key name from a trimmed non-list line, or null.
 */
function extractMappingKey(trimmed) {
  const m = MAPPING_KEY_RE.exec(trimmed);
  return m ? m[1] : null;
}

/**
 * If a trimmed list-item line has an inline mapping key (e.g. "- questions:"),
 * return { key, keyIndent }, otherwise null.
 */
function extractInlineListKey(trimmed, lineIndent) {
  if (!LIST_ITEM_RE.test(trimmed) || trimmed.length <= 1) return null;
  const rest = trimmed.slice(1);
  const offset = rest.search(/\S/);
  if (offset === -1) return null;
  const inner = rest.slice(offset);
  const key = extractMappingKey(inner);
  if (!key) return null;
  return { key, keyIndent: lineIndent + 1 + offset };
}

/**
 * Detect whether a line opens a YAML block scalar (`|`, `|-`, `|+`, `>`, `>-`, `>+`,
 * with optional indent indicator and trailing `# comment`).
 * Returns the reference indent (> which subsequent non-empty lines belong to the scalar),
 * or -1 if the line does not open a block scalar.
 */
function detectBlockScalarIndent(raw, leadingIndent) {
  const trimmed = raw.slice(leadingIndent);

  // Bare sequence item opening a block scalar, e.g. "  - |-"
  if (LIST_BLOCK_SCALAR_RE.test(trimmed)) {
    return leadingIndent;
  }

  // Mapping key (either standalone "key: |-" or inline on a list item "- key: |-")
  let keyIndent = leadingIndent;
  let scanStart = leadingIndent;
  if (LIST_ITEM_RE.test(trimmed) && trimmed.length > 1) {
    const afterDash = trimmed.slice(1).search(/\S/);
    if (afterDash !== -1) {
      keyIndent = leadingIndent + 1 + afterDash;
      scanStart = keyIndent;
    }
  }

  let inSingle = false;
  let inDouble = false;
  for (let i = scanStart; i < raw.length; i++) {
    const ch = raw[i];
    if (!inSingle && !inDouble) {
      if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
        break;
      }
      if (ch === ':' && (i + 1 === raw.length || /\s/.test(raw[i + 1]))) {
        const afterColon = raw.slice(i + 1).trim();
        if (BLOCK_SCALAR_HEADER_RE.test(afterColon)) {
          return keyIndent;
        }
      }
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
    } else if (inSingle) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
    } else if (inDouble) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
    }
  }

  return -1;
}

/**
 * Build a 2-way line-range index for an OTDO exam YAML document.
 *
 * @param {string} yamlStr
 * @returns {{ entries: Array<{ key: string, sIdx: number, qIdx: number, subIdx: number | null, startLine: number, endLine: number }>, byKey: Map<string, object>, totalLines: number }}
 */
export function createYamlLineIndex(yamlStr) {
  const text = String(yamlStr ?? '');
  if (text.length === 0) {
    return { entries: [], byKey: new Map(), totalLines: 0 };
  }

  const lines = text.split(LINE_SPLIT_RE);
  const totalLines = lines.length;
  const entries = [];
  const byKey = new Map();

  let blockIndent = -1;

  let inSections = false;
  let secIndent = -1;
  let sIdx = -1;

  let inSectionQuestions = false;
  let qKeyIndent = -1;
  let qIndent = -1;
  let qIdx = -1;

  let inSubQuestions = false;
  let subKeyIndent = -1;
  let subIndent = -1;
  let subIdx = -1;

  const resetSubQuestions = () => {
    inSubQuestions = false;
    subKeyIndent = -1;
    subIndent = -1;
    subIdx = -1;
  };

  const resetSectionQuestions = () => {
    inSectionQuestions = false;
    qKeyIndent = -1;
    qIndent = -1;
    qIdx = -1;
    resetSubQuestions();
  };

  const resetSections = () => {
    inSections = false;
    secIndent = -1;
    sIdx = -1;
    resetSectionQuestions();
  };

  const pushEntry = (secI, qI, subI, startLine) => {
    const key = subI != null ? `${secI}_${qI}_${subI}` : `${secI}_${qI}`;
    const entry = {
      key,
      sIdx: secI,
      qIdx: qI,
      subIdx: subI,
      startLine,
      endLine: startLine
    };
    entries.push(entry);
    byKey.set(key, entry);
  };

  for (let i = 0; i < totalLines; i++) {
    const raw = lines[i];

    // 1. Block-scalar skipping: ignore all empty lines and lines indented deeper than blockIndent
    if (blockIndent !== -1) {
      const nonWs = raw.search(/\S/);
      if (nonWs === -1 || nonWs > blockIndent) {
        continue;
      }
      blockIndent = -1;
    }

    const indent = raw.search(/\S/);
    if (indent === -1) continue; // blank line

    const trimmed = raw.slice(indent);
    if (trimmed[0] === '#') continue; // comment line

    const isList = LIST_ITEM_RE.test(trimmed);
    const key = isList ? null : extractMappingKey(trimmed);

    // 2. Structural state machine
    if (!inSections) {
      if (indent === 0 && key === 'sections') {
        inSections = true;
        secIndent = -1;
        sIdx = -1;
        resetSectionQuestions();
      }
    } else if (indent === 0 && !isList) {
      // Another root-level key after sections:
      if (key === 'sections') {
        secIndent = -1;
        sIdx = -1;
        resetSectionQuestions();
      } else {
        resetSections();
      }
    } else {
      // Exit nested scopes when dedented back to or above their parent key
      if (inSubQuestions && (indent < subKeyIndent || (indent === subKeyIndent && !isList))) {
        resetSubQuestions();
      }
      if (inSectionQuestions && (indent < qKeyIndent || (indent === qKeyIndent && !isList))) {
        resetSectionQuestions();
      }

      // Section list item
      if (secIndent === -1 && isList) {
        secIndent = indent;
        sIdx = 0;
        resetSectionQuestions();
        const inlineKey = extractInlineListKey(trimmed, indent);
        if (inlineKey && inlineKey.key === 'questions') {
          inSectionQuestions = true;
          qKeyIndent = inlineKey.keyIndent;
        }
      } else if (secIndent !== -1 && indent === secIndent && isList) {
        sIdx++;
        resetSectionQuestions();
        const inlineKey = extractInlineListKey(trimmed, indent);
        if (inlineKey && inlineKey.key === 'questions') {
          inSectionQuestions = true;
          qKeyIndent = inlineKey.keyIndent;
        }
      } else if (sIdx >= 0) {
        if (!inSectionQuestions) {
          if (indent > secIndent && key === 'questions') {
            inSectionQuestions = true;
            qKeyIndent = indent;
            qIndent = -1;
            qIdx = -1;
          }
        } else {
          // Top-level question list item
          if (qIndent === -1 && isList && indent >= qKeyIndent) {
            qIndent = indent;
            qIdx = 0;
            resetSubQuestions();
            pushEntry(sIdx, qIdx, null, i + 1);
            const inlineKey = extractInlineListKey(trimmed, indent);
            if (inlineKey && inlineKey.key === 'questions') {
              inSubQuestions = true;
              subKeyIndent = inlineKey.keyIndent;
            }
          } else if (qIndent !== -1 && indent === qIndent && isList) {
            qIdx++;
            resetSubQuestions();
            pushEntry(sIdx, qIdx, null, i + 1);
            const inlineKey = extractInlineListKey(trimmed, indent);
            if (inlineKey && inlineKey.key === 'questions') {
              inSubQuestions = true;
              subKeyIndent = inlineKey.keyIndent;
            }
          } else if (qIdx >= 0) {
            if (!inSubQuestions) {
              if (indent > qIndent && key === 'questions') {
                inSubQuestions = true;
                subKeyIndent = indent;
                subIndent = -1;
                subIdx = -1;
              }
            } else {
              // Sub-question list item inside a group
              if (subIndent === -1 && isList && indent >= subKeyIndent) {
                subIndent = indent;
                subIdx = 0;
                pushEntry(sIdx, qIdx, subIdx, i + 1);
              } else if (subIndent !== -1 && indent === subIndent && isList) {
                subIdx++;
                pushEntry(sIdx, qIdx, subIdx, i + 1);
              }
              // Deeper "- " items (e.g. statements:, accepted_answers:, array options:) are ignored.
            }
          }
        }
      }
    }

    // 3. Check if this line opens a block scalar for subsequent lines
    const nextBlockIndent = detectBlockScalarIndent(raw, indent);
    if (nextBlockIndent !== -1) {
      blockIndent = nextBlockIndent;
    }
  }

  // 4. Compute exact contiguous endLine for every entry
  for (let k = 0; k < entries.length; k++) {
    entries[k].endLine = k + 1 < entries.length ? entries[k + 1].startLine - 1 : totalLines;
  }

  return { entries, byKey, totalLines };
}

/**
 * Incrementally shift line ranges in-place from Monaco `onDidChangeModelContent` changes.
 *
 * @param {{ entries: Array<object>, byKey: Map<string, object>, totalLines: number }} index
 * @param {Array<{ range: { startLineNumber: number, endLineNumber: number }, text: string }>} changes
 * @returns {{ shifted: boolean, structuralRisk: boolean }}
 */
export function applyIncrementalChanges(index, changes) {
  if (!index || !Array.isArray(index.entries) || !Array.isArray(changes) || changes.length === 0) {
    return { shifted: false, structuralRisk: false };
  }

  // Fast pass: inspect deltas and structural risk
  let anyDelta = false;
  let structuralRisk = false;

  const parsed = new Array(changes.length);
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const startLineNumber = ch?.range?.startLineNumber ?? 1;
    const endLineNumber = ch?.range?.endLineNumber ?? startLineNumber;
    const text = String(ch?.text ?? '');

    if (!structuralRisk && STRUCTURAL_RISK_RE.test(text)) {
      structuralRisk = true;
    }

    const oldLines = endLineNumber - startLineNumber + 1;
    const newLines = text.split(LINE_SPLIT_RE).length;
    const delta = newLines - oldLines;
    if (delta !== 0) {
      anyDelta = true;
    }

    parsed[i] = { startLineNumber, endLineNumber, delta };
  }

  // O(1) no-op when no line counts changed
  if (!anyDelta) {
    return { shifted: false, structuralRisk };
  }

  // Sort bottom-to-top so earlier edits at higher line numbers never invalidate lower line numbers
  if (parsed.length > 1) {
    parsed.sort((a, b) => (
      b.startLineNumber - a.startLineNumber || b.endLineNumber - a.endLineNumber
    ));
  }

  const entries = index.entries;
  let shifted = false;

  for (let c = 0; c < parsed.length; c++) {
    const { startLineNumber, endLineNumber, delta } = parsed[c];
    if (delta === 0) continue;

    shifted = true;
    index.totalLines = Math.max(0, (index.totalLines || 0) + delta);

    if (entries.length === 0) continue;

    // Binary search for the first entry with endLine >= startLineNumber
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].endLine < startLineNumber) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    for (let k = lo; k < entries.length; k++) {
      const entry = entries[k];
      if (entry.startLine > endLineNumber) {
        entry.startLine += delta;
        entry.endLine += delta;
      } else {
        // Edit overlaps [entry.startLine, entry.endLine]
        if (startLineNumber <= entry.startLine) {
          structuralRisk = true;
        }
        if (entry.startLine <= endLineNumber && endLineNumber <= entry.endLine) {
          entry.endLine = Math.max(entry.startLine, entry.endLine + delta);
        } else if (delta < 0) {
          // Multi-line deletion spanning past this entry's endLine
          structuralRisk = true;
        }
      }
    }
  }

  return { shifted, structuralRisk };
}

/**
 * O(1) Left -> Right lookup: get line-range entry for (sIdx, qIdx, subIdx).
 * If `subIdx != null` and not found, falls back to `${sIdx}_${qIdx}`.
 *
 * @param {{ byKey: Map<string, object> }} index
 * @param {number} sIdx
 * @param {number} qIdx
 * @param {number | null} [subIdx=null]
 * @returns {object | null}
 */
export function lookupLineByQuestion(index, sIdx, qIdx, subIdx = null) {
  if (!index || !(index.byKey instanceof Map) || sIdx == null || qIdx == null) {
    return null;
  }
  if (subIdx != null) {
    const subEntry = index.byKey.get(`${sIdx}_${qIdx}_${subIdx}`);
    if (subEntry) return subEntry;
  }
  return index.byKey.get(`${sIdx}_${qIdx}`) ?? null;
}

/**
 * O(log N) Right -> Left lookup: find the question entry covering `lineNumber` (1-based).
 *
 * @param {{ entries: Array<object> }} index
 * @param {number} lineNumber
 * @returns {object | null}
 */
export function lookupQuestionByLine(index, lineNumber) {
  if (!index || !Array.isArray(index.entries) || index.entries.length === 0) {
    return null;
  }
  const line = Number(lineNumber);
  if (!Number.isFinite(line)) return null;

  const entries = index.entries;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid];
    if (line < entry.startLine) {
      hi = mid - 1;
    } else if (line > entry.endLine) {
      lo = mid + 1;
    } else {
      return entry;
    }
  }
  return null;
}
