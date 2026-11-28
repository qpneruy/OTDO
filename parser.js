import { z } from 'zod';
import jsyaml from 'js-yaml';

const RE_NON_SPACE = /\S/;
const RE_WHITESPACE = /\s/;
const RE_BLOCK_SCALAR = /^[|>][+-]?(?:\s+#.*)?$/;
const RE_LATEX_N = /^(?:eq|e(?![a-zA-Z])|abla|otin|u(?![a-zA-Z])|eg(?![a-zA-Z]))/;
const RE_LATEX_T = /^(?:imes|heta|an|ext|o(?![a-zA-Z])|frac|riangle|au(?![a-zA-Z])|op(?![a-zA-Z]))/;
const RE_LEADING_TAB = /^ *\t/;
const RE_CRLF = /\r\n?/g;
const RE_MULTI_SPACE = /\s+/g;

function sanitizeLatexEscapes(yamlText) {
  if (!yamlText.includes('\\') || !yamlText.includes('"')) {
    return yamlText;
  }

  const lines = yamlText.split('\n');
  let blockIndent = -1;
  let modified = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    if (blockIndent !== -1) {
      if (raw.trim() === '') continue;
      if (raw.search(RE_NON_SPACE) > blockIndent) continue;
      blockIndent = -1;
    }

    if (!raw.includes('\\') && !raw.includes('|') && !raw.includes('>')) {
      continue;
    }

    let out = '', inSingle = false, inDouble = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (!inSingle && !inDouble) {
        if (ch === '#' && (i === 0 || RE_WHITESPACE.test(raw[i - 1]))) {
          out += raw.slice(i);
          break;
        }
        if (ch === ':' && (i + 1 === raw.length || RE_WHITESPACE.test(raw[i + 1]))) {
          if (RE_BLOCK_SCALAR.test(raw.slice(i + 1).trim())) {
            const ind = raw.search(RE_NON_SPACE);
            blockIndent = ind === -1 ? 0 : ind;
          }
        }
        if (ch === "'") inSingle = true;
        else if (ch === '"') inDouble = true;
        out += ch;
      } else if (inSingle) {
        if (ch === "'") {
          if (raw[i + 1] === "'") { out += "''"; i++; continue; }
          inSingle = false;
        }
        out += ch;
      } else if (ch === '"') {
        inDouble = false;
        out += ch;
      } else if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === '\\' || next === '"') {
          out += '\\' + next;
        } else if (next === 'n') {
          const isLatexN = RE_LATEX_N.test(raw.slice(i + 2));
          out += isLatexN ? '\\\\n' : '\\n';
        } else if (next === 't') {
          const isLatexT = RE_LATEX_T.test(raw.slice(i + 2));
          out += isLatexT ? '\\\\t' : '\\t';
        } else {
          out += '\\\\' + next;
        }
        i++;
      } else {
        out += ch;
      }
    }
    if (out !== raw) {
      lines[lineIdx] = out;
      modified = true;
    }
  }
  return modified ? lines.join('\n') : yamlText;
}

export function parseYaml(text) {
  const rawStr = String(text ?? '');
  const normalized = rawStr.includes('\r') ? rawStr.replace(RE_CRLF, '\n') : rawStr;
  if (normalized.includes('\t')) {
    const lines = normalized.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      if (RE_LEADING_TAB.test(lines[idx])) {
        throw new Error(`Dòng ${idx + 1}: Không dùng ký tự Tab để thụt lề trong YAML, hãy dùng dấu cách (space).`);
      }
    }
  }
  if (!normalized.trim()) return null;

  try {
    return jsyaml.load(sanitizeLatexEscapes(normalized));
  } catch (err) {
    const line = err?.mark && typeof err.mark.line === 'number' ? err.mark.line + 1 : 1;
    const reason = err?.reason || err?.message || 'Cú pháp YAML không hợp lệ';
    if (/duplicated mapping key/i.test(reason)) {
      throw new Error(`Dòng ${line}: Trường bị lặp lại (${reason}).`);
    }
    throw new Error(`Dòng ${line}: Thụt lề / cú pháp YAML không hợp lệ (${reason}).`);
  }
}

