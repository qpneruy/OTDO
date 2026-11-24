import assert from 'assert';
import {
  STORAGE_KEY,
  PROGRESS_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  MAX_HISTORY_ENTRIES,
  PRESET_FOLDERS,
  TIMER_PRESET_MINUTES,
  SAMPLE_YAML,
  buildAiPrompt
} from './constants.js';
import {
  parseExamYaml,
  serializeExamYaml,
  gradeExam,
  resolveExamPoints,
  countExamStats,
  isQuestionAnswered
} from './parser.js';
import {
  escapeHtml,
  isRichTextReady,
  renderRichText,
  renderRichPreviewHtml,
  getRichTextCacheStats
} from './rich-text.js';
import {
  formatDuration,
  getTimerStatus,
  createQuizTimer
} from './timer.js';
import {
  toLocalDateKey,
  formatCompactDuration,
  formatSubmittedAt,
  computeStreaks,
  computeOverallKpis,
  computeSubjectAverages,
  buildYearHeatmap,
  buildMonthCalendarWeeks,
  buildWeeklyBreakdown,
  filterHistory
} from './analytics.js';

export function runTests() {
const validYaml = `
meta:
  title: "Đề kiểm tra tổng hợp" # inline comment

sections:
  - title: "Phần I. Trắc nghiệm"
    questions:
      - type: multiple_choice
        question: "Cho hàm số y = 2x + 1. Giá trị của y tại x = 3 là:"
        options:
          A: 5
          B: 6
          C: 7
          D: 8
        answer: "c"
        # explanation: "commented out"

      - type: multiple_choice
        question: |
          Cho hàm số f(x) xác định trên
          [0; 2] với tỉ lệ hai nghiệm là 1:2.
          Giá trị lớn nhất của hàm số là:
        options:
          A: "1"
          B: "2"
          C: "3"
          D: "4"
        answer: "B"
        explanation: "Giải thích mẫu"

  - title: "Phần II. Đúng sai"
    questions:
      - type: true_false
        question: |
          Một vật chuyển động với vận tốc v(t) = 2t + 1 (m/s).
          Xét tính đúng sai của các mệnh đề sau:
        statements:
          - text: "Tại t = 0, vận tốc bằng 1 m/s"
            is_true: true
          - text: "Gia tốc của vật là 2 m/s^2"
            is_true: true
          - text: "Quãng đường đi được trong 2 giây đầu là 5 m"
            is_true: false
          - text: "Vận tốc đạt 10 m/s tại t = 4,5 s"
            is_true: true

  - title: "Phần III. Trả lời ngắn"
    questions:
      - question: |
          Biết phương trình "2x - 7,5 = 0" có nghiệm x0.
          Tính giá trị biểu thức: P = 2x0.
        type: short_answer
        accepted_answers:
          - "7,5"
          - "7.5"
          - "1,5"
`;

// 1. Valid parse checks
const parsed = parseExamYaml(validYaml);
assert.strictEqual(parsed.ok, true, `Expected valid YAML, got errors: ${parsed.errors}`);
assert.strictEqual(parsed.data.meta.title, 'Đề kiểm tra tổng hợp');
assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.data.meta, 'folder'), false);
assert.strictEqual(parsed.data.sections.length, 3);
assert.strictEqual(parsed.data.sections[0].questions[0].options.A, '5');
assert.strictEqual(parsed.data.sections[0].questions[0].answer, 'C');
assert.strictEqual(parsed.data.sections[0].questions[1].question, 'Cho hàm số f(x) xác định trên\n[0; 2] với tỉ lệ hai nghiệm là 1:2.\nGiá trị lớn nhất của hàm số là:');
assert.strictEqual(parsed.data.sections[1].questions[0].statements[2].is_true, false);
assert.deepStrictEqual(parsed.data.sections[2].questions[0].accepted_answers, ['7,5', '7.5', '1,5']);

// 2. Invalid YAML syntax & schema checks
const invalidCases = [
  {
    name: 'tab indentation',
    yaml: 'meta:\n\ttitle: "Test"',
    expect: /Tab/
  },
  {
    name: 'bad indentation',
    yaml: 'meta:\n  title: "Test"\n   extra: "oops"',
    expect: /Thụt lề/
  },
  {
    name: 'duplicate key',
    yaml: 'meta:\n  title: "A"\n  title: "B"',
    expect: /lặp lại/
  },
  {
    name: 'missing meta.title',
    yaml: 'meta:\n  title: ""\nsections:\n  - title: "P1"\n    questions:\n      - type: short_answer\n        question: "Q"\n        accepted_answers:\n          - "1"',
    expect: /meta\.title/
  },
  {
    name: 'unknown type',
    yaml: 'meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: essay\n        question: "Q"',
    expect: /type/
  },
  {
    name: 'missing option D',
    yaml: 'meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: multiple_choice\n        question: "Q"\n        options:\n          A: "1"\n          B: "2"\n          C: "3"\n        answer: "A"',
    expect: /options\.D/
  },
  {
    name: 'invalid answer E',
    yaml: 'meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: multiple_choice\n        question: "Q"\n        options:\n          A: "1"\n          B: "2"\n          C: "3"\n          D: "4"\n        answer: "E"',
    expect: /answer/
  },
  {
    name: 'non-boolean is_true',
    yaml: 'meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: true_false\n        question: "Q"\n        statements:\n          - text: "s1"\n            is_true: "yes"',
    expect: /is_true/
  },
  {
    name: 'empty accepted_answers',
    yaml: 'meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: short_answer\n        question: "Q"\n        accepted_answers:',
    expect: /accepted_answers/
  }
];

for (const tc of invalidCases) {
  const res = parseExamYaml(tc.yaml);
  assert.strictEqual(res.ok, false, `Case "${tc.name}" should fail`);
  assert.ok(res.errors.some((e) => tc.expect.test(e)), `Case "${tc.name}" error mismatch: ${res.errors.join('; ')}`);
}

// 3. Grading checks
const fullCorrectAnswers = {
  '0_0': 'C',
  '0_1': 'B',
  '1_0': { 0: true, 1: true, 2: false, 3: true },
  '2_0': '  1,5  '
};
const fullGrade = gradeExam(parsed.data, fullCorrectAnswers);
assert.strictEqual(fullGrade.scale10, 10);
assert.strictEqual(fullGrade.fullCorrectCount, 4);
assert.strictEqual(fullGrade.unansweredCount, 0);

