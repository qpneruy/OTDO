import { gradeExam, gradeSingleQuestion, resolveExamPoints } from './parser.js';
import { formatDuration } from './timer.js';

const MC_OPTION_KEYS = ['A', 'B', 'C', 'D'];
const MAX_SLUG_LENGTH = 80;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatPointNum(n) {
  const val = Number(n);
  if (!Number.isFinite(val)) return '0';
  return String(Number(val.toFixed(2)));
}

function normalizeSingleLine(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBlockText(value) {
  const raw = String(value ?? '').replace(/\r\n?/g, '\n');
  const stripped = raw.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  if (!stripped.includes('\n')) return stripped.trim();
  return stripped.trimEnd();
}

function parseDateInput(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const d = /^\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatDateTimeVi(dateObj) {
  return `${pad2(dateObj.getDate())}/${pad2(dateObj.getMonth() + 1)}/${dateObj.getFullYear()} ${pad2(dateObj.getHours())}:${pad2(dateObj.getMinutes())}:${pad2(dateObj.getSeconds())}`;
}

function formatFilenameTimestamp(dateObj) {
  return `${dateObj.getFullYear()}${pad2(dateObj.getMonth() + 1)}${pad2(dateObj.getDate())}-${pad2(dateObj.getHours())}${pad2(dateObj.getMinutes())}`;
}

function toSafeFilenameSlug(title) {
  const ascii = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!ascii) return 'de-on-tap';
  if (ascii.length <= MAX_SLUG_LENGTH) return ascii;
  return ascii.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') || 'de-on-tap';
}

function indentContinuationLines(text, indent = '  ') {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `${indent}${line}`))
    .join('\n');
}

function formatListItem(prefix, body, suffix = '') {
  const text = normalizeBlockText(body);
  if (!text) {
    return suffix ? `${prefix}${suffix.trimStart()}` : prefix.trimEnd();
  }
  if (!text.includes('\n')) {
    return `${prefix}${text}${suffix}`;
  }
  const head = suffix ? `${prefix}${suffix.replace(/^\s*—\s*/, '')}` : prefix.trimEnd();
  return `${head}\n${indentContinuationLines(text, '  ')}`;
}

function formatQuestionResult(detail) {
  const earned = formatPointNum(detail?.earnedPoints ?? 0);
  const max = formatPointNum(detail?.maxPoints ?? 0);
  if (detail?.isFullCorrect) return `Đúng (+${earned}/${max}đ)`;
  if ((detail?.score ?? 0) > 0) return `Đúng một phần (+${earned}/${max}đ)`;
  return `Sai (0/${max}đ)`;
}

function formatExplanationBlock(explanation) {
  const text = normalizeBlockText(explanation);
  if (!text) return '';
  if (!text.includes('\n')) {
    return `**Giải thích:** ${text}`;
  }
  return `**Giải thích:**\n\n${text}`;
}