const textField = (label) => z.preprocess(
  (v) => (v === undefined || v === null || typeof v === 'object' ? v : String(v).trim()),
  z.string({
    required_error: `Thiếu ${label}.`,
    invalid_type_error: `${label} phải là văn bản.`
  }).min(1, `${label} không được để trống.`)
);

const explanationField = z.preprocess(
  (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? v : String(v).trim()),
  z.string({ invalid_type_error: 'explanation phải là văn bản.' })
).optional().default('');

const OPTION_KEYS = ['A', 'B', 'C', 'D'];

const pointsField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return v;
  },
  z.number({
    invalid_type_error: 'points phải là số dương (0 < points <= 100).'
  })
    .gt(0, 'points phải lớn hơn 0.')
    .max(100, 'points không được vượt quá 100.')
    .optional()
);

const optionalQuestionField = z.preprocess(
  (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? v : String(v).trim()),
  z.string({ invalid_type_error: 'question phải là văn bản.' })
).optional().default('');

const optionalTitleField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed === '' ? undefined : trimmed;
    }
    return v;
  },
  z.string({ invalid_type_error: 'title phải là văn bản.' }).optional()
);

function stripUndefinedOptionalFields(obj) {
  if (obj.points === undefined) {
    delete obj.points;
  }
  if (obj.title === undefined) {
    delete obj.title;
  }
  return obj;
}

const OptionsObjectSchema = z.object({
  A: textField('options.A'),
  B: textField('options.B'),
  C: textField('options.C'),
  D: textField('options.D')
}, {
  required_error: 'Thiếu object "options" (A, B, C, D).',
  invalid_type_error: 'options phải là object chứa A, B, C, D.'
}).strict();

const MultipleChoiceSchema = z.object({
  type: z.literal('multiple_choice'),
  question: textField('question'),
  options: OptionsObjectSchema,
  answer: z.string({
    required_error: 'Thiếu answer.',
    invalid_type_error: 'answer phải là A, B, C hoặc D.'
  }).transform((s) => s.trim().toUpperCase())
    .refine((s) => OPTION_KEYS.includes(s), 'answer phải là A, B, C hoặc D.'),
  points: pointsField,
  explanation: explanationField
}).strict();

const TrueFalseSchema = z.object({
  type: z.literal('true_false'),
  question: textField('question'),
  statements: z.array(
    z.object({
      text: textField('text'),
      is_true: z.boolean({
        required_error: 'Thiếu is_true.',
        invalid_type_error: 'is_true phải là true hoặc false (không bọc ngoặc kép).'
      })
    }).strict(),
    {
      required_error: 'Thiếu statements.',
      invalid_type_error: 'statements phải là danh sách từ 1 đến 8 ý.'
    }
  ).min(1, 'statements phải có từ 1 đến 8 ý.')
    .max(8, 'statements chỉ tối đa 8 ý.'),
  points: pointsField,
  explanation: explanationField
}).strict();

const ShortAnswerSchema = z.object({
  type: z.literal('short_answer'),
  question: textField('question'),
  accepted_answers: z.array(
    textField('đáp án'),
    {
      required_error: 'Thiếu accepted_answers.',
      invalid_type_error: 'accepted_answers phải có ít nhất 1 đáp án hợp lệ.'
    }
  ).min(1, 'accepted_answers phải có ít nhất 1 đáp án hợp lệ.'),
  points: pointsField,
  explanation: explanationField
}).strict();

const SubMultipleChoiceSchema = MultipleChoiceSchema.extend({
  question: optionalQuestionField
}).strict();

const SubTrueFalseSchema = TrueFalseSchema.extend({
  question: optionalQuestionField
}).strict();

const SubShortAnswerSchema = ShortAnswerSchema.extend({
  question: optionalQuestionField
}).strict();

