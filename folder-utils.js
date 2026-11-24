/**
 * Pure folder-path and YAML folder helpers (zero-dependency ES module).
 * Extracted from app.js with identical behavior.
 */

export function normalizeFolderPath(raw) {
  return String(raw ?? '')
    .split('/')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join('/');
}

export function getSubjectFromFolder(path) {
  const norm = normalizeFolderPath(path);
  if (!norm) return '';
  const idx = norm.indexOf('/');
  return idx === -1 ? norm : norm.slice(0, idx);
}

export function getParentFolderPath(path) {
  const norm = normalizeFolderPath(path);
  if (!norm) return '';
  const parts = norm.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

export function getFolderLeafName(path) {
  const norm = normalizeFolderPath(path);
  if (!norm) return '';
  const parts = norm.split('/');
  return parts[parts.length - 1] || '';
}

export function collectAncestors(path) {
  const norm = normalizeFolderPath(path);
  if (!norm) return [];
  const parts = norm.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

export function sanitizeFoldersArray(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const norm = normalizeFolderPath(list[i]);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

export function compareFolderPathsVi(a, b) {
  const segA = String(a ?? '').split('/');
  const segB = String(b ?? '').split('/');
  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    if (segA[i] !== segB[i]) {
      return segA[i].localeCompare(segB[i], 'vi');
    }
  }
  return segA.length - segB.length;
}

/**
 * Pure-JS fallback for rewriting `meta.folder` in YAML text when parser/dumper
 * dependencies are not injected.
 */
function rewriteMetaFolderYamlText(rawYaml, cleanFolder) {
  const eol = rawYaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawYaml.split(/\r?\n/);

  let metaIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^meta:\s*(?:#.*)?$/.test(lines[i])) {
      metaIdx = i;
      break;
    }
  }
  if (metaIdx === -1) return null;

  let blockEnd = lines.length;
  let childIndent = '  ';
  let folderLineIdx = -1;
  let titleLineIdx = -1;

  for (let i = metaIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indentMatch = /^([ \t]+)/.exec(line);
    if (!indentMatch) {
      blockEnd = i;
      break;
    }
    const indent = indentMatch[1];
    if (childIndent === '  ' && indent.length > 0) {
      childIndent = indent;
    }
    if (folderLineIdx === -1 && new RegExp(`^${indent}folder\\s*:`).test(line)) {
      folderLineIdx = i;
    } else if (titleLineIdx === -1 && new RegExp(`^${indent}title\\s*:`).test(line)) {
      titleLineIdx = i;
    }
  }

  if (folderLineIdx !== -1) {
    if (cleanFolder) {
      const indent = (/^([ \t]+)/.exec(lines[folderLineIdx]) || ['', childIndent])[1];
      lines[folderLineIdx] = `${indent}folder: ${JSON.stringify(cleanFolder)}`;
    } else {
      lines.splice(folderLineIdx, 1);
    }
    return lines.join(eol);
  }

  if (cleanFolder) {
    const insertAt = titleLineIdx !== -1 ? titleLineIdx + 1 : metaIdx + 1;
    lines.splice(insertAt, 0, `${childIndent}folder: ${JSON.stringify(cleanFolder)}`);
    return lines.join(eol);
  }

  return rawYaml;
}

/**
 * Update an exam entry's `meta.folder` inside `rawYaml` and bump `updatedAt`.
 *
 * When `deps` supplies `{ parseExamYaml, serializeExamYaml, parseYaml, dumpYaml | jsyaml }`,
 * uses the exact schema-validated / js-yaml round-trip path from app.js.
 * Without `deps`, falls back to a zero-dependency line-level `meta.folder` rewrite.
 */
export function updateExamFolderYaml(examItem, newFolderPath, deps = {}) {
  if (!examItem || typeof examItem.rawYaml !== 'string') return examItem;
  const cleanFolder = normalizeFolderPath(newFolderPath);

  const { parseExamYaml, serializeExamYaml, parseYaml, dumpYaml, jsyaml } = deps || {};
  const hasExamCodec = typeof parseExamYaml === 'function' && typeof serializeExamYaml === 'function';
  const dumpFn = typeof dumpYaml === 'function'
    ? dumpYaml
    : (typeof jsyaml?.dump === 'function' ? (doc, opts) => jsyaml.dump(doc, opts) : null);
  const hasRawYamlCodec = typeof parseYaml === 'function' && typeof dumpFn === 'function';

  if (hasExamCodec) {
    const parsed = parseExamYaml(examItem.rawYaml);
    if (parsed.ok) {
      if (cleanFolder) parsed.data.meta.folder = cleanFolder;
      else delete parsed.data.meta.folder;
      return {
        ...examItem,
        rawYaml: serializeExamYaml(parsed.data),
        updatedAt: Date.now()
      };
    }
  }

  if (hasRawYamlCodec) {
    try {
      const doc = parseYaml(examItem.rawYaml);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        if (!doc.meta || typeof doc.meta !== 'object' || Array.isArray(doc.meta)) {
          doc.meta = {};
        }
        if (cleanFolder) doc.meta.folder = cleanFolder;
        else delete doc.meta.folder;
        const dumped = dumpFn(doc, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          quotingType: '"',
          forceQuotes: false
        });
        return {
          ...examItem,
          rawYaml: dumped,
          updatedAt: Date.now()
        };
      }
    } catch {
      // Keep original if unparseable
    }
    return examItem;
  }

  if (!hasExamCodec && !hasRawYamlCodec) {
    const rewritten = rewriteMetaFolderYamlText(examItem.rawYaml, cleanFolder);
    if (rewritten !== null) {
      return {
        ...examItem,
        rawYaml: rewritten,
        updatedAt: Date.now()
      };
    }
  }

  return examItem;
}