function formatLeafQuestionMarkdown({ q, num, headingLevel, userAns, detail }) {
  const blocks = [];
  const qType = q?.type || 'multiple_choice';
  const maxPts = formatPointNum(detail?.maxPoints ?? 0);
  const hashes = '#'.repeat(headingLevel);

  blocks.push(`${hashes} Câu ${num} (${maxPts}đ)`);

  const stem = normalizeBlockText(q?.question);
  if (stem) {
    blocks.push(stem);
  }

  if (qType === 'multiple_choice') {
    const rawPicked = typeof detail?.userAns === 'string'
      ? detail.userAns
      : (typeof userAns === 'string' && userAns.trim() ? userAns.trim().toUpperCase() : null);
    const picked = rawPicked ? rawPicked.trim().toUpperCase() : null;
    const correctKey = String(q?.answer ?? '').trim().toUpperCase();
    const options = q?.options && typeof q.options === 'object' ? q.options : {};

    const optionLines = MC_OPTION_KEYS.map((key) => {
      const isChosen = picked === key;
      const isCorrectOpt = correctKey === key;
      const box = isChosen ? '[x]' : '[ ]';
      let tag = '';
      if (isChosen && isCorrectOpt) {
        tag = ' — *(Bạn chọn · Đáp án đúng)*';
      } else if (isChosen) {
        tag = ' — *(Bạn chọn)*';
      } else if (isCorrectOpt) {
        tag = ' — *(Đáp án đúng)*';
      }
      return formatListItem(`- ${box} **${key}.** `, options[key] ?? '', tag);
    });
    blocks.push(optionLines.join('\n'));

    blocks.push(
      [
        `**Bạn chọn:** ${picked || 'Chưa trả lời'}  `,
        `**Đáp án đúng:** ${correctKey || '—'}  `,
        `**Kết quả:** ${formatQuestionResult(detail)}`
      ].join('\n')
    );
  } else if (qType === 'true_false') {
    const statements = Array.isArray(q?.statements) ? q.statements : [];
    const pickedMap = userAns && typeof userAns === 'object' && !Array.isArray(userAns) ? userAns : {};
    const stResults = Array.isArray(detail?.statementResults) ? detail.statementResults : [];

    let correctCount = typeof detail?.correctCount === 'number' ? detail.correctCount : 0;
    if (typeof detail?.correctCount !== 'number') {
      correctCount = 0;
    }

    const statementLines = statements.map((st, stIdx) => {
      const letter = String.fromCharCode(97 + stIdx);
      const res = stResults[stIdx];
      const pickedVal = res ? res.picked : (typeof pickedMap[stIdx] === 'boolean' ? pickedMap[stIdx] : null);
      const expectedVal = res ? res.expected : Boolean(st?.is_true);
      const isCorrect = res ? Boolean(res.isCorrect) : (pickedVal === expectedVal);
      if (typeof detail?.correctCount !== 'number' && isCorrect) {
        correctCount++;
      }

      const pickedLabel = pickedVal === true ? 'Đúng' : pickedVal === false ? 'Sai' : 'Chưa chọn';
      const expectedLabel = expectedVal ? 'Đúng' : 'Sai';
      const statusLabel = isCorrect ? '✓ Đúng' : '✗ Sai';

      const stHead = formatListItem(`- **${letter})** `, st?.text ?? '');
      const stMeta = `  - Bạn chọn: **${pickedLabel}** | Đáp án: **${expectedLabel}** | ${statusLabel}`;
      return `${stHead}\n${stMeta}`;
    });

    if (statementLines.length > 0) {
      blocks.push(statementLines.join('\n'));
    }

    const earned = formatPointNum(detail?.earnedPoints ?? 0);
    const max = formatPointNum(detail?.maxPoints ?? 0);
    const tfOutcome = detail?.isFullCorrect
      ? `Đúng — ${correctCount}/${statements.length} ý (+${earned}/${max}đ)`
      : (detail?.score ?? 0) > 0
        ? `Đúng một phần — ${correctCount}/${statements.length} ý (+${earned}/${max}đ)`
        : `Sai — ${correctCount}/${statements.length} ý (0/${max}đ)`;
    blocks.push(`**Kết quả:** ${tfOutcome}`);
  } else if (qType === 'short_answer') {
    const rawInput = typeof detail?.userAns === 'string'
      ? detail.userAns
      : (typeof userAns === 'string' ? userAns : '');
    const cleanedAns = normalizeBlockText(rawInput);
    const accepted = Array.isArray(q?.accepted_answers)
      ? q.accepted_answers.map((a) => String(a ?? '').trim()).filter(Boolean)
      : [];

    const userAnsLine = !cleanedAns
      ? '**Bạn trả lời:** Chưa trả lời  '
      : cleanedAns.includes('\n')
        ? `**Bạn trả lời:**\n\n${cleanedAns}\n`
        : `**Bạn trả lời:** ${cleanedAns}  `;

    blocks.push(
      [
        userAnsLine,
        `**Đáp án chấp nhận:** ${accepted.length > 0 ? accepted.join(' | ') : '—'}  `,
        `**Kết quả:** ${formatQuestionResult(detail)}`
      ].join('\n')
    );
  }

  const expBlock = formatExplanationBlock(q?.explanation);
  if (expBlock) {
    blocks.push(expBlock);
  }

  return blocks.join('\n\n');
}