const SubQuestionSchema = z.preprocess(
  (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.type === undefined || v.type === null || v.type === '')) {
      return { ...v, type: 'multiple_choice' };
    }
    return v;
  },
  z.discriminatedUnion('type', [SubMultipleChoiceSchema, SubTrueFalseSchema, SubShortAnswerSchema])
    .transform(stripUndefinedOptionalFields)
);

const GroupSchema = z.object({
  type: z.literal('group'),
  title: optionalTitleField,
  content: textField('content'),
  points: pointsField,
  questions: z.array(
    SubQuestionSchema,
    {
      required_error: 'Thiếu questions trong nhóm câu hỏi.',
      invalid_type_error: 'questions trong nhóm phải là danh sách từ 1 đến 50 câu hỏi con.'
    }
  ).min(1, 'Nhóm câu hỏi phải có ít nhất 1 câu hỏi con.')
    .max(50, 'Nhóm câu hỏi chỉ tối đa 50 câu hỏi con.')
}).strict();

const folderField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed === '' ? undefined : trimmed;
    }
    return v;
  },
  z.string({ invalid_type_error: 'folder phải là văn bản.' }).optional()
);

const timeLimitField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return v;
  },
  z.number({
    invalid_type_error: 'time_limit phải là số nguyên dương (đơn vị phút, từ 1 đến 600).'
  })
    .int('time_limit phải là số nguyên (không dùng số thập phân).')
    .min(1, 'time_limit phải từ 1 đến 600 phút.')
    .max(600, 'time_limit không được vượt quá 600 phút.')
    .optional()
);

const ExamSchema = z.object({
  meta: z.object({
    title: textField('meta.title'),
    folder: folderField,
    time_limit: timeLimitField
  }, {
    required_error: 'Thiếu khối "meta".',
    invalid_type_error: 'Khối "meta" không hợp lệ.'
  }).strict().transform((m) => {
    const out = { title: m.title };
    if (m.folder) out.folder = m.folder;
    if (m.time_limit !== undefined) out.time_limit = m.time_limit;
    return out;
  }),
  sections: z.array(
    z.object({
      title: textField('title'),
      points: pointsField,
      questions: z.array(
        z.discriminatedUnion('type', [MultipleChoiceSchema, TrueFalseSchema, ShortAnswerSchema, GroupSchema])
          .transform(stripUndefinedOptionalFields),
        {
          required_error: 'Thiếu questions.',
          invalid_type_error: 'questions phải là danh sách có ít nhất 1 câu hỏi.'
        }
      ).min(1, 'questions phải có ít nhất 1 câu hỏi.')
    }).strict().transform(stripUndefinedOptionalFields),
    {
      required_error: 'Thiếu "sections".',
      invalid_type_error: 'Danh sách sections không hợp lệ.'
    }
  ).min(1, 'Danh sách sections đang rỗng.')
}).strict();

function formatZodPath(path) {
  if (!path || path.length === 0) return 'Gốc YAML';
  const parts = [];
  let seenQuestion = false;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (seg === 'sections' && typeof path[i + 1] === 'number') {
      parts.push(`Phần ${path[++i] + 1}`);
    } else if (seg === 'questions' && typeof path[i + 1] === 'number') {
      parts.push(`${seenQuestion ? 'Câu con' : 'Câu'} ${path[++i] + 1}`);
      seenQuestion = true;
    } else if (seg === 'statements' && typeof path[i + 1] === 'number') {
      parts.push(`ý ${String.fromCharCode(97 + path[++i])}`);
    } else if (typeof seg === 'number') {
      if (parts.length > 0) parts[parts.length - 1] += `[${seg}]`;
    } else {
      parts.push(String(seg));
    }
  }
  return parts.reduce((acc, p, idx) => (
    idx === 0 ? p : /^(?:Phần|Câu con|Câu|ý) /.test(p) ? `${acc}, ${p}` : `${acc}.${p}`
  ), '');
}