// Partial true_false scoring: 1 -> 0.1, 2 -> 0.25, 3 -> 0.5, 4 -> 1.0
const expectedPartial = [0, 0.1, 0.25, 0.5, 1.0];
const tfCorrectMap = { 0: true, 1: true, 2: false, 3: true };
for (let k = 0; k <= 4; k++) {
  const tfUser = {};
  for (let i = 0; i < 4; i++) {
    tfUser[i] = i < k ? tfCorrectMap[i] : !tfCorrectMap[i];
  }
  const g = gradeExam(parsed.data, { '1_0': tfUser });
  assert.strictEqual(g.details['1_0'].score, expectedPartial[k], `Expected ${expectedPartial[k]} for ${k} correct statements`);
  assert.strictEqual(g.unansweredCount, 3);
}

// 4. Round-trip YAML serialization check
const serialized = serializeExamYaml(parsed.data);
const reparsed = parseExamYaml(serialized);
assert.strictEqual(reparsed.ok, true, `Expected serialized YAML to parse cleanly, got: ${reparsed.errors}`);
assert.deepStrictEqual(reparsed.data, parsed.data);

// 5. LaTeX backslash commands in double-quoted YAML strings
const latexYaml = `
meta:
  title: "Đề LaTeX"
sections:
  - title: "Phần I"
    questions:
      - type: multiple_choice
        question: "Tính $2 \\times 3 + \\tan(\\theta) \\neq \\frac{1}{2}$ và \\n xuống dòng"
        options:
          A: "$\\text{A}$"
          B: "$\\to B$"
          C: "$\\nabla C$"
          D: "$\\triangle D$"
        answer: "A"
`;
const latexParsed = parseExamYaml(latexYaml);
assert.strictEqual(latexParsed.ok, true, `Expected LaTeX YAML to parse cleanly, got: ${latexParsed.errors}`);
const lq = latexParsed.data.sections[0].questions[0];
assert.ok(lq.question.includes('\\times') && lq.question.includes('\\tan') && lq.question.includes('\\neq') && lq.question.includes('\\frac'));
assert.ok(lq.question.includes('\n xuống dòng'));
assert.strictEqual(lq.options.A, '$\\text{A}$');
assert.strictEqual(lq.options.B, '$\\to B$');
assert.strictEqual(lq.options.C, '$\\nabla C$');
assert.strictEqual(lq.options.D, '$\\triangle D$');

// 6. Flow-style YAML array via js-yaml (e.g. ["7,5", "7.5"])
const flowYaml = `
meta:
  title: "Đề flow array"
sections:
  - title: "Phần I"
    questions:
      - type: short_answer
        question: "Tính $1/2$"
        accepted_answers: ["0,5", "0.5"]
`;
const flowParsed = parseExamYaml(flowYaml);
assert.strictEqual(flowParsed.ok, true, `Expected flow YAML to parse cleanly, got: ${flowParsed.errors}`);
assert.deepStrictEqual(flowParsed.data.sections[0].questions[0].accepted_answers, ['0,5', '0.5']);

// 7. Optional meta.folder parsing, strictness, and serialization
const folderYaml = `
meta:
  title: "Đề Toán"
  folder: "  Toán  "
sections:
  - title: "Phần I"
    questions:
      - type: short_answer
        question: "1 + 1 = ?"
        accepted_answers:
          - "2"
`;
const folderParsed = parseExamYaml(folderYaml);
assert.strictEqual(folderParsed.ok, true, `Expected folder YAML to parse cleanly, got: ${folderParsed.errors}`);
assert.strictEqual(folderParsed.data.meta.folder, 'Toán');

const serializedWithFolder = serializeExamYaml(folderParsed.data);
assert.ok(/^\s*folder:\s*"?Toán"?$/m.test(serializedWithFolder), `Expected serialized YAML to include folder, got:\n${serializedWithFolder}`);
const reparsedWithFolder = parseExamYaml(serializedWithFolder);
assert.strictEqual(reparsedWithFolder.ok, true);
assert.deepStrictEqual(reparsedWithFolder.data, folderParsed.data);

const serializedEmptyFolder = serializeExamYaml({
  ...folderParsed.data,
  meta: { title: 'Đề Toán', folder: '   ' }
});
assert.strictEqual(/^\s*folder:/m.test(serializedEmptyFolder), false, `Expected empty folder to be omitted, got:\n${serializedEmptyFolder}`);
const reparsedEmptyFolder = parseExamYaml(serializedEmptyFolder);
assert.strictEqual(reparsedEmptyFolder.ok, true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(reparsedEmptyFolder.data.meta, 'folder'), false);

const whitespaceFolderParsed = parseExamYaml(folderYaml.replace('  folder: "  Toán  "', '  folder: "   "'));
assert.strictEqual(whitespaceFolderParsed.ok, true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(whitespaceFolderParsed.data.meta, 'folder'), false);

const unknownMetaRes = parseExamYaml(folderYaml.replace('  folder: "  Toán  "', '  author: "AI"'));
assert.strictEqual(unknownMetaRes.ok, false, 'Unknown meta key must be rejected by .strict()');
assert.ok(unknownMetaRes.errors.some((e) => /meta/.test(e) && /author/.test(e)), `Unexpected error: ${unknownMetaRes.errors}`);

for (const badFolder of ['  folder: 123', '  folder: ["Toán"]']) {
  const badFolderRes = parseExamYaml(folderYaml.replace('  folder: "  Toán  "', badFolder));
  assert.strictEqual(badFolderRes.ok, false, `Invalid folder (${badFolder}) must fail`);
  assert.ok(badFolderRes.errors.some((e) => /meta\.folder/.test(e)), `Expected meta.folder error, got: ${badFolderRes.errors}`);
}