/**
 * Build a safe ASCII filename for an exported exam attempt.
 * Example: "de-kiem-tra-toan-bai-lam-20261127-1745.md"
 */
export function buildExportFilename(examTitle, submittedAt) {
  const slug = toSafeFilenameSlug(examTitle);
  const dt = parseDateInput(submittedAt) || new Date();
  return `${slug}-bai-lam-${formatFilenameTimestamp(dt)}.md`;
}

/**
 * Build clean Vietnamese Markdown representing a completed or reviewed exam attempt.
 */
export function buildAttemptExportMarkdown({
  exam,
  userAnswers,
  gradeResult,
  elapsedSeconds,
  limitMinutes,
  submittedAt,
  autoSubmitted
} = {}) {
  const safeAnswers = userAnswers && typeof userAnswers === 'object' && !Array.isArray(userAnswers)
    ? userAnswers
    : {};
  const sections = Array.isArray(exam?.sections) ? exam.sections : [];
  const safeExam = {
    meta: exam?.meta && typeof exam.meta === 'object' ? exam.meta : {},
    sections
  };

  const hasValidGrade = Boolean(
    gradeResult &&
    typeof gradeResult === 'object' &&
    gradeResult.details &&
    typeof gradeResult.details === 'object'
  );
  const grade = hasValidGrade ? gradeResult : gradeExam(safeExam, safeAnswers);
  const resolvedPoints = resolveExamPoints(safeExam);

  const blocks = [];
  const title = normalizeSingleLine(safeExam.meta?.title) || 'Đề ôn tập';
  blocks.push(`# ${title}`);

  const metaLines = [];
  const folder = normalizeSingleLine(safeExam.meta?.folder);
  if (folder) {
    metaLines.push(`- **Môn / Thư mục:** ${folder}`);
  }

  const submittedDate = parseDateInput(submittedAt);
  if (submittedDate) {
    metaLines.push(`- **Thời điểm nộp:** ${formatDateTimeVi(submittedDate)}`);
  }

  const hasElapsed = elapsedSeconds !== undefined && elapsedSeconds !== null && elapsedSeconds !== '' && Number.isFinite(Number(elapsedSeconds));
  const parsedLimit = Number(limitMinutes);
  const hasLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
  if (hasElapsed) {
    const durationText = formatDuration(elapsedSeconds);
    metaLines.push(
      hasLimit
        ? `- **Thời gian làm bài:** ${durationText} (giới hạn ${Math.floor(parsedLimit)} phút)`
        : `- **Thời gian làm bài:** ${durationText}`
    );
  } else if (hasLimit) {
    metaLines.push(`- **Giới hạn thời gian:** ${Math.floor(parsedLimit)} phút`);
  }

  const scale10Str = formatPointNum(grade.scale10 ?? 0);
  const earnedStr = formatPointNum(grade.earnedPoints ?? 0);
  const maxStr = formatPointNum(grade.totalMaxPoints ?? resolvedPoints.totalMaxPoints ?? 0);
  metaLines.push(`- **Điểm số:** **${scale10Str} / 10** (${earnedStr} / ${maxStr} điểm)`);

  const fullCorrect = Number.isFinite(Number(grade.fullCorrectCount)) ? Number(grade.fullCorrectCount) : 0;
  const totalQuestions = Number.isFinite(Number(grade.totalQuestions)) ? Number(grade.totalQuestions) : 0;
  const unanswered = Number.isFinite(Number(grade.unansweredCount)) ? Number(grade.unansweredCount) : 0;
  metaLines.push(
    unanswered > 0
      ? `- **Số câu đúng trọn vẹn:** ${fullCorrect} / ${totalQuestions} (chưa trả lời: ${unanswered})`
      : `- **Số câu đúng trọn vẹn:** ${fullCorrect} / ${totalQuestions}`
  );

  if (autoSubmitted === true) {
    metaLines.push('- **Ghi chú:** Tự động nộp bài khi hết giờ');
  }

  blocks.push(metaLines.join('\n'));
  blocks.push('---');

  const getLeafDetail = (q, id) => {
    if (grade.details && grade.details[id]) return grade.details[id];
    const maxPts = resolvedPoints.questionMaxPoints[id] ?? 0;
    return gradeSingleQuestion(q, safeAnswers[id], maxPts).detail;
  };

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    const secTitle = normalizeSingleLine(sec?.title) || `Phần ${sIdx + 1}`;
    blocks.push(`## ${secTitle}`);

    const qs = Array.isArray(sec?.questions) ? sec.questions : [];
    let num = 1;

    for (let qIdx = 0; qIdx < qs.length; qIdx++) {
      const q = qs[qIdx];
      if (!q || typeof q !== 'object') continue;

      if (q.type === 'group') {
        const subQs = Array.isArray(q.questions) ? q.questions : [];
        const startNum = num;
        const endNum = subQs.length > 0 ? startNum + subQs.length - 1 : startNum;
        const rangeLabel = endNum > startNum ? `Câu ${startNum}–${endNum}` : `Câu ${startNum}`;

        let groupMaxPts = 0;
        const subDetails = subQs.map((subQ, subIdx) => {
          const subId = `${sIdx}_${qIdx}_${subIdx}`;
          const subDetail = getLeafDetail(subQ, subId);
          groupMaxPts += Number(subDetail?.maxPoints ?? resolvedPoints.questionMaxPoints[subId] ?? 0);
          return { subQ, subId, subDetail };
        });

        const groupTitle = normalizeSingleLine(q.title);
        const groupPtsLabel = formatPointNum(groupMaxPts);
        blocks.push(
          groupTitle
            ? `### ${rangeLabel}: ${groupTitle} (${groupPtsLabel}đ)`
            : `### ${rangeLabel} (${groupPtsLabel}đ)`
        );

        const passage = normalizeBlockText(q.content);
        if (passage) {
          blocks.push(passage);
        }

        for (let subIdx = 0; subIdx < subDetails.length; subIdx++) {
          const { subQ, subId, subDetail } = subDetails[subIdx];
          const subNum = num++;
          blocks.push(
            formatLeafQuestionMarkdown({
              q: subQ,
              num: subNum,
              headingLevel: 4,
              userAns: safeAnswers[subId],
              detail: subDetail
            })
          );
        }
      } else {
        const id = `${sIdx}_${qIdx}`;
        const qNum = num++;
        const detail = getLeafDetail(q, id);
        blocks.push(
          formatLeafQuestionMarkdown({
            q,
            num: qNum,
            headingLevel: 3,
            userAns: safeAnswers[id],
            detail
          })
        );
      }
    }
  }

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Generate Markdown export for an attempt and trigger a browser file download.
 */
export function downloadAttemptExport(params = {}) {
  const safeParams = params && typeof params === 'object' ? params : {};
  const submittedAt = safeParams.submittedAt ?? Date.now();
  const content = buildAttemptExportMarkdown({ ...safeParams, submittedAt });
  const filename = buildExportFilename(safeParams.exam?.meta?.title, submittedAt);

  if (
    typeof document !== 'undefined' &&
    document.body &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      if (a.parentNode) {
        a.parentNode.removeChild(a);
      }
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    }
  }

  return { filename, content };
}