export function parseExamYaml(yamlText) {
  if (!String(yamlText ?? '').trim()) {
    return { ok: false, errors: ['Nội dung YAML đang trống.'] };
  }

  let raw;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, errors: [err.message || 'Lỗi cú pháp YAML.'] };
  }

  const result = ExamSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const loc = formatZodPath(issue.path);
    if (issue.code === 'unrecognized_keys') {
      return `${loc}: Trường không hợp lệ ${issue.keys.map((k) => `"${k}"`).join(', ')}.`;
    }
    if (issue.code === 'invalid_union_discriminator') {
      const allowsGroup = Array.isArray(issue.options) && issue.options.includes('group');
      return allowsGroup
        ? `${loc}: "type" phải là multiple_choice, true_false, short_answer hoặc group.`
        : `${loc}: "type" phải là multiple_choice, true_false hoặc short_answer.`;
    }
    return `${loc}: ${issue.message}`;
  });
  return { ok: false, errors };
}

function normalizeShortAnswer(str) {
  return String(str ?? '').trim().replace(RE_MULTI_SPACE, ' ').toLowerCase();
}

function isValidPositivePoints(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100;
}

function roundPoints(v) {
  return Math.round(v * 1e10) / 1e10;
}

/**
 * Resolve effective max points per question and per section, auto-dividing unassigned points.
 */