// 8. Constants & AI prompt checks
assert.strictEqual(STORAGE_KEY, 'ontap_exams_v1');
assert.strictEqual(PROGRESS_STORAGE_KEY, 'ontap_quiz_progress_v1');
assert.deepStrictEqual(PRESET_FOLDERS, ['Toán', 'Vật lý', 'Hóa học', 'Sinh học', 'Tiếng Anh', 'Tin học']);
assert.deepStrictEqual(TIMER_PRESET_MINUTES, [15, 30, 45, 50, 60, 90]);
assert.strictEqual(parseExamYaml(SAMPLE_YAML).ok, true, 'SAMPLE_YAML must parse cleanly');
const aiPrompt = buildAiPrompt('Đề thử', { folder: 'Vật lý', timeLimit: 50 });
assert.ok(aiPrompt.includes('folder') && aiPrompt.includes('time_limit') && aiPrompt.includes('1..600'));
assert.ok(aiPrompt.includes('tiếp') && aiPrompt.includes('CHƯA gửi kèm') && aiPrompt.includes('points'));

const sampleMatch = aiPrompt.match(/```yaml\n([\s\S]+?)\n```/);
assert.ok(sampleMatch, 'buildAiPrompt must include a fenced yaml sample block');
const aiSampleParsed = parseExamYaml(sampleMatch[1]);
assert.strictEqual(aiSampleParsed.ok, true, `buildAiPrompt YAML sample failed to parse: ${aiSampleParsed.errors}`);
assert.strictEqual(aiSampleParsed.data.meta.title, 'Đề thử');
assert.strictEqual(aiSampleParsed.data.meta.folder, 'Vật lý');
assert.strictEqual(aiSampleParsed.data.meta.time_limit, 50);
assert.strictEqual(aiSampleParsed.data.sections.length, 4);
assert.strictEqual(aiSampleParsed.data.sections[0].questions[0].points, 0.25);
assert.strictEqual(aiSampleParsed.data.sections[1].questions[0].points, 1);
assert.strictEqual(aiSampleParsed.data.sections[2].questions[0].points, 0.5);
assert.strictEqual(aiSampleParsed.data.sections[3].questions[0].type, 'group');
assert.strictEqual(aiSampleParsed.data.sections[3].questions[0].questions.length, 2);
assert.strictEqual(aiSampleParsed.data.sections[3].questions[0].questions[0].question, '');
assert.strictEqual(aiSampleParsed.data.sections[3].questions[0].questions[0].options.A, 'transformed');

// 9. Optional meta.time_limit validation, omission, and serialization
assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.data.meta, 'time_limit'), false);

const timedYaml = `
meta:
  title: "Đề có thời gian"
  time_limit: 45
sections:
  - title: "Phần I"
    questions:
      - type: short_answer
        question: "2 + 2 = ?"
        accepted_answers:
          - "4"
`;
const timedParsed = parseExamYaml(timedYaml);
assert.strictEqual(timedParsed.ok, true, `Expected timed YAML to parse cleanly, got: ${timedParsed.errors}`);
assert.strictEqual(timedParsed.data.meta.time_limit, 45);

const serializedTimed = serializeExamYaml(timedParsed.data);
assert.ok(/^\s*time_limit:\s*45$/m.test(serializedTimed), `Expected time_limit: 45 in serialized YAML:\n${serializedTimed}`);
const reparsedTimed = parseExamYaml(serializedTimed);
assert.strictEqual(reparsedTimed.ok, true);
assert.deepStrictEqual(reparsedTimed.data, timedParsed.data);

for (const minValid of [1, 600]) {
  const boundRes = parseExamYaml(timedYaml.replace('time_limit: 45', `time_limit: ${minValid}`));
  assert.strictEqual(boundRes.ok, true, `time_limit ${minValid} should be valid`);
  assert.strictEqual(boundRes.data.meta.time_limit, minValid);
}

for (const emptyLimit of ['time_limit:', 'time_limit: ""', 'time_limit: "   "']) {
  const emptyRes = parseExamYaml(timedYaml.replace('time_limit: 45', emptyLimit));
  assert.strictEqual(emptyRes.ok, true, `Empty ${emptyLimit} should parse cleanly`);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(emptyRes.data.meta, 'time_limit'), false);
}

for (const badLimit of ['time_limit: 0', 'time_limit: -5', 'time_limit: 12.5', 'time_limit: "45"', 'time_limit: true', 'time_limit: 601', 'time_limit: { min: 45 }']) {
  const badRes = parseExamYaml(timedYaml.replace('time_limit: 45', badLimit));
  assert.strictEqual(badRes.ok, false, `Invalid ${badLimit} must fail`);
  assert.ok(badRes.errors.some((e) => /meta\.time_limit/.test(e)), `Expected meta.time_limit error for ${badLimit}, got: ${badRes.errors}`);
}

const strictTimedRes = parseExamYaml(timedYaml.replace('time_limit: 45', 'time_limit: 45\n  extra: 1'));
assert.strictEqual(strictTimedRes.ok, false, 'Unknown meta key with time_limit must still fail .strict()');

for (const skipLimit of [undefined, null, '', 0, -5, 12.5, '45', true, 601]) {
  const out = serializeExamYaml({
    ...timedParsed.data,
    meta: { title: 'Test', time_limit: skipLimit }
  });
  assert.strictEqual(/^\s*time_limit:/m.test(out), false, `Expected invalid/empty time_limit (${String(skipLimit)}) to be omitted`);
}

// 10. countExamStats and isQuestionAnswered helpers
assert.deepStrictEqual(countExamStats(parsed.data), {
  sections: 3,
  total: 4,
  mc: 2,
  tf: 1,
  sa: 1,
  groups: 0
});

const mcQ = parsed.data.sections[0].questions[0];
const tfQ = parsed.data.sections[1].questions[0];
const saQ = parsed.data.sections[2].questions[0];
assert.strictEqual(isQuestionAnswered(mcQ, 'A'), true);
assert.strictEqual(isQuestionAnswered(mcQ, ''), false);
assert.strictEqual(isQuestionAnswered(mcQ, null), false);
assert.strictEqual(isQuestionAnswered(tfQ, { 0: true, 1: false, 2: false, 3: true }), true);
assert.strictEqual(isQuestionAnswered(tfQ, { 0: true, 1: false }), false);
assert.strictEqual(isQuestionAnswered(tfQ, undefined), false);
assert.strictEqual(isQuestionAnswered(saQ, ' 7.5 '), true);
assert.strictEqual(isQuestionAnswered(saQ, '   '), false);
assert.strictEqual(isQuestionAnswered(saQ, undefined), false);

// 11. Rich-text fallback and non-caching invariant before lazy load
assert.strictEqual(escapeHtml('<div class="x">a & \'b\'</div>'), '&lt;div class=&quot;x&quot;&gt;a &amp; &#39;b&#39;&lt;/div&gt;');
assert.strictEqual(isRichTextReady(), false);
const fallbackHtml = renderRichText('<script>alert(1)</script>\nDòng 2');
assert.ok(fallbackHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && fallbackHtml.includes('<br>'));
assert.deepStrictEqual(getRichTextCacheStats(), { size: 0, hits: 0, misses: 0 });
assert.strictEqual(
  renderRichPreviewHtml('   ', 'Nhập <b>nội dung</b>'),
  '<span class="gf-rich-placeholder">Nhập &lt;b&gt;nội dung&lt;/b&gt;</span>'
);

// 12. Timer utilities and createQuizTimer (injectable now clock, no sleeps)
assert.strictEqual(formatDuration(-10), '00:00');
assert.strictEqual(formatDuration(0), '00:00');
assert.strictEqual(formatDuration(9), '00:09');
assert.strictEqual(formatDuration(65), '01:05');
assert.strictEqual(formatDuration(3599), '59:59');
assert.strictEqual(formatDuration(3600), '01:00:00');
assert.strictEqual(formatDuration(3661), '01:01:01');

assert.strictEqual(getTimerStatus({ limitSeconds: 0, elapsedSeconds: 120 }), 'stopwatch');
assert.strictEqual(getTimerStatus({ limitSeconds: 900, elapsedSeconds: 0 }), 'normal');
assert.strictEqual(getTimerStatus({ limitSeconds: 900, elapsedSeconds: 720 }), 'warning');
assert.strictEqual(getTimerStatus({ limitSeconds: 900, elapsedSeconds: 840 }), 'critical');
assert.strictEqual(getTimerStatus({ limitSeconds: 900, elapsedSeconds: 900 }), 'expired');
assert.strictEqual(getTimerStatus({ limitSeconds: 2700, elapsedSeconds: 2399 }), 'normal');
assert.strictEqual(getTimerStatus({ limitSeconds: 2700, elapsedSeconds: 2400 }), 'warning');
assert.strictEqual(getTimerStatus({ limitSeconds: 2700, elapsedSeconds: 2640 }), 'critical');

const origSetInterval = globalThis.setInterval;
const origClearInterval = globalThis.clearInterval;
let nextTimerId = 1;
const activeIntervals = new Map();
globalThis.setInterval = (fn) => {
  const id = nextTimerId++;
  activeIntervals.set(id, fn);
  return id;
};
globalThis.clearInterval = (id) => {
  activeIntervals.delete(id);
};