export function resolveExamPoints(exam) {
  const sections = Array.isArray(exam?.sections) ? exam.sections : [];
  let totalQuestions = 0;
  let hasCustomPoints = false;

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    if (isValidPositivePoints(sec?.points)) hasCustomPoints = true;
    const qs = sec?.questions;
    if (!qs) continue;
    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      const q = qs[qIdx];
      if (q?.type === 'group') {
        if (isValidPositivePoints(q?.points)) hasCustomPoints = true;
        const subQs = q.questions;
        if (!subQs) continue;
        for (let subIdx = 0; subIdx < subQs.length; subIdx++) {
          totalQuestions++;
          if (isValidPositivePoints(subQs[subIdx]?.points)) hasCustomPoints = true;
        }
      } else {
        totalQuestions++;
        if (isValidPositivePoints(q?.points)) hasCustomPoints = true;
      }
    }
  }

  const questionMaxPoints = {};
  const sectionMaxPoints = [];

  if (totalQuestions === 0) {
    return { hasCustomPoints: false, totalMaxPoints: 0, sectionMaxPoints: [], questionMaxPoints: {} };
  }

  if (!hasCustomPoints) {
    const each = roundPoints(10 / totalQuestions);
    for (let sIdx = 0; sIdx < sections.length; sIdx++) {
      const qs = sections[sIdx]?.questions || [];
      let secCount = 0;
      for (let qIdx = 0; qIdx < qs.length; qIdx++) {
        const q = qs[qIdx];
        if (q?.type === 'group') {
          const subQs = q.questions || [];
          for (let subIdx = 0; subIdx < subQs.length; subIdx++) {
            questionMaxPoints[`${sIdx}_${qIdx}_${subIdx}`] = each;
            secCount++;
          }
        } else {
          questionMaxPoints[`${sIdx}_${qIdx}`] = each;
          secCount++;
        }
      }
      sectionMaxPoints[sIdx] = Number((secCount * each).toFixed(4));
    }
    return {
      hasCustomPoints: false,
      totalMaxPoints: 10,
      sectionMaxPoints,
      questionMaxPoints
    };
  }

  const globallyUnassignedIds = [];
  let assignedTotal = 0;

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    const qs = sec?.questions || [];
    const secHasPoints = isValidPositivePoints(sec?.points);
    let fixedInSec = 0;
    const unfixedIdsInSec = [];

    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      const q = qs[qIdx];
      if (q?.type === 'group') {
        const subQs = Array.isArray(q.questions) ? q.questions : [];
        const groupHasPoints = isValidPositivePoints(q?.points);
        let fixedInGroup = 0;
        const unfixedIdsInGroup = [];

        for (let subIdx = 0; subIdx < subQs.length; subIdx++) {
          const subQ = subQs[subIdx];
          const subId = `${sIdx}_${qIdx}_${subIdx}`;
          if (isValidPositivePoints(subQ?.points)) {
            questionMaxPoints[subId] = subQ.points;
            fixedInGroup += subQ.points;
          } else {
            unfixedIdsInGroup.push(subId);
          }
        }

        if (groupHasPoints) {
          if (unfixedIdsInGroup.length > 0) {
            const remGroup = Math.max(0, roundPoints(q.points - fixedInGroup));
            const eachSub = roundPoints(remGroup / unfixedIdsInGroup.length);
            for (let k = 0; k < unfixedIdsInGroup.length; k++) {
              questionMaxPoints[unfixedIdsInGroup[k]] = eachSub;
            }
            fixedInSec += fixedInGroup + remGroup;
          } else {
            fixedInSec += fixedInGroup;
          }
        } else {
          fixedInSec += fixedInGroup;
          for (let k = 0; k < unfixedIdsInGroup.length; k++) {
            unfixedIdsInSec.push(unfixedIdsInGroup[k]);
          }
        }
      } else {
        const id = `${sIdx}_${qIdx}`;
        if (isValidPositivePoints(q?.points)) {
          questionMaxPoints[id] = q.points;
          fixedInSec += q.points;
        } else {
          unfixedIdsInSec.push(id);
        }
      }
    }

    if (secHasPoints) {
      if (unfixedIdsInSec.length > 0) {
        const rem = Math.max(0, roundPoints(sec.points - fixedInSec));
        const each = roundPoints(rem / unfixedIdsInSec.length);
        for (let k = 0; k < unfixedIdsInSec.length; k++) {
          questionMaxPoints[unfixedIdsInSec[k]] = each;
        }
        assignedTotal += fixedInSec + rem;
      } else {
        assignedTotal += fixedInSec;
      }
    } else {
      assignedTotal += fixedInSec;
      for (let k = 0; k < unfixedIdsInSec.length; k++) {
        globallyUnassignedIds.push(unfixedIdsInSec[k]);
      }
    }
  }

  if (globallyUnassignedIds.length > 0) {
    const remGlobal = Math.max(0, roundPoints(10 - assignedTotal));
    const fallbackEach = roundPoints(
      remGlobal > 0 ? (remGlobal / globallyUnassignedIds.length) : (10 / totalQuestions)
    );
    for (let k = 0; k < globallyUnassignedIds.length; k++) {
      questionMaxPoints[globallyUnassignedIds[k]] = fallbackEach;
    }
  }

  let totalMaxPoints = 0;
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const qs = sections[sIdx]?.questions || [];
    let secSum = 0;
    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      const q = qs[qIdx];
      if (q?.type === 'group') {
        const subQs = q.questions || [];
        for (let subIdx = 0; subIdx < subQs.length; subIdx++) {
          secSum += questionMaxPoints[`${sIdx}_${qIdx}_${subIdx}`] || 0;
        }
      } else {
        secSum += questionMaxPoints[`${sIdx}_${qIdx}`] || 0;
      }
    }
    sectionMaxPoints[sIdx] = Number(secSum.toFixed(4));
    totalMaxPoints += secSum;
  }

  return {
    hasCustomPoints: true,
    totalMaxPoints: Number(totalMaxPoints.toFixed(4)),
    sectionMaxPoints,
    questionMaxPoints
  };
}

export function gradeSingleQuestion(q, userAns, rawMaxPoints = 1) {
  const maxPoints = Number((Number(rawMaxPoints) || 0).toFixed(4));

  if (q.type === 'multiple_choice') {
    const picked = typeof userAns === 'string' ? userAns : null;
    const isUnanswered = !picked;
    const isCorrect = picked === q.answer;
    const score = isCorrect ? 1 : 0;
    const earnedPoints = Number((score * maxPoints).toFixed(4));
    return {
      isUnanswered,
      detail: { type: q.type, score, maxPoints, earnedPoints, isFullCorrect: isCorrect, userAns: picked }
    };
  }

  if (q.type === 'true_false') {
    const pickedMap = userAns && typeof userAns === 'object' && !Array.isArray(userAns) ? userAns : {};
    let correctCount = 0;
    let hasUnanswered = false;
    const statementResults = q.statements.map((st, stIdx) => {
      const picked = pickedMap[stIdx];
      if (typeof picked !== 'boolean') hasUnanswered = true;
      const isCorrect = picked === st.is_true;
      if (isCorrect) correctCount++;
      return { picked: typeof picked === 'boolean' ? picked : null, expected: st.is_true, isCorrect };
    });

    const score = q.statements.length === 4
      ? [0, 0.1, 0.25, 0.5, 1.0][correctCount]
      : correctCount / q.statements.length;
    const earnedPoints = Number((score * maxPoints).toFixed(4));
    const isFullCorrect = correctCount === q.statements.length;
    return {
      isUnanswered: hasUnanswered,
      detail: { type: q.type, score, maxPoints, earnedPoints, isFullCorrect, correctCount, statementResults }
    };
  }

  if (q.type === 'short_answer') {
    const rawInput = typeof userAns === 'string' ? userAns : '';
    const normInput = normalizeShortAnswer(rawInput);
    const isUnanswered = !normInput;
    const isCorrect = normInput !== '' && q.accepted_answers.some((a) => normalizeShortAnswer(a) === normInput);
    const score = isCorrect ? 1 : 0;
    const earnedPoints = Number((score * maxPoints).toFixed(4));
    return {
      isUnanswered,
      detail: { type: q.type, score, maxPoints, earnedPoints, isFullCorrect: isCorrect, userAns: rawInput }
    };
  }

  return { isUnanswered: true, detail: null };
}

export function gradeExam(exam, userAnswers = {}) {
  const pts = resolveExamPoints(exam);
  const details = {};
  let totalQuestions = 0;
  let rawPoints = 0;
  let sumEarnedPoints = 0;
  let fullCorrectCount = 0;
  let unansweredCount = 0;

  const gradeLeafQuestion = (q, id) => {
    totalQuestions++;
    const { isUnanswered, detail } = gradeSingleQuestion(q, userAnswers[id], pts.questionMaxPoints[id] ?? 0);
    if (isUnanswered) unansweredCount++;
    if (detail) {
      rawPoints += detail.score;
      sumEarnedPoints += detail.score * detail.maxPoints;
      if (detail.isFullCorrect) fullCorrectCount++;
      details[id] = detail;
    }
  };

  exam.sections.forEach((sec, sIdx) => {
    sec.questions.forEach((q, qIdx) => {
      if (q.type === 'group') {
        (q.questions || []).forEach((subQ, subIdx) => {
          gradeLeafQuestion(subQ, `${sIdx}_${qIdx}_${subIdx}`);
        });
      } else {
        gradeLeafQuestion(q, `${sIdx}_${qIdx}`);
      }
    });
  });

  const totalMaxPoints = Number((pts.totalMaxPoints || 10).toFixed(2));
  const earnedPoints = Number(sumEarnedPoints.toFixed(2));
  const scale10 = pts.totalMaxPoints > 0
    ? Number(((sumEarnedPoints / pts.totalMaxPoints) * 10).toFixed(2))
    : 0;

  return {
    totalQuestions,
    rawPoints: Number(rawPoints.toFixed(2)),
    earnedPoints,
    totalMaxPoints,
    hasCustomPoints: pts.hasCustomPoints,
    scale10,
    fullCorrectCount,
    unansweredCount,
    details
  };
}