try {
  let fakeNow = 10000;
  const events = [];
  const ticks = [];
  let expireCount = 0;

  const timer = createQuizTimer({
    now: () => fakeNow,
    onTick: (snap) => {
      ticks.push(snap);
      events.push(`tick:${snap.elapsedSeconds}:${snap.status}`);
    },
    onExpire: (snap) => {
      expireCount++;
      events.push(`expire:${snap.elapsedSeconds}:${snap.status}`);
    }
  });

  const fireIntervalTicks = (times = 1) => {
    for (let i = 0; i < times; i++) {
      for (const fn of [...activeIntervals.values()]) fn();
    }
  };

  // Stopwatch + pause/resume + tick deduplication
  timer.start(0);
  assert.strictEqual(ticks.length, 1);
  assert.strictEqual(ticks[0].mode, 'stopwatch');
  assert.strictEqual(ticks[0].remainingSeconds, null);
  assert.strictEqual(ticks[0].display, '00:00');
  assert.strictEqual(activeIntervals.size, 1);

  fakeNow += 250;
  fireIntervalTicks(1);
  fakeNow += 250;
  fireIntervalTicks(1);
  assert.strictEqual(ticks.length, 1, 'Repeated ticks within same second must not re-emit');

  fakeNow += 2500; // +3000ms total
  fireIntervalTicks(1);
  assert.strictEqual(ticks.length, 2);
  assert.strictEqual(ticks[1].elapsedSeconds, 3);
  assert.strictEqual(ticks[1].display, '00:03');

  const pausedSnap = timer.pause();
  assert.strictEqual(pausedSnap.paused, true);
  assert.strictEqual(pausedSnap.running, false);
  assert.strictEqual(activeIntervals.size, 0);

  fakeNow += 5000; // time passes while paused -> must not advance elapsed
  assert.strictEqual(timer.getSnapshot().elapsedSeconds, 3);

  timer.resume();
  assert.strictEqual(activeIntervals.size, 1);
  fakeNow += 2000;
  fireIntervalTicks(1);
  assert.strictEqual(timer.getSnapshot().elapsedSeconds, 5);

  // togglePause switches between running and paused
  const toggledOff = timer.togglePause();
  assert.strictEqual(toggledOff.paused, true);
  assert.strictEqual(toggledOff.running, false);
  const toggledOn = timer.togglePause();
  assert.strictEqual(toggledOn.paused, false);
  assert.strictEqual(toggledOn.running, true);

  // Switching limit mid-quiz resets elapsed to 0 and switches mode
  const switchedSnap = timer.setLimitMinutes(15);
  assert.strictEqual(switchedSnap.mode, 'countdown');
  assert.strictEqual(switchedSnap.limitSeconds, 900);
  assert.strictEqual(switchedSnap.elapsedSeconds, 0);
  assert.strictEqual(switchedSnap.remainingSeconds, 900);
  assert.strictEqual(switchedSnap.display, '15:00');
  assert.strictEqual(switchedSnap.status, 'normal');

  // Countdown + expiry clamping + final onTick before onExpire once
  events.length = 0;
  expireCount = 0;
  timer.start(1); // 60s -> starts in critical (<= 60s)
  assert.strictEqual(timer.getSnapshot().display, '01:00');
  assert.strictEqual(timer.getSnapshot().status, 'critical');

  fakeNow += 15000;
  fireIntervalTicks(1);
  assert.strictEqual(timer.getSnapshot().remainingSeconds, 45);
  assert.strictEqual(timer.getSnapshot().display, '00:45');

  fakeNow += 50000; // 65s total -> clamped to 60s and expires
  fireIntervalTicks(2);
  const expiredSnap = timer.getSnapshot();
  assert.strictEqual(expiredSnap.elapsedSeconds, 60);
  assert.strictEqual(expiredSnap.remainingSeconds, 0);
  assert.strictEqual(expiredSnap.display, '00:00');
  assert.strictEqual(expiredSnap.elapsedDisplay, '01:00');
  assert.strictEqual(expiredSnap.status, 'expired');
  assert.strictEqual(expiredSnap.running, false);
  assert.strictEqual(expiredSnap.paused, false);
  assert.strictEqual(activeIntervals.size, 0);
  assert.strictEqual(expireCount, 1);
  assert.deepStrictEqual(events.slice(-2), ['tick:60:expired', 'expire:60:expired']);

  // Manual stop never calls onExpire
  timer.start(1);
  fakeNow += 10000;
  const stoppedSnap = timer.stop();
  assert.strictEqual(stoppedSnap.elapsedSeconds, 10);
  assert.strictEqual(stoppedSnap.running, false);
  assert.strictEqual(activeIntervals.size, 0);
  assert.strictEqual(expireCount, 1);

  // Resume from initialElapsedSeconds: stopwatch mode
  events.length = 0;
  const swResumeSnap = timer.start(0, { initialElapsedSeconds: 95 });
  assert.strictEqual(swResumeSnap.mode, 'stopwatch');
  assert.strictEqual(swResumeSnap.elapsedSeconds, 95);
  assert.strictEqual(swResumeSnap.remainingSeconds, null);
  assert.strictEqual(swResumeSnap.display, '01:35');
  assert.strictEqual(swResumeSnap.elapsedDisplay, '01:35');
  assert.strictEqual(swResumeSnap.status, 'stopwatch');
  assert.strictEqual(swResumeSnap.running, true);
  assert.strictEqual(swResumeSnap.paused, false);
  assert.strictEqual(activeIntervals.size, 1);
  assert.deepStrictEqual(events.slice(-1), ['tick:95:stopwatch']);

  fakeNow += 2000;
  fireIntervalTicks(1);
  assert.strictEqual(timer.getSnapshot().elapsedSeconds, 97);
  assert.strictEqual(timer.getSnapshot().display, '01:37');

  // Sanitizes invalid/negative/float initialElapsedSeconds
  assert.strictEqual(timer.start(0, { initialElapsedSeconds: -5 }).elapsedSeconds, 0);
  assert.strictEqual(timer.start(0, { initialElapsedSeconds: 12.9 }).elapsedSeconds, 12);
  assert.strictEqual(timer.start(0, { initialElapsedSeconds: Number.NaN }).elapsedSeconds, 0);

  // Resume from initialElapsedSeconds: countdown mode with partial elapsed time
  events.length = 0;
  const cdResumeSnap = timer.start(5, { initialElapsedSeconds: 125 });
  assert.strictEqual(cdResumeSnap.mode, 'countdown');
  assert.strictEqual(cdResumeSnap.limitSeconds, 300);
  assert.strictEqual(cdResumeSnap.elapsedSeconds, 125);
  assert.strictEqual(cdResumeSnap.remainingSeconds, 175);
  assert.strictEqual(cdResumeSnap.display, '02:55');
  assert.strictEqual(cdResumeSnap.elapsedDisplay, '02:05');
  assert.strictEqual(cdResumeSnap.status, 'normal');
  assert.strictEqual(cdResumeSnap.running, true);
  assert.strictEqual(cdResumeSnap.paused, false);

  fakeNow += 120000;
  fireIntervalTicks(1);
  assert.strictEqual(timer.getSnapshot().elapsedSeconds, 245);
  assert.strictEqual(timer.getSnapshot().remainingSeconds, 55);
  assert.strictEqual(timer.getSnapshot().display, '00:55');
  assert.strictEqual(timer.getSnapshot().status, 'critical');

  fakeNow += 55000;
  fireIntervalTicks(1);
  assert.strictEqual(timer.getSnapshot().status, 'expired');
  assert.strictEqual(expireCount, 2);
  assert.strictEqual(activeIntervals.size, 0);

  // Immediate expiry when initialElapsedSeconds >= limitSeconds
  events.length = 0;
  const immEqSnap = timer.start(1, { initialElapsedSeconds: 60 });
  assert.strictEqual(immEqSnap.elapsedSeconds, 60);
  assert.strictEqual(immEqSnap.remainingSeconds, 0);
  assert.strictEqual(immEqSnap.display, '00:00');
  assert.strictEqual(immEqSnap.elapsedDisplay, '01:00');
  assert.strictEqual(immEqSnap.status, 'expired');
  assert.strictEqual(immEqSnap.running, false);
  assert.strictEqual(immEqSnap.paused, false);
  assert.strictEqual(activeIntervals.size, 0);
  assert.strictEqual(expireCount, 3);
  assert.deepStrictEqual(events, ['tick:60:expired', 'expire:60:expired']);

  events.length = 0;
  const immGtSnap = timer.start(1, { initialElapsedSeconds: 95 });
  assert.strictEqual(immGtSnap.elapsedSeconds, 60);
  assert.strictEqual(immGtSnap.remainingSeconds, 0);
  assert.strictEqual(immGtSnap.status, 'expired');
  assert.strictEqual(immGtSnap.running, false);
  assert.strictEqual(activeIntervals.size, 0);
  assert.strictEqual(expireCount, 4);
  assert.deepStrictEqual(events, ['tick:60:expired', 'expire:60:expired']);

  timer.start(0);
  timer.destroy();
  assert.strictEqual(activeIntervals.size, 0);
} finally {
  globalThis.setInterval = origSetInterval;
  globalThis.clearInterval = origClearInterval;
}

// 13. Analytics, streaks, heatmap, calendar, subject GPA & history filtering
assert.strictEqual(HISTORY_STORAGE_KEY, 'ontap_quiz_history_v1');
assert.strictEqual(PROFILE_STORAGE_KEY, 'ontap_profile_v1');
assert.strictEqual(MAX_HISTORY_ENTRIES, 500);

assert.strictEqual(formatCompactDuration(0), '0p');
assert.strictEqual(formatCompactDuration(42), '42s');
assert.strictEqual(formatCompactDuration(900), '15p');
assert.strictEqual(formatCompactDuration(5700), '1h35m');
assert.strictEqual(formatCompactDuration(3600), '1h');

const tsNov21 = new Date(2026, 10, 21, 16, 30, 5).getTime();
const tsNov20 = new Date(2026, 10, 20, 10, 0, 0).getTime();
const tsNov19 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const tsNov10 = new Date(2026, 10, 10, 9, 0, 0).getTime();
const tsNov09 = new Date(2026, 10, 9, 9, 0, 0).getTime();
const tsNov08 = new Date(2026, 10, 8, 8, 4, 7).getTime();
const tsNov07 = new Date(2026, 10, 7, 8, 0, 0).getTime();

assert.strictEqual(toLocalDateKey(tsNov21), '2026-11-21');
assert.strictEqual(formatSubmittedAt(tsNov08), '08/11/26 08:04:07');

const sampleHistory = [
  { id: 'h1', examId: 'e1', examTitle: 'Đề Toán 1', subject: 'Toán', scale10: 8.5, elapsedSeconds: 1800, submittedAt: tsNov21 },
  { id: 'h2', examId: 'e2', examTitle: 'Đề Lý 1', subject: 'Vật lý', scale10: 7.0, elapsedSeconds: 1200, submittedAt: tsNov21 },
  { id: 'h3', examId: 'e1', examTitle: 'Đề Toán 2', subject: 'Toán', scale10: 9.5, elapsedSeconds: 2400, submittedAt: tsNov20 },
  { id: 'h4', examId: 'e3', examTitle: 'Đề Anh 1', subject: 'Tiếng Anh', scale10: 7.25, elapsedSeconds: 5700, submittedAt: tsNov19 },
  { id: 'h5', examId: 'e4', examTitle: 'Đề Chung', subject: '', scale10: 6.0, elapsedSeconds: 600, submittedAt: tsNov10 },
  { id: 'h6', examId: 'e4', examTitle: 'Đề Chung 2', subject: '', scale10: 8.0, elapsedSeconds: 600, submittedAt: tsNov09 },
  { id: 'h7', examId: 'e4', examTitle: 'Đề Chung 3', subject: '', scale10: 7.0, elapsedSeconds: 600, submittedAt: tsNov08 },
  { id: 'h8', examId: 'e4', examTitle: 'Đề Chung 4', subject: '', scale10: 9.0, elapsedSeconds: 600, submittedAt: tsNov07 }
];

const streakNov21 = computeStreaks(sampleHistory, tsNov21);
assert.strictEqual(streakNov21.currentStreak, 3);
assert.strictEqual(streakNov21.bestStreak, 4);
assert.strictEqual(streakNov21.activeDaysCount, 7);

// Yesterday still preserves currentStreak before today ends
const tsNov22Morning = new Date(2026, 10, 22, 8, 0, 0).getTime();
assert.strictEqual(computeStreaks(sampleHistory, tsNov22Morning).currentStreak, 3);
const tsNov23Morning = new Date(2026, 10, 23, 8, 0, 0).getTime();
assert.strictEqual(computeStreaks(sampleHistory, tsNov23Morning).currentStreak, 0);
assert.strictEqual(computeStreaks(sampleHistory, tsNov23Morning).bestStreak, 4);

const kpis = computeOverallKpis(sampleHistory, tsNov21);
assert.strictEqual(kpis.totalAttempts, 8);
assert.strictEqual(kpis.avgScore, 7.78);
assert.strictEqual(kpis.bestScore, 9.5);
assert.strictEqual(kpis.totalSeconds, 13500);
assert.strictEqual(kpis.totalDurationText, '3h45m');

const subjAvgs = computeSubjectAverages(sampleHistory);
assert.strictEqual(subjAvgs[0].subject, 'Chưa phân loại');
assert.strictEqual(subjAvgs[0].attempts, 4);
assert.strictEqual(subjAvgs[0].avgScore, 7.5);
const mathAvg = subjAvgs.find((s) => s.subject === 'Toán');
assert.strictEqual(mathAvg.attempts, 2);
assert.strictEqual(mathAvg.avgScore, 9);
assert.strictEqual(mathAvg.bestScore, 9.5);
assert.strictEqual(mathAvg.level, 'excellent');

const hm2026 = buildYearHeatmap(sampleHistory, 2026, tsNov21);
assert.strictEqual(hm2026.totalDaysInYear, 365);
assert.strictEqual(hm2026.activeDaysInYear, 7);
assert.strictEqual(hm2026.monthLabels.length, 12);

const hm2028 = buildYearHeatmap([], 2028, tsNov21);
assert.strictEqual(hm2028.totalDaysInYear, 366);

const calNov = buildMonthCalendarWeeks(2026, 10, sampleHistory, tsNov21);
assert.strictEqual(calNov.monthLabel, 'Tháng 11 - 2026');
assert.ok(calNov.weeks.length >= 5);
const selectedWeek = calNov.weeks[calNov.defaultWeekIndex];
assert.ok(selectedWeek.days.some((d) => d.dateKey === '2026-11-21' && d.isToday && d.count === 2));

const weekly = buildWeeklyBreakdown(selectedWeek, sampleHistory, PRESET_FOLDERS);
assert.strictEqual(weekly.weekTotalAttempts, 4);
assert.strictEqual(weekly.weekTotalSeconds, 11100);
assert.strictEqual(weekly.weekTotalDurationText, '3h05m');
assert.strictEqual(weekly.days.length, 7);

assert.strictEqual(filterHistory(sampleHistory, { range: '7d', subject: 'ALL', nowMs: tsNov21 }).length, 4);
assert.strictEqual(filterHistory(sampleHistory, { range: 'all', subject: 'Toán', nowMs: tsNov21 }).length, 2);