function serializeLeafQuestion(q, { inGroup = false } = {}) {
  const qType = q?.type || 'multiple_choice';
  const base = {};
  if (!inGroup) {
    base.type = qType;
    base.question = String(q.question ?? '');
  } else {
    if (qType !== 'multiple_choice') {
      base.type = qType;
    }
    const qText = String(q.question ?? '').trim();
    if (qText) {
      base.question = String(q.question);
    }
  }

  if (qType === 'multiple_choice') {
    base.options = {
      A: String(q.options?.A ?? ''),
      B: String(q.options?.B ?? ''),
      C: String(q.options?.C ?? ''),
      D: String(q.options?.D ?? '')
    };
    base.answer = String(q.answer ?? 'A');
  } else if (qType === 'true_false') {
    base.statements = (q.statements || []).map((st) => ({
      text: String(st.text ?? ''),
      is_true: st.is_true === true
    }));
  } else if (qType === 'short_answer') {
    base.accepted_answers = (q.accepted_answers || []).map((a) => String(a ?? ''));
  }

  if (isValidPositivePoints(q?.points)) {
    base.points = Number(q.points.toFixed(4));
  }
  if (q.explanation) base.explanation = String(q.explanation);
  return base;
}

export function serializeExamYaml(exam) {
  const folder = String(exam?.meta?.folder ?? '').trim();
  const rawTimeLimit = exam?.meta?.time_limit;
  const meta = { title: String(exam?.meta?.title ?? '') };
  if (folder) meta.folder = folder;
  if (typeof rawTimeLimit === 'number' && Number.isInteger(rawTimeLimit) && rawTimeLimit >= 1 && rawTimeLimit <= 600) {
    meta.time_limit = rawTimeLimit;
  }

  const cleanPayload = {
    meta,
    sections: (exam?.sections || []).map((sec) => {
      const secObj = { title: String(sec.title ?? '') };
      if (isValidPositivePoints(sec?.points)) {
        secObj.points = Number(sec.points.toFixed(4));
      }
      secObj.questions = (sec.questions || []).map((q) => {
        if (q?.type === 'group') {
          const grp = { type: 'group' };
          const grpTitle = String(q.title ?? '').trim();
          if (grpTitle) grp.title = grpTitle;
          grp.content = String(q.content ?? '');
          if (isValidPositivePoints(q?.points)) {
            grp.points = Number(q.points.toFixed(4));
          }
          grp.questions = (q.questions || []).map((subQ) => serializeLeafQuestion(subQ, { inGroup: true }));
          return grp;
        }
        return serializeLeafQuestion(q, { inGroup: false });
      });
      return secObj;
    })
  };

  return jsyaml.dump(cleanPayload, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false
  });
}

export function countExamStats(examData) {
  let mc = 0, tf = 0, sa = 0, groups = 0;
  const sections = examData?.sections || [];
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const qs = sections[sIdx]?.questions;
    if (!qs) continue;
    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      const q = qs[qIdx];
      if (q?.type === 'group') {
        groups++;
        const subQs = q.questions;
        if (!subQs) continue;
        for (let subIdx = 0; subIdx < subQs.length; subIdx++) {
          const t = subQs[subIdx]?.type;
          if (t === 'multiple_choice') mc++;
          else if (t === 'true_false') tf++;
          else if (t === 'short_answer') sa++;
        }
      } else {
        const t = q?.type;
        if (t === 'multiple_choice') mc++;
        else if (t === 'true_false') tf++;
        else if (t === 'short_answer') sa++;
      }
    }
  }
  return {
    sections: sections.length,
    total: mc + tf + sa,
    mc,
    tf,
    sa,
    groups
  };
}

export function isQuestionAnswered(q, ans) {
  if (!q) return false;
  if (q.type === 'multiple_choice') return typeof ans === 'string' && ans.trim() !== '';
  if (q.type === 'true_false') {
    return Boolean(
      ans &&
      Array.isArray(q.statements) &&
      q.statements.length > 0 &&
      q.statements.every((_, i) => typeof ans[i] === 'boolean')
    );
  }
  if (q.type === 'short_answer') return String(ans ?? '').trim() !== '';
  if (q.type === 'group') {
    return Boolean(
      ans &&
      typeof ans === 'object' &&
      Array.isArray(q.questions) &&
      q.questions.length > 0 &&
      q.questions.every((subQ, i) => isQuestionAnswered(subQ, ans[i]))
    );
  }
  return false;
}