// 14. Auto-dividing points (resolveExamPoints, sec.points, q.points, weighted gradeExam)
const defaultPts = resolveExamPoints(parsed.data);
assert.strictEqual(defaultPts.hasCustomPoints, false);
assert.strictEqual(defaultPts.totalMaxPoints, 10);
assert.strictEqual(defaultPts.questionMaxPoints['0_0'], 2.5);
assert.strictEqual(defaultPts.sectionMaxPoints[0], 5);

const customPointsYaml = `
meta:
  title: "Đề tự chia điểm"
sections:
  - title: "Phần I"
    points: 3
    questions:
      - type: multiple_choice
        question: "Q1"
        options:
          A: "1"
          B: "2"
          C: "3"
          D: "4"
        answer: "A"
      - type: multiple_choice
        question: "Q2"
        options:
          A: "1"
          B: "2"
          C: "3"
          D: "4"
        answer: "B"
  - title: "Phần II"
    questions:
      - type: true_false
        question: "Q3"
        points: 4
        statements:
          - text: "s1"
            is_true: true
          - text: "s2"
            is_true: true
          - text: "s3"
            is_true: false
          - text: "s4"
            is_true: true
  - title: "Phần III"
    questions:
      - type: short_answer
        question: "Q4"
        accepted_answers: ["10"]
      - type: short_answer
        question: "Q5"
        accepted_answers: ["20"]
`;
const cpParsed = parseExamYaml(customPointsYaml);
assert.strictEqual(cpParsed.ok, true, `Custom points YAML should parse: ${cpParsed.errors}`);
const cpResolved = resolveExamPoints(cpParsed.data);
assert.strictEqual(cpResolved.hasCustomPoints, true);
assert.strictEqual(cpResolved.totalMaxPoints, 10);
// Phần I: 3đ auto-divided across 2 questions -> 1.5đ each
assert.strictEqual(cpResolved.questionMaxPoints['0_0'], 1.5);
assert.strictEqual(cpResolved.questionMaxPoints['0_1'], 1.5);
// Phần II: Q3 has fixed points: 4
assert.strictEqual(cpResolved.questionMaxPoints['1_0'], 4);
// Phần III: remaining 10 - (3 + 4) = 3đ auto-divided across Q4 & Q5 -> 1.5đ each
assert.strictEqual(cpResolved.questionMaxPoints['2_0'], 1.5);
assert.strictEqual(cpResolved.questionMaxPoints['2_1'], 1.5);

// Weighted gradeExam check: Q1 right (1.5đ), Q3 3/4 statements right (0.5 * 4 = 2.0đ), Q4 right (1.5đ) -> 5.0 / 10
const cpGrade = gradeExam(cpParsed.data, {
  '0_0': 'A',
  '1_0': { 0: true, 1: true, 2: false, 3: false },
  '2_0': '10'
});
assert.strictEqual(cpGrade.earnedPoints, 5);
assert.strictEqual(cpGrade.totalMaxPoints, 10);
assert.strictEqual(cpGrade.scale10, 5);

const cpSerialized = serializeExamYaml(cpParsed.data);
const cpReparsed = parseExamYaml(cpSerialized);
assert.strictEqual(cpReparsed.ok, true);
assert.deepStrictEqual(cpReparsed.data, cpParsed.data);

// 15. Grouped/passage questions (type: "group")
const groupYaml = `
meta:
  title: "Đề đọc hiểu & điền khuyết"
  folder: "Tiếng Anh"
sections:
  - title: "Phần I. Cloze & Reading"
    questions:
      - type: group
        title: "  Passage 1  "
        content: |
          Read the passage and fill in blanks **(1)** and **(2)**.
          Water boils at $100^\\circ\\text{C}$.
        points: 2
        questions:
          - options:
              A: "creative"
              B: "impressive"
              C: "childhood"
              D: "accessible"
            answer: " c "
            explanation: "Blank (1) needs a noun."
          - question: "Which word best fits blank (2)?"
            options:
              A: "adopt"
              B: "adapt"
              C: "adept"
              D: "admire"
            answer: "A"
            points: 0.8
          - type: true_false
            statements:
              - text: "Water boils at 100 C"
                is_true: true
              - text: "Water freezes at 50 C"
                is_true: false
          - type: short_answer
            question: "What temperature?"
            accepted_answers: ["100", "100 C"]
      - type: group
        title: "   "
        content: "Short passage 2."
        questions:
          - options:
              A: "one"
              B: "two"
              C: "three"
              D: "four"
            answer: "B"
  - title: "Phần II. Standalone"
    questions:
      - type: multiple_choice
        question: "Standalone Q"
        options:
          A: "x"
          B: "y"
          C: "z"
          D: "w"
        answer: "D"
        points: 3
`;
const groupParsed = parseExamYaml(groupYaml);
assert.strictEqual(groupParsed.ok, true, `Group YAML should parse cleanly, got: ${groupParsed.errors}`);

const grp1 = groupParsed.data.sections[0].questions[0];
const grp2 = groupParsed.data.sections[0].questions[1];
assert.strictEqual(grp1.type, 'group');
assert.strictEqual(grp1.title, 'Passage 1');
assert.strictEqual(grp1.points, 2);
assert.strictEqual(grp1.questions.length, 4);
assert.strictEqual(grp1.questions[0].type, 'multiple_choice');
assert.strictEqual(grp1.questions[0].question, '');
assert.deepStrictEqual(grp1.questions[0].options, {
  A: 'creative',
  B: 'impressive',
  C: 'childhood',
  D: 'accessible'
});
assert.strictEqual(grp1.questions[0].answer, 'C');
assert.strictEqual(grp1.questions[1].question, 'Which word best fits blank (2)?');
assert.strictEqual(grp1.questions[1].points, 0.8);
assert.strictEqual(grp1.questions[2].type, 'true_false');
assert.strictEqual(grp1.questions[2].question, '');
assert.strictEqual(grp1.questions[3].type, 'short_answer');
assert.strictEqual(Object.prototype.hasOwnProperty.call(grp2, 'title'), false);

// Stats with groups
assert.deepStrictEqual(countExamStats(groupParsed.data), {
  sections: 2,
  total: 6,
  mc: 4,
  tf: 1,
  sa: 1,
  groups: 2
});

// isQuestionAnswered on sub-questions and group
assert.strictEqual(isQuestionAnswered(grp1.questions[0], 'C'), true);
assert.strictEqual(isQuestionAnswered(grp1.questions[0], ''), false);
assert.strictEqual(isQuestionAnswered(grp2, { 0: 'B' }), true);
assert.strictEqual(isQuestionAnswered(grp2, {}), false);

// Points resolution with group.points + subQ.points + global remainder
// grp1 has points: 2, sub1 fixed 0.8 -> remaining 1.2 / 3 = 0.4 for sub0, sub2, sub3
// standalone Q has points: 3 -> total assigned = 5 -> grp2 sub0 gets remaining 10 - 5 = 5
const grpPts = resolveExamPoints(groupParsed.data);
assert.strictEqual(grpPts.hasCustomPoints, true);
assert.strictEqual(grpPts.totalMaxPoints, 10);
assert.strictEqual(grpPts.questionMaxPoints['0_0_0'], 0.4);
assert.strictEqual(grpPts.questionMaxPoints['0_0_1'], 0.8);
assert.strictEqual(grpPts.questionMaxPoints['0_0_2'], 0.4);
assert.strictEqual(grpPts.questionMaxPoints['0_0_3'], 0.4);
assert.strictEqual(grpPts.questionMaxPoints['0_1_0'], 5);
assert.strictEqual(grpPts.questionMaxPoints['1_0'], 3);
assert.strictEqual(grpPts.sectionMaxPoints[0], 7);
assert.strictEqual(grpPts.sectionMaxPoints[1], 3);

// Equal division when no custom points on group exam
const equalGroupExam = {
  meta: { title: 'Equal Group' },
  sections: [
    {
      title: 'S1',
      questions: [
        {
          type: 'group',
          content: 'Passage',
          questions: [
            { type: 'multiple_choice', question: '', options: { A: '1', B: '2', C: '3', D: '4' }, answer: 'A', explanation: '' },
            { type: 'multiple_choice', question: '', options: { A: '1', B: '2', C: '3', D: '4' }, answer: 'B', explanation: '' }
          ]
        },
        { type: 'short_answer', question: 'Q', accepted_answers: ['1'], explanation: '' },
        { type: 'short_answer', question: 'Q2', accepted_answers: ['2'], explanation: '' }
      ]
    }
  ]
};
const eqPts = resolveExamPoints(equalGroupExam);
assert.strictEqual(eqPts.hasCustomPoints, false);
assert.strictEqual(eqPts.totalMaxPoints, 10);
assert.strictEqual(eqPts.questionMaxPoints['0_0_0'], 2.5);
assert.strictEqual(eqPts.questionMaxPoints['0_0_1'], 2.5);
assert.strictEqual(eqPts.questionMaxPoints['0_1'], 2.5);
assert.strictEqual(eqPts.questionMaxPoints['0_2'], 2.5);

// Grading grouped exam with ${sIdx}_${qIdx}_${subIdx} keys
const grpGrade = gradeExam(groupParsed.data, {
  '0_0_0': 'C',                      // +0.4
  '0_0_1': 'A',                      // +0.8
  '0_0_2': { 0: true, 1: true },     // 1/2 statements -> 0.5 * 0.4 = +0.2
  '0_0_3': ' 100 ',                  // +0.4
  '0_1_0': 'A',                      // wrong -> 0
  '1_0': 'D'                         // +3.0
});
assert.strictEqual(grpGrade.totalQuestions, 6);
assert.strictEqual(grpGrade.unansweredCount, 0);
assert.strictEqual(grpGrade.fullCorrectCount, 4);
assert.strictEqual(grpGrade.earnedPoints, 4.8);
assert.strictEqual(grpGrade.totalMaxPoints, 10);
assert.strictEqual(grpGrade.scale10, 4.8);
assert.strictEqual(grpGrade.details['0_0_0'].isFullCorrect, true);
assert.strictEqual(grpGrade.details['0_0_1'].earnedPoints, 0.8);
assert.strictEqual(grpGrade.details['0_0_2'].score, 0.5);
assert.strictEqual(grpGrade.details['0_1_0'].isFullCorrect, false);

// Round-trip serialization for group exam
const grpSerialized = serializeExamYaml(groupParsed.data);
assert.ok(/A:\s*"?creative"?/.test(grpSerialized), `Expected explicit A/B/C/D options in serialized group YAML:\n${grpSerialized}`);
const grpReparsed = parseExamYaml(grpSerialized);
assert.strictEqual(grpReparsed.ok, true, `Serialized group YAML failed to re-parse: ${grpReparsed.errors}`);
assert.deepStrictEqual(grpReparsed.data, groupParsed.data);

// Invalid group & strict options cases
const invalidGroupCases = [
  {
    name: 'array options rejected in group',
    yaml: `meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: group\n        content: "Passage"\n        questions:\n          - options: ["a", "b", "c", "d"]\n            answer: "A"`,
    expect: /options/
  },
  {
    name: 'array options rejected in standalone multiple_choice',
    yaml: `meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: multiple_choice\n        question: "Q"\n        options: ["a", "b", "c", "d"]\n        answer: "A"`,
    expect: /options/
  },
  {
    name: 'missing group content',
    yaml: `meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: group\n        questions:\n          - options:\n              A: "1"\n              B: "2"\n              C: "3"\n              D: "4"\n            answer: "A"`,
    expect: /content/
  },
  {
    name: 'empty group questions',
    yaml: `meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: group\n        content: "Passage"\n        questions: []`,
    expect: /questions/
  },
  {
    name: 'nested group rejected',
    yaml: `meta:\n  title: "T"\nsections:\n  - title: "P1"\n    questions:\n      - type: group\n        content: "Outer"\n        questions:\n          - type: group\n            content: "Inner"\n            questions: []`,
    expect: /type/
  }
];
for (const tc of invalidGroupCases) {
  const res = parseExamYaml(tc.yaml);
  assert.strictEqual(res.ok, false, `Group invalid case "${tc.name}" should fail`);
  assert.ok(res.errors.some((e) => tc.expect.test(e)), `Group invalid case "${tc.name}" error mismatch: ${res.errors.join('; ')}`);
}

console.log('All parser, rich-text, timer, analytics, and grader assertions passed.');
}

runTests();
