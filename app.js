import { createApp, defineComponent, h, provide, inject, ref, shallowRef, computed, watch, nextTick } from 'vue';
import jsyaml from 'js-yaml';
import {
  STORAGE_KEY,
  PROGRESS_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  TURBO_PREF_KEY,
  FOLDERS_STORAGE_KEY,
  MAX_HISTORY_ENTRIES,
  PRESET_FOLDERS,
  SAMPLE_YAML,
  buildAiPrompt
} from './constants.js';
import {
  parseYaml,
  parseExamYaml,
  serializeExamYaml,
  gradeSingleQuestion,
  gradeExam,
  resolveExamPoints,
  countExamStats,
  isQuestionAnswered
} from './parser.js';
import {
  ensureRichTextReady,
  renderRichText,
  renderRichPreviewHtml
} from './rich-text.js';
import {
  ensureMonacoLoaded,
  createMonacoYamlEditor,
  syncMonacoMarkers,
  loadSortable
} from './editor-loaders.js';
import { createQuizTimer, formatDuration } from './timer.js';
import {
  createYamlLineIndex,
  applyIncrementalChanges,
  lookupLineByQuestion,
  lookupQuestionByLine
} from './yaml-line-map.js';
import {
  normalizeFolderPath,
  getSubjectFromFolder,
  getParentFolderPath,
  getFolderLeafName,
  collectAncestors,
  sanitizeFoldersArray,
  compareFolderPathsVi,
  updateExamFolderYaml as updateExamFolderYamlBase
} from './folder-utils.js';
import { downloadAttemptExport } from './export-utils.js';
import {
  tagCanonicalIndices,
  shuffleExamState,
  remapAnswersToCanonical,
  getShuffleOrder,
  applyShuffleOrder
} from './shuffle-utils.js';

let uidCounter = 0;
function nextUid() {
  return `uid_${++uidCounter}`;
}

function createDefaultSubQuestion(type, questionText = '', explanation = '') {
  const qText = questionText == null ? '' : String(questionText);
  const exp = explanation || '';
  const _uid = nextUid();
  if (type === 'true_false') {
    return {
      _uid, type: 'true_false', question: qText, explanation: exp,
      statements: [
        { text: 'Mệnh đề a', is_true: true },
        { text: 'Mệnh đề b', is_true: false },
        { text: 'Mệnh đề c', is_true: true },
        { text: 'Mệnh đề d', is_true: false }
      ]
    };
  }
  if (type === 'short_answer') {
    return { _uid, type: 'short_answer', question: qText, accepted_answers: ['Đáp án'], explanation: exp };
  }
  return {
    _uid, type: 'multiple_choice', question: qText, explanation: exp,
    options: { A: 'Lựa chọn A', B: 'Lựa chọn B', C: 'Lựa chọn C', D: 'Lựa chọn D' },
    answer: 'A'
  };
}

function createDefaultQuestion(type, questionText, explanation) {
  const _uid = nextUid();
  if (type === 'group') {
    const contentText = (questionText && String(questionText).trim())
      ? String(questionText)
      : 'Nhập đoạn văn đọc hiểu hoặc bài điền khuyết (1)..., (2)... tại đây.';
    return {
      _uid,
      type: 'group',
      title: '',
      content: contentText,
      questions: [
        createDefaultSubQuestion('multiple_choice', ''),
        createDefaultSubQuestion('multiple_choice', '')
      ]
    };
  }
  const qText = questionText || 'Nội dung câu hỏi mới';
  const exp = explanation || '';
  if (type === 'true_false') {
    return {
      _uid, type: 'true_false', question: qText, explanation: exp,
      statements: [
        { text: 'Mệnh đề a', is_true: true },
        { text: 'Mệnh đề b', is_true: false },
        { text: 'Mệnh đề c', is_true: true },
        { text: 'Mệnh đề d', is_true: false }
      ]
    };
  }
  if (type === 'short_answer') {
    return { _uid, type: 'short_answer', question: qText, accepted_answers: ['Đáp án'], explanation: exp };
  }
  return {
    _uid, type: 'multiple_choice', question: qText, explanation: exp,
    options: { A: 'Lựa chọn A', B: 'Lựa chọn B', C: 'Lựa chọn C', D: 'Lựa chọn D' },
    answer: 'A'
  };
}

function attachUids(data) {
  data.sections.forEach((sec) => {
    if (!sec._uid) sec._uid = nextUid();
    sec.questions.forEach((q) => {
      if (!q._uid) q._uid = nextUid();
      if (q.type === 'group' && Array.isArray(q.questions)) {
        q.questions.forEach((subQ) => {
          if (!subQ._uid) subQ._uid = nextUid();
        });
      }
    });
  });
  return data;
}

function toSafeFilenameSlug(title) {
  const ascii = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'de-on-tap';
}

const QUIZ_CTX_KEY = Symbol('otdo-quiz-ctx');
const MC_OPTION_KEYS = ['A', 'B', 'C', 'D'];

const QuizProgressText = defineComponent({
  name: 'QuizProgressText',
  setup() {
    const ctx = inject(QUIZ_CTX_KEY);
    return () => h('div', { id: 'quiz-progress', class: 'text-sm text-slate-700 font-medium' }, ctx.quizProgressText.value);
  }
});

const QuizNavCell = defineComponent({
  name: 'QuizNavCell',
  props: {
    item: { type: Object, required: true },
    sectionIndex: { type: Number, required: true }
  },
  setup(props) {
    const ctx = inject(QUIZ_CTX_KEY);
    return () => {
      const item = props.item;
      const cls = ctx.quizNavCellClass(item.q, item.sIdx, item.qIdx, item.subIdx);
      return h('button', {
        type: 'button',
        class: cls ? `nav-cell ${cls}` : 'nav-cell',
        'aria-label': `Đi tới Phần ${props.sectionIndex + 1}, câu ${item.num}`,
        onClick: () => ctx.scrollToQuestion(item.sIdx, item.qIdx, item.subIdx)
      }, String(item.num));
    };
  }
});

const QuizLeafQuestion = defineComponent({
  name: 'QuizLeafQuestion',
  props: {
    question: { type: Object, required: true },
    sIdx: { type: Number, required: true },
    qIdx: { type: Number, required: true },
    subIdx: { type: Number, default: null },
    isSub: { type: Boolean, default: false }
  },
  setup(props) {
    const ctx = inject(QUIZ_CTX_KEY);
    return () => {
      const q = props.question;
      const sIdx = props.sIdx;
      const qIdx = props.qIdx;
      const subIdx = props.subIdx;
      const isSub = props.isSub;
      const id = subIdx === null || subIdx === undefined ? `${sIdx}_${qIdx}` : `${sIdx}_${qIdx}_${subIdx}`;
      const num = ctx.getQuizQuestionNum(sIdx, qIdx, subIdx);
      const maxPts = ctx.formatPointNum(ctx.getQuizQuestionMaxPoints(sIdx, qIdx, subIdx));
      const revealed = ctx.isQuestionRevealed(sIdx, qIdx, subIdx);
      const locked = revealed;
      const detail = revealed ? ctx.getDisplayDetail(sIdx, qIdx, subIdx) : null;
      const picked = ctx.userAnswers.value[id];
      const turboMode = ctx.quizTurboMode.value;

      let cardState = '';
      if (detail) {
        cardState = detail.isFullCorrect ? 'is-correct' : (detail.score > 0 ? 'is-partial' : 'is-wrong');
      }

      const headerChildren = [
        h('div', { class: 'flex items-center gap-2' }, [
          h('span', { class: 'question-number' }, `Câu ${num}`),
          h('span', { class: 'badge bg-slate-100 text-slate-700 border-slate-200 tabular-nums' }, `${maxPts} đ`)
        ])
      ];
      if (revealed) {
        const badgeCls = detail
          ? (detail.isFullCorrect ? 'badge-success' : (detail.score > 0 ? '' : 'badge-error'))
          : '';
        headerChildren.push(
          h('span', { class: badgeCls ? `badge bg-slate-200 text-slate-900 ${badgeCls}` : 'badge bg-slate-200 text-slate-900' }, ctx.quizBadgeText(sIdx, qIdx, subIdx))
        );
      }

      const children = [
        h('div', { class: isSub ? 'flex justify-between items-center gap-2.5 mb-2.5' : 'flex justify-between items-center gap-2.5 mb-2' }, headerChildren)
      ];

      if (!isSub || ctx.hasSubQuestionText(q)) {
        children.push(
          h('div', {
            class: isSub
              ? 'question-text m-0 mb-3 text-base font-medium text-slate-900 whitespace-normal'
              : 'question-text m-0 mb-3.5 text-base font-medium text-slate-900 whitespace-normal',
            innerHTML: ctx.renderRichText(q.question)
          })
        );
      }

      if (q.type === 'multiple_choice') {
        const optionNodes = MC_OPTION_KEYS.map((key) => {
          let optCls = '';
          if (detail) {
            if (key === q.answer) optCls = 'is-locked opt-correct';
            else if (picked === key) optCls = 'is-locked opt-wrong';
            else optCls = 'is-locked';
          } else if (picked === key) {
            optCls = 'opt-selected';
          }
          return h('label', {
            key,
            class: optCls ? `option-row ${optCls}` : 'option-row',
            onPointerdown: (e) => ctx.onMcOptionPointerDown(e, sIdx, qIdx, key, subIdx),
            onClick: (e) => ctx.onMcLabelClick(e, id, key)
          }, [
            h('input', {
              type: 'radio',
              class: 'radio-input',
              name: `q_${id}`,
              value: key,
              checked: picked === key,
              disabled: locked,
              onChange: () => ctx.selectMcOption(sIdx, qIdx, key, subIdx)
            }),
            h('span', { class: isSub ? 'font-bold min-w-[20px]' : 'font-bold min-w-[22px]' }, `${key}.`),
            h('span', { innerHTML: ctx.renderRichText(q.options[key]) })
          ]);
        });
        children.push(h('div', { class: 'quiz-options-stack' }, optionNodes));
        if (revealed && detail && !detail.isFullCorrect) {
          children.push(
            h('div', { class: isSub ? 'mt-2 text-sm font-semibold' : 'mt-2.5 text-sm font-semibold' }, `Đáp án đúng: ${q.answer}`)
          );
        }
      } else if (q.type === 'true_false') {
        const stNodes = (q.statements || []).map((st, stIdx) => {
          const stRev = ctx.isTfStatementRevealed(sIdx, qIdx, stIdx, subIdx);
          const stRes = stRev ? ctx.getStatementDisplayResult(sIdx, qIdx, stIdx, subIdx) : null;
          const stCls = stRes ? (stRes.isCorrect ? 'st-correct' : 'st-wrong') : '';
          const tfPick = picked && typeof picked === 'object' ? picked[stIdx] : undefined;
          const textChildren = [
            h('strong', null, `${String.fromCharCode(97 + stIdx)})`),
            ' ',
            h('span', { innerHTML: ctx.renderRichText(st.text) })
          ];
          if (stRev) {
            textChildren.push(
              h('span', { class: `badge ml-1 ${stRes?.isCorrect ? 'badge-success' : 'badge-error'}` }, `Đáp án: ${st.is_true ? 'Đúng' : 'Sai'}`)
            );
          }
          return h('div', {
            key: stIdx,
            class: stCls ? `statement-row ${stCls}` : 'statement-row'
          }, [
            h('div', { class: 'flex-1 basis-[240px] text-slate-900' }, textChildren),
            h('div', { class: 'inline-flex gap-2' }, [
              h('button', {
                type: 'button',
                class: 'tf-btn',
                'aria-pressed': tfPick === true,
                disabled: stRev,
                onPointerdown: (e) => ctx.onTfBtnPointerDown(e, sIdx, qIdx, stIdx, true, subIdx),
                onClick: () => ctx.setTfPick(sIdx, qIdx, stIdx, true, subIdx)
              }, 'Đúng'),
              h('button', {
                type: 'button',
                class: 'tf-btn',
                'aria-pressed': tfPick === false,
                disabled: stRev,
                onPointerdown: (e) => ctx.onTfBtnPointerDown(e, sIdx, qIdx, stIdx, false, subIdx),
                onClick: () => ctx.setTfPick(sIdx, qIdx, stIdx, false, subIdx)
              }, 'Sai')
            ])
          ]);
        });
        children.push(h('div', { class: 'quiz-statements-stack' }, stNodes));
      } else if (q.type === 'short_answer') {
        const shortCls = detail ? (detail.isFullCorrect ? 'input-correct' : 'input-wrong') : '';
        const inputRow = [
          h('input', {
            type: 'text',
            class: shortCls
              ? `short-input field-control flex-1 min-w-[180px] max-w-[380px] text-base bg-white border-slate-400 ${shortCls}`
              : 'short-input field-control flex-1 min-w-[180px] max-w-[380px] text-base bg-white border-slate-400',
            value: typeof picked === 'string' ? picked : '',
            placeholder: 'Nhập câu trả lời...',
            'aria-label': `Đáp án câu ${num}`,
            disabled: locked,
            onInput: (e) => {
              ctx.userAnswers.value[id] = e.target.value;
            },
            onKeydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                ctx.checkShortAnswerTurbo(sIdx, qIdx, subIdx);
              }
            }
          })
        ];
        if (turboMode && !locked) {
          inputRow.push(
            h('button', {
              type: 'button',
              class: 'btn btn-primary btn-sm shrink-0',
              'data-action': 'check-short',
              onClick: () => ctx.checkShortAnswerTurbo(sIdx, qIdx, subIdx)
            }, 'Kiểm tra')
          );
        }
        children.push(h('div', { class: 'flex flex-wrap items-center gap-2' }, inputRow));
        if (revealed) {
          children.push(
            h('div', { class: 'mt-2.5 text-sm font-semibold' }, `Đáp án chấp nhận: ${(q.accepted_answers || []).join(' | ')}`)
          );
        }
      }

      if (revealed && q.explanation) {
        children.push(
          h('div', { class: 'mt-2.5 px-3 py-2.5 rounded-md bg-slate-200 text-slate-700 text-sm whitespace-normal' }, [
            h('strong', null, 'Giải thích:'),
            ' ',
            h('span', { innerHTML: ctx.renderRichText(q.explanation) })
          ])
        );
      }

      const baseClass = isSub ? 'question-card group-subquestion-card' : 'question-card';
      return h('article', {
        id: `qcard_${id}`,
        class: cardState ? `${baseClass} ${cardState}` : baseClass
      }, children);
    };
  }
});

createApp({
  components: {
    QuizProgressText,
    QuizNavCell,
    QuizLeafQuestion
  },
  setup() {
    const view = ref('list');
    const exams = ref([]);
    const savedFolders = ref([]);
    const homeTab = ref('browse');
    const currentFolderPath = ref('');
    const contextMenu = ref(null);
    const folderModal = ref(null);
    const moveModal = ref(null);
    const deleteFolderModal = ref(null);
    const searchQuery = ref('');
    const selectedFolder = ref('ALL');
    const sortBy = ref('recent');
    const pendingDeleteId = ref(null);
    const editingId = ref(null);
    const editorTitle = ref('');
    const editorFolder = ref('');
    const editorTimeLimit = ref('');
    const yamlText = ref('');
    const validatedData = ref(null);
    const editorErrors = ref([]);
    const canSaveExam = ref(false);
    const monacoReady = ref(false);
    const richTextReady = ref(false);
    const editorLeftPanel = ref('edit');
    const expandedReorderGroups = ref({});
    const showEditorJumpMenu = ref(false);
    const showEditorExitConfirm = ref(false);
    const copyLabel = ref('Copy Prompt AI');
    const previewPaneRef = ref(null);
    const toast = ref(null);
    const serverConnected = ref(false);

    const activeExam = shallowRef(null);
    const activeExamId = ref(null);
    const userAnswers = ref({});
    const gradeResult = shallowRef(null);
    const showSubmitConfirm = ref(false);
    const pendingUnanswered = ref(0);
    const showExitQuizConfirm = ref(false);
    const pendingResumeQuiz = ref(null);
    const savedProgressMap = ref({});

    function readTurboModePref() {
      try {
        return localStorage.getItem(TURBO_PREF_KEY) === '1';
      } catch {
        return false;
      }
    }

    const turboModePref = ref(readTurboModePref());
    const quizTurboMode = ref(false);
    const turboChecked = ref({});
    const quizRenderEpoch = ref(0);

    function toggleTurboModePref() {
      const next = !turboModePref.value;
      turboModePref.value = next;
      try {
        localStorage.setItem(TURBO_PREF_KEY, next ? '1' : '0');
      } catch {
        // Ignore storage errors
      }
    }

    const quizTimerLimit = ref(0);
    const quizTimerDisplayRef = ref(null);
    const quizElapsedDisplay = ref('00:00');
    const quizElapsedSeconds = ref(0);
    const quizTimerPaused = ref(false);
    const quizTimerStatus = ref('stopwatch');
    const quizTimerMode = ref('stopwatch');
    const quizAutoSubmitted = ref(false);
    const quizSubmittedAt = ref(null);

    let latestTimerSnap = {
      display: '00:00',
      elapsedDisplay: '00:00',
      elapsedSeconds: 0,
      paused: false,
      status: 'stopwatch',
      mode: 'stopwatch'
    };

    const quizHistory = ref([]);
    const userProfile = ref({ displayName: 'Học sinh' });
    const analyticsReady = ref(false);
    const profileTab = ref('diligence');
    const initNow = new Date();
    const heatmapYear = ref(initNow.getFullYear());
    const calendarYear = ref(initNow.getFullYear());
    const calendarMonth = ref(initNow.getMonth());
    const selectedWeekIndex = ref(0);
    const historyRangeFilter = ref('all');
    const historySubjectFilter = ref('ALL');
    const isReviewingHistory = ref(false);
    const deleteHistoryModal = ref(null);

    const parseCardCache = new Map();

    let cachedAnalytics = null;
    let analyticsLoadPromise = null;
    let monacoEditor = null;
    let monacoMountToken = 0;
    let isSyncingFromPreview = false;
    let yamlDebounceTimer = null;
    let previewSyncTimer = null;
    let copyResetTimer = null;
    let toastTimer = null;
    let lastServerVersion = -1;
    let serverSyncTimer = null;
    let syncMutationEpoch = 0;
    let activeMutationCount = 0;
    let monacoCursorDisposable = null;
    let yamlLineIndex = createYamlLineIndex('');
    let lastLeftJumpKey = '';
    let lastLeftJumpAt = 0;
    let lastRightJumpKey = '';
    let leftHighlightTimer = null;
    let lastHighlightedEl = null;
    let monacoJumpDecorationIds = [];
    let monacoHighlightTimer = null;
    let sortableInstances = [];
    let sortableInitToken = 0;
    let exitConfirmAutoPaused = false;
    let editorCleanSnapshot = null;
    let turboDetailsCache = Object.create(null);
    let canonicalQuizExam = null;
    let lastMouseOptionHandledKey = '';
    let lastMouseOptionHandledAt = 0;
    let hasOpenContextMenu = false;

    function syncQuizTimerDom() {
      const el = quizTimerDisplayRef.value;
      if (el && el.textContent !== latestTimerSnap.display) {
        el.textContent = latestTimerSnap.display;
      }
    }

    watch(quizTimerDisplayRef, (el) => {
      if (el && el.textContent !== latestTimerSnap.display) {
        el.textContent = latestTimerSnap.display;
      }
    }, { flush: 'post' });

    function applyTimerSnap(snap, { syncFinal = false } = {}) {
      if (!snap) return;
      latestTimerSnap = snap;
      syncQuizTimerDom();
      if (quizTimerPaused.value !== snap.paused) {
        quizTimerPaused.value = snap.paused;
      }
      if (quizTimerStatus.value !== snap.status) {
        quizTimerStatus.value = snap.status;
      }
      if (quizTimerMode.value !== snap.mode) {
        quizTimerMode.value = snap.mode;
      }
      if (syncFinal) {
        if (quizElapsedDisplay.value !== snap.elapsedDisplay) {
          quizElapsedDisplay.value = snap.elapsedDisplay;
        }
        if (quizElapsedSeconds.value !== snap.elapsedSeconds) {
          quizElapsedSeconds.value = snap.elapsedSeconds;
        }
      }
    }

    const quizTimer = createQuizTimer({
      onTick: applyTimerSnap,
      onExpire: () => {
        if (view.value === 'quiz' && !gradeResult.value) {
          finalizeSubmit({ autoSubmitted: true });
        }
      }
    });

    function triggerRichTextLoad() {
      if (richTextReady.value) return;
      ensureRichTextReady().then((ok) => {
        if (ok) richTextReady.value = true;
      });
    }

    function renderRichTextReactive(str) {
      void richTextReady.value;
      return renderRichText(str);
    }

    function renderRichPreviewHtmlReactive(str, placeholder) {
      void richTextReady.value;
      return renderRichPreviewHtml(str, placeholder);
    }

    function showToast(message, type = 'success', duration = 3000) {
      toast.value = { message, type };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.value = null;
      }, duration);
    }

    function sanitizeProgressEntry(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (!entry.userAnswers || typeof entry.userAnswers !== 'object' || Array.isArray(entry.userAnswers)) {
        return null;
      }
      const rawElapsed = Number(entry.elapsedSeconds);
      const elapsedSeconds = Number.isFinite(rawElapsed) ? Math.max(0, Math.floor(rawElapsed)) : 0;
      const rawLimit = Number(entry.limitMinutes);
      const limitMinutes = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 600
        ? Math.floor(rawLimit)
        : 0;
      const rawUpdatedAt = Number(entry.updatedAt);
      const updatedAt = Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now();
      const sanitizedTurboChecked = {};
      if (entry.turboChecked && typeof entry.turboChecked === 'object' && !Array.isArray(entry.turboChecked)) {
        for (const [key, val] of Object.entries(entry.turboChecked)) {
          if (val === true && key !== '__proto__') {
            sanitizedTurboChecked[key] = true;
          }
        }
      }
      let sanitizedShuffleOrder = null;
      if (Array.isArray(entry.shuffleOrder) && entry.shuffleOrder.length > 0) {
        const isValidOrder = entry.shuffleOrder.every(
          (secOrder) => Array.isArray(secOrder) && secOrder.every((n) => Number.isInteger(n) && n >= 0)
        );
        if (isValidOrder) {
          sanitizedShuffleOrder = entry.shuffleOrder.map((secOrder) => secOrder.slice());
        }
      }
      return {
        userAnswers: JSON.parse(JSON.stringify(entry.userAnswers)),
        elapsedSeconds,
        limitMinutes,
        turboMode: Boolean(entry.turboMode),
        turboChecked: sanitizedTurboChecked,
        shuffleOrder: sanitizedShuffleOrder,
        updatedAt
      };
    }

    function persistProgressMap() {
      try {
        localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(savedProgressMap.value));
      } catch {
        // Ignore storage errors
      }
    }

    function loadSavedProgress() {
      try {
        const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
        if (!raw) {
          savedProgressMap.value = {};
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          savedProgressMap.value = {};
          return;
        }
        const validIds = new Set(exams.value.map((e) => e.id));
        const cleaned = {};
        for (const [id, entry] of Object.entries(parsed)) {
          if (!validIds.has(id)) continue;
          const sanitized = sanitizeProgressEntry(entry);
          if (sanitized) cleaned[id] = sanitized;
        }
        const nextJson = JSON.stringify(cleaned);
        if (JSON.stringify(savedProgressMap.value) !== nextJson) {
          savedProgressMap.value = cleaned;
        }
      } catch {
        if (Object.keys(savedProgressMap.value).length > 0) {
          savedProgressMap.value = {};
        }
      }
    }

    function clearSavedProgress(examId) {
      if (!examId || !Object.prototype.hasOwnProperty.call(savedProgressMap.value, examId)) return;
      const next = { ...savedProgressMap.value };
      delete next[examId];
      savedProgressMap.value = next;
      persistProgressMap();
    }

    function saveActiveQuizProgress() {
      if (!activeExamId.value || !activeExam.value || gradeResult.value !== null) return false;
      const snap = quizTimer.getSnapshot();
      const savedTurboChecked = {};
      if (quizTurboMode.value && turboChecked.value && typeof turboChecked.value === 'object') {
        for (const [key, val] of Object.entries(turboChecked.value)) {
          if (val === true && key !== '__proto__') {
            savedTurboChecked[key] = true;
          }
        }
      }
      const shuffleOrder = getShuffleOrder(activeExam.value);
      const payload = {
        userAnswers: JSON.parse(JSON.stringify(userAnswers.value)),
        elapsedSeconds: snap.elapsedSeconds,
        limitMinutes: quizTimerLimit.value,
        turboMode: Boolean(quizTurboMode.value),
        turboChecked: savedTurboChecked,
        shuffleOrder: shuffleOrder || null,
        updatedAt: Date.now()
      };
      savedProgressMap.value = {
        ...savedProgressMap.value,
        [activeExamId.value]: payload
      };
      persistProgressMap();
      return true;
    }

    function persistSavedFolders() {
      try {
        localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(savedFolders.value));
      } catch {
        // Ignore storage errors
      }
    }

    function loadSavedFolders() {
      try {
        const raw = localStorage.getItem(FOLDERS_STORAGE_KEY);
        if (!raw) {
          savedFolders.value = [];
          return;
        }
        savedFolders.value = sanitizeFoldersArray(JSON.parse(raw));
      } catch {
        savedFolders.value = [];
      }
    }

    function areStringArraysEqual(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    function applyServerExamsSnapshot(serverExams, serverFolders = null) {
      const normalized = Array.isArray(serverExams)
        ? serverExams.map((item) => ({ ...item, pinned: Boolean(item?.pinned) }))
        : [];
      if (view.value === 'editor' && editingId.value) {
        const currentEditing = exams.value.find((e) => e.id === editingId.value);
        const hasInServer = normalized.some((e) => e.id === editingId.value);
        if (currentEditing && hasInServer) {
          exams.value = normalized.map((e) => (e.id === editingId.value ? currentEditing : e));
        } else {
          exams.value = normalized;
        }
      } else {
        exams.value = normalized;
      }
      if (Array.isArray(serverFolders)) {
        const nextFolders = sanitizeFoldersArray(serverFolders);
        if (!areStringArraysEqual(savedFolders.value, nextFolders)) {
          savedFolders.value = nextFolders;
          persistSavedFolders();
        }
      }
      persistExams();
      loadSavedProgress();
    }

    async function syncExamsFromServer({ notify = false } = {}) {
      if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
      if (activeMutationCount > 0) return;
      const epoch = syncMutationEpoch;
      try {
        const url = lastServerVersion !== -1
          ? `/api/exams?since=${encodeURIComponent(lastServerVersion)}`
          : '/api/exams';
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (activeMutationCount > 0 || epoch !== syncMutationEpoch) return;
        if (!serverConnected.value) serverConnected.value = true;
        const version = Number(data?.version ?? 0);
        if (data?.unchanged === true || (lastServerVersion !== -1 && version === lastServerVersion)) {
          return;
        }
        const serverExams = Array.isArray(data?.exams) ? data.exams : [];
        const serverFolders = Array.isArray(data?.folders) ? sanitizeFoldersArray(data.folders) : [];

        if (
          version === 0 &&
          serverExams.length === 0 &&
          serverFolders.length === 0 &&
          (exams.value.length > 0 || savedFolders.value.length > 0)
        ) {
          activeMutationCount++;
          const mutEpoch = ++syncMutationEpoch;
          try {
            if (exams.value.length > 0) {
              const pushResp = await fetch('/api/exams', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exams: exams.value })
              });
              if (pushResp.ok) {
                const pushed = await pushResp.json();
                if (mutEpoch === syncMutationEpoch && typeof pushed?.version === 'number') {
                  lastServerVersion = pushed.version;
                }
              }
            }
            if (savedFolders.value.length > 0) {
              const fldResp = await fetch('/api/folders', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folders: savedFolders.value })
              });
              if (fldResp.ok) {
                const fldData = await fldResp.json();
                if (mutEpoch === syncMutationEpoch && typeof fldData?.version === 'number') {
                  lastServerVersion = fldData.version;
                }
              }
            }
          } finally {
            activeMutationCount--;
          }
          return;
        }

        if (version !== lastServerVersion) {
          const hadInitial = lastServerVersion !== -1;
          lastServerVersion = version;
          applyServerExamsSnapshot(serverExams, serverFolders);
          if (notify && hadInitial && view.value === 'list') {
            showToast('Đã đồng bộ danh sách đề mới từ Server', 'success', 2400);
          }
        }
      } catch {
        if (serverConnected.value) serverConnected.value = false;
      }
    }

    async function pushExamToServer(entry, { isNew = false } = {}) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      const epoch = ++syncMutationEpoch;
      try {
        const url = isNew ? '/api/exams' : `/api/exams/${encodeURIComponent(entry.id)}`;
        const resp = await fetch(url, {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry)
        });
        if (resp.ok) {
          const data = await resp.json();
          if (epoch === syncMutationEpoch && typeof data?.version === 'number') {
            lastServerVersion = data.version;
          }
        }
      } catch {
        // Keep localStorage fallback
      } finally {
        activeMutationCount--;
      }
    }

    async function saveExamsBatchToServer(nextExams = exams.value) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      const epoch = ++syncMutationEpoch;
      try {
        const resp = await fetch('/api/exams', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exams: nextExams })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (epoch === syncMutationEpoch && typeof data?.version === 'number') {
            lastServerVersion = data.version;
          }
        }
      } catch {
        // Keep localStorage fallback
      } finally {
        activeMutationCount--;
      }
    }

    async function pushFoldersToServer(foldersList = savedFolders.value) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      const epoch = ++syncMutationEpoch;
      try {
        const resp = await fetch('/api/folders', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folders: sanitizeFoldersArray(foldersList) })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (epoch === syncMutationEpoch && typeof data?.version === 'number') {
            lastServerVersion = data.version;
          }
        }
      } catch {
        // Keep localStorage fallback
      } finally {
        activeMutationCount--;
      }
    }

    async function persistFoldersAndExamsToServer({ examsChanged = false, foldersChanged = false } = {}) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      try {
        if (examsChanged) {
          await saveExamsBatchToServer(exams.value);
        }
        if (foldersChanged) {
          await pushFoldersToServer(savedFolders.value);
        }
      } finally {
        activeMutationCount--;
      }
    }

    async function deleteExamOnServer(id) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      const epoch = ++syncMutationEpoch;
      try {
        const resp = await fetch(`/api/exams/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (resp.ok) {
          const data = await resp.json();
          if (epoch === syncMutationEpoch && typeof data?.version === 'number') {
            lastServerVersion = data.version;
          }
        }
      } catch {
        // Keep localStorage fallback
      } finally {
        activeMutationCount--;
      }
    }

    async function togglePinOnServer(id) {
      if (!serverConnected.value) return;
      activeMutationCount++;
      const epoch = ++syncMutationEpoch;
      try {
        const resp = await fetch(`/api/exams/${encodeURIComponent(id)}/pin`, { method: 'POST' });
        if (resp.ok) {
          const data = await resp.json();
          if (epoch === syncMutationEpoch && typeof data?.version === 'number') {
            lastServerVersion = data.version;
          }
        }
      } catch {
        // Keep localStorage fallback
      } finally {
        activeMutationCount--;
      }
    }

    function stopServerSyncInterval() {
      if (serverSyncTimer !== null) {
        clearInterval(serverSyncTimer);
        serverSyncTimer = null;
      }
    }

    function startServerSyncInterval() {
      if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
      if (document.hidden || serverSyncTimer !== null) return;
      serverSyncTimer = setInterval(() => {
        if (!document.hidden && view.value !== 'quiz') {
          syncExamsFromServer({ notify: true });
        }
      }, 2500);
    }

    function onDocumentVisibilityChange() {
      if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
      if (document.hidden) {
        stopServerSyncInterval();
      } else {
        if (view.value !== 'quiz') {
          syncExamsFromServer({ notify: true });
        }
        startServerSyncInterval();
      }
    }

    function startServerPolling() {
      if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
      syncExamsFromServer({ notify: false });
      stopServerSyncInterval();
      if (!document.hidden) {
        startServerSyncInterval();
      }
    }

    function loadExams() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) {
          const seed = [{ id: 'sample-1', rawYaml: SAMPLE_YAML, updatedAt: Date.now(), pinned: false }];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
          exams.value = seed;
        } else {
          const parsed = JSON.parse(raw);
          exams.value = Array.isArray(parsed)
            ? parsed.map((item) => ({ ...item, pinned: Boolean(item?.pinned) }))
            : [];
          const idx = exams.value.findIndex((e) => e.id === 'sample-1');
          if (idx !== -1 && exams.value[idx].rawYaml) {
            const cur = exams.value[idx].rawYaml;
            if (cur.includes('Cho hàm số y = 2x + 1') || (cur.includes('Cho hàm số $f(x) = \\frac{2x + 1}{x - 1}$') && !cur.includes('| Nhóm |'))) {
              exams.value[idx].rawYaml = SAMPLE_YAML;
              localStorage.setItem(STORAGE_KEY, JSON.stringify(exams.value));
            }
          }
        }
      } catch {
        exams.value = [];
      }
      loadSavedFolders();
      loadSavedProgress();
      loadHistoryAndProfile();
    }

    function sanitizeHistoryEntry(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const submittedAt = Number(item.submittedAt);
      if (!Number.isFinite(submittedAt) || submittedAt <= 0) return null;
      return {
        id: String(item.id || `att-${submittedAt}`),
        examId: String(item.examId || ''),
        examTitle: String(item.examTitle || 'Đề ôn tập'),
        subject: String(item.subject || '').trim(),
        scale10: Number(Number(item.scale10 || 0).toFixed(2)),
        rawPoints: Number(Number(item.rawPoints || 0).toFixed(2)),
        fullCorrectCount: Math.max(0, Math.floor(Number(item.fullCorrectCount) || 0)),
        totalQuestions: Math.max(1, Math.floor(Number(item.totalQuestions) || 1)),
        elapsedSeconds: Math.max(0, Math.floor(Number(item.elapsedSeconds) || 0)),
        limitMinutes: Math.max(0, Math.floor(Number(item.limitMinutes) || 0)),
        autoSubmitted: Boolean(item.autoSubmitted),
        submittedAt,
        userAnswers: item.userAnswers && typeof item.userAnswers === 'object' && !Array.isArray(item.userAnswers)
          ? item.userAnswers
          : {}
      };
    }

    function loadHistoryAndProfile() {
      try {
        const rawHist = localStorage.getItem(HISTORY_STORAGE_KEY);
        if (rawHist) {
          const parsed = JSON.parse(rawHist);
          if (Array.isArray(parsed)) {
            quizHistory.value = parsed
              .map(sanitizeHistoryEntry)
              .filter(Boolean)
              .sort((a, b) => b.submittedAt - a.submittedAt)
              .slice(0, MAX_HISTORY_ENTRIES);
          }
        }
      } catch {
        quizHistory.value = [];
      }

      try {
        const rawProf = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (rawProf) {
          const parsed = JSON.parse(rawProf);
          if (parsed && typeof parsed.displayName === 'string' && parsed.displayName.trim()) {
            userProfile.value = { displayName: parsed.displayName.trim() };
          }
        }
      } catch {
        // Keep default displayName
      }
    }

    function persistQuizHistory() {
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(quizHistory.value));
      } catch {
        // Ignore storage errors
      }
    }

    function saveProfileName() {
      const name = String(userProfile.value.displayName || '').trim() || 'Học sinh';
      userProfile.value.displayName = name;
      try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(userProfile.value));
      } catch {
        // Ignore storage errors
      }
    }

    async function ensureAnalyticsLoaded() {
      if (cachedAnalytics) {
        analyticsReady.value = true;
        return cachedAnalytics;
      }
      if (!analyticsLoadPromise) {
        analyticsLoadPromise = import('./analytics.js')
          .then((mod) => {
            cachedAnalytics = mod;
            analyticsReady.value = true;
            return mod;
          })
          .catch((err) => {
            analyticsLoadPromise = null;
            console.warn('Không thể tải analytics.js:', err);
            return null;
          });
      }
      return analyticsLoadPromise;
    }

    function localDayKeyFast(ts) {
      const d = new Date(Number(ts));
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const headerCurrentStreak = computed(() => {
      if (quizHistory.value.length === 0) return 0;
      const set = new Set();
      quizHistory.value.forEach((h) => {
        const k = localDayKeyFast(h.submittedAt);
        if (k) set.add(k);
      });
      const stepDay = (key, delta) => {
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(y, m - 1, d + delta, 12, 0, 0);
        return localDayKeyFast(dt.getTime());
      };
      const today = localDayKeyFast(Date.now());
      const yesterday = stepDay(today, -1);
      let cur = set.has(today) ? today : set.has(yesterday) ? yesterday : '';
      let streak = 0;
      while (cur && set.has(cur)) {
        streak++;
        cur = stepDay(cur, -1);
      }
      return streak;
    });

    const profileKpis = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) {
        return { totalAttempts: 0, avgScore: 0, bestScore: 0, totalSeconds: 0, totalDurationText: '0p', currentStreak: 0, bestStreak: 0, activeDaysCount: 0 };
      }
      return cachedAnalytics.computeOverallKpis(quizHistory.value);
    });

    const subjectAverages = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) return [];
      return cachedAnalytics.computeSubjectAverages(quizHistory.value);
    });

    const yearHeatmap = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) {
        return { year: heatmapYear.value, totalDaysInYear: 365, activeDaysInYear: 0, weeks: [], monthLabels: [], availableYears: [heatmapYear.value] };
      }
      return cachedAnalytics.buildYearHeatmap(quizHistory.value, heatmapYear.value);
    });

    const monthCalendar = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) {
        return { year: calendarYear.value, monthIndex: calendarMonth.value, monthLabel: '', weeks: [], defaultWeekIndex: 0 };
      }
      return cachedAnalytics.buildMonthCalendarWeeks(calendarYear.value, calendarMonth.value, quizHistory.value);
    });

    const weeklyBreakdown = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) {
        return { rangeLabel: '', days: [], subjectRows: [], weekTotalAttempts: 0, weekTotalSeconds: 0, weekTotalDurationText: '0p', avgDailyDurationText: '0p/ngày' };
      }
      const weeks = monthCalendar.value.weeks || [];
      const row = weeks[selectedWeekIndex.value] || weeks[0] || null;
      return cachedAnalytics.buildWeeklyBreakdown(row, quizHistory.value, PRESET_FOLDERS);
    });

    const historySubjectOptions = computed(() => {
      const set = new Set();
      quizHistory.value.forEach((h) => set.add(getSubjectFromFolder(h.subject) || 'Chưa phân loại'));
      return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
    });

    const filteredHistoryList = computed(() => {
      if (!analyticsReady.value || !cachedAnalytics) return [];
      return cachedAnalytics.filterHistory(quizHistory.value, {
        range: historyRangeFilter.value,
        subject: historySubjectFilter.value
      });
    });

    function formatAttemptDuration(sec) {
      if (cachedAnalytics) return cachedAnalytics.formatCompactDuration(sec);
      return formatDuration(sec);
    }

    function formatAttemptTime(ts) {
      if (cachedAnalytics) return cachedAnalytics.formatSubmittedAt(ts).replace(' ', '\n');
      return '';
    }

    async function openProfile(initialTab) {
      clearPreviewSyncTimer();
      clearTimeout(yamlDebounceTimer);
      disposeMonaco();
      destroySortables();
      quizTimer.stop();
      pendingDeleteId.value = null;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      showEditorExitConfirm.value = false;
      editorCleanSnapshot = null;
      quizSubmittedAt.value = null;
      exitConfirmAutoPaused = false;
      pendingResumeQuiz.value = null;
      isReviewingHistory.value = false;
      quizTurboMode.value = false;
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      canonicalQuizExam = null;
      editorLeftPanel.value = 'edit';
      if (initialTab === 'stats' || initialTab === 'diligence') {
        profileTab.value = initialTab;
      }
      view.value = 'profile';
      window.scrollTo(0, 0);
      await ensureAnalyticsLoaded();
      selectedWeekIndex.value = monthCalendar.value.defaultWeekIndex || 0;
    }

    function shiftCalendarMonth(delta) {
      const d = new Date(calendarYear.value, calendarMonth.value + Number(delta || 0), 1, 12, 0, 0);
      calendarYear.value = d.getFullYear();
      calendarMonth.value = d.getMonth();
      selectedWeekIndex.value = monthCalendar.value.defaultWeekIndex || 0;
    }

    function selectCalendarWeek(idx) {
      selectedWeekIndex.value = Number(idx) || 0;
    }

    function setHeatmapYear(yr) {
      heatmapYear.value = Number(yr) || new Date().getFullYear();
    }

    function filterHistoryBySubject(subject) {
      historySubjectFilter.value = subject || 'ALL';
      profileTab.value = 'stats';
    }

    function reviewHistoryAttempt(attempt) {
      if (!attempt) return;
      const found = exams.value.find((e) => e.id === attempt.examId);
      if (!found) {
        showToast('Đề gốc đã bị xóa nên không thể xem lại chi tiết câu hỏi.', 'error');
        return;
      }
      const parsed = parseExamYaml(found.rawYaml);
      if (!parsed.ok) {
        showToast('Đề gốc đang bị lỗi định dạng YAML.', 'error');
        return;
      }
      triggerRichTextLoad();
      quizTimer.stop();
      isReviewingHistory.value = true;
      quizTurboMode.value = false;
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      activeExamId.value = found.id;
      const taggedExam = tagCanonicalIndices(parsed.data);
      canonicalQuizExam = taggedExam;
      activeExam.value = taggedExam;
      userAnswers.value = JSON.parse(JSON.stringify(attempt.userAnswers || {}));
      gradeResult.value = gradeExam(parsed.data, userAnswers.value);
      quizRenderEpoch.value++;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      exitConfirmAutoPaused = false;
      quizAutoSubmitted.value = Boolean(attempt.autoSubmitted);
      quizSubmittedAt.value = attempt.submittedAt || null;
      quizTimerLimit.value = attempt.limitMinutes || parsed.data.meta.time_limit || 0;
      const elapsedSec = attempt.elapsedSeconds || 0;
      const elapsedDisp = formatDuration(elapsedSec);
      applyTimerSnap({
        display: elapsedDisp,
        elapsedDisplay: elapsedDisp,
        elapsedSeconds: elapsedSec,
        paused: false,
        status: 'normal',
        mode: quizTimerLimit.value > 0 ? 'countdown' : 'stopwatch'
      }, { syncFinal: true });
      view.value = 'quiz';
      window.scrollTo(0, 0);
    }

    function retryHistoryAttempt(attempt) {
      if (!attempt) return;
      const found = exams.value.find((e) => e.id === attempt.examId);
      if (!found) {
        showToast('Đề này không còn trong danh sách.', 'error');
        return;
      }
      isReviewingHistory.value = false;
      startQuiz(found.id);
    }

    function exportHistoryAttempt(attempt) {
      if (!attempt) return;
      const found = exams.value.find((e) => e.id === attempt.examId);
      if (!found) {
        showToast('Đề gốc đã bị xóa nên không thể xuất chi tiết câu hỏi.', 'error');
        return;
      }
      const parsed = parseExamYaml(found.rawYaml);
      if (!parsed.ok) {
        showToast('Đề gốc đang bị lỗi định dạng YAML.', 'error');
        return;
      }
      try {
        const answers = attempt.userAnswers && typeof attempt.userAnswers === 'object'
          ? attempt.userAnswers
          : {};
        const graded = gradeExam(parsed.data, answers);
        downloadAttemptExport({
          exam: parsed.data,
          userAnswers: answers,
          gradeResult: graded,
          elapsedSeconds: attempt.elapsedSeconds || 0,
          limitMinutes: attempt.limitMinutes || parsed.data.meta.time_limit || 0,
          submittedAt: attempt.submittedAt || Date.now(),
          autoSubmitted: Boolean(attempt.autoSubmitted)
        });
        showToast('Đã xuất file bài làm (.md)', 'success');
      } catch (err) {
        console.error('Lỗi khi xuất bài làm từ lịch sử:', err);
        showToast('Không thể xuất file bài làm.', 'error');
      }
    }

    function requestDeleteHistoryAttempt(attempt) {
      if (!attempt) return;
      deleteHistoryModal.value = { mode: 'single', attempt };
    }

    function requestClearFilteredHistory() {
      const list = filteredHistoryList.value;
      if (!list.length) return;
      const isAll = historySubjectFilter.value === 'ALL' && historyRangeFilter.value === 'all';
      deleteHistoryModal.value = {
        mode: 'filtered',
        count: list.length,
        ids: list.map((a) => a.id),
        isAll
      };
    }

    function confirmDeleteHistory() {
      const modal = deleteHistoryModal.value;
      if (!modal) return;
      if (modal.mode === 'single') {
        quizHistory.value = quizHistory.value.filter((h) => h.id !== modal.attempt.id);
        persistQuizHistory();
        showToast('Đã xóa 1 lượt làm bài khỏi lịch sử.');
      } else {
        const idSet = new Set(modal.ids);
        const before = quizHistory.value.length;
        quizHistory.value = quizHistory.value.filter((h) => !idSet.has(h.id));
        const removed = before - quizHistory.value.length;
        persistQuizHistory();
        showToast(`Đã xóa ${removed} lượt làm bài khỏi lịch sử.`);
      }
      if (historySubjectFilter.value !== 'ALL' && !historySubjectOptions.value.includes(historySubjectFilter.value)) {
        historySubjectFilter.value = 'ALL';
      }
      deleteHistoryModal.value = null;
    }

    function persistExams() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(exams.value));
    }

    const examCards = computed(() => {
      const activeKeys = new Set();
      const cards = exams.value.map((item) => {
        const rawKey = typeof item.rawYaml === 'string' ? item.rawYaml : String(item.rawYaml ?? '');
        activeKeys.add(rawKey);

        let summary = parseCardCache.get(rawKey);
        if (!summary) {
          const parsed = parseExamYaml(rawKey);
          if (!parsed.ok) {
            summary = { ok: false, title: '', folder: '', timeLimit: null };
          } else {
            const stats = countExamStats(parsed.data);
            const folder = normalizeFolderPath(parsed.data.meta.folder || '');
            const timeLimit = parsed.data.meta.time_limit || null;
            const breakdown = [
              stats.mc ? `${stats.mc} TN` : '',
              stats.tf ? `${stats.tf} ĐS` : '',
              stats.sa ? `${stats.sa} TLN` : ''
            ].filter(Boolean).join(' · ');
            summary = {
              ok: true,
              title: parsed.data.meta.title,
              folder,
              timeLimit,
              stats,
              breakdown
            };
          }
          parseCardCache.set(rawKey, summary);
        }

        const saved = savedProgressMap.value[item.id];
        return {
          id: item.id,
          pinned: Boolean(item.pinned),
          updatedAt: Number(item.updatedAt) || 0,
          ...summary,
          hasSavedProgress: Boolean(saved && summary.ok),
          savedElapsedDisplay: saved ? formatDuration(saved.elapsedSeconds) : ''
        };
      });

      for (const key of parseCardCache.keys()) {
        if (!activeKeys.has(key)) {
          parseCardCache.delete(key);
        }
      }

      return cards;
    });

    const allFolderPaths = computed(() => {
      const set = new Set();
      savedFolders.value.forEach((p) => {
        collectAncestors(p).forEach((anc) => set.add(anc));
      });
      examCards.value.forEach((card) => {
        if (card.ok && card.folder) {
          collectAncestors(card.folder).forEach((anc) => set.add(anc));
        }
      });
      return Array.from(set).sort(compareFolderPathsVi);
    });

    watch(allFolderPaths, (paths) => {
      const cur = normalizeFolderPath(currentFolderPath.value);
      if (!cur) return;
      const set = new Set(paths);
      let candidate = cur;
      while (candidate && !set.has(candidate)) {
        candidate = getParentFolderPath(candidate);
      }
      if (candidate !== currentFolderPath.value) {
        currentFolderPath.value = candidate;
      }
    });

    const breadcrumbSegments = computed(() => {
      const segs = [{ label: 'Môn học', path: '' }];
      const norm = normalizeFolderPath(currentFolderPath.value);
      if (!norm) return segs;
      const parts = norm.split('/');
      for (let i = 0; i < parts.length; i++) {
        segs.push({
          label: parts[i],
          path: parts.slice(0, i + 1).join('/')
        });
      }
      return segs;
    });

    const subjectGpaMap = computed(() => {
      const buckets = new Map();
      quizHistory.value.forEach((h) => {
        const subj = getSubjectFromFolder(h?.subject);
        if (!subj) return;
        const sc = Number(h?.scale10) || 0;
        let rec = buckets.get(subj);
        if (!rec) {
          rec = { sum: 0, count: 0 };
          buckets.set(subj, rec);
        }
        rec.sum += sc;
        rec.count++;
      });
      const out = {};
      buckets.forEach((rec, subj) => {
        out[subj] = Number((rec.sum / rec.count).toFixed(2));
      });
      return out;
    });

    function compareExamCards(a, b, { pinnedFirst = true } = {}) {
      if (pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sortBy.value === 'title') {
        return (a.title || '').localeCompare(b.title || '', 'vi') || (b.updatedAt - a.updatedAt);
      }
      if (sortBy.value === 'questions') {
        return (b.stats?.total || 0) - (a.stats?.total || 0) || (b.updatedAt - a.updatedAt);
      }
      return b.updatedAt - a.updatedAt;
    }

    const pinnedExamCards = computed(() => {
      const query = searchQuery.value.trim().toLowerCase();
      return examCards.value
        .filter((card) => {
          if (!card.pinned) return false;
          if (!query) return true;
          return (card.title || '').toLowerCase().includes(query) || (card.folder || '').toLowerCase().includes(query);
        })
        .slice()
        .sort((a, b) => compareExamCards(a, b, { pinnedFirst: false }));
    });

    const childFolders = computed(() => {
      const cur = normalizeFolderPath(currentFolderPath.value);
      const isSubject = cur === '';
      const direct = allFolderPaths.value.filter((p) => getParentFolderPath(p) === cur);
      return direct.map((path) => {
        const prefix = `${path}/`;
        let directExamCount = 0;
        let totalExamCount = 0;
        examCards.value.forEach((card) => {
          if (!card.ok) return;
          if (card.folder === path) {
            directExamCount++;
            totalExamCount++;
          } else if (card.folder.startsWith(prefix)) {
            totalExamCount++;
          }
        });
        let subfolderCount = 0;
        allFolderPaths.value.forEach((p) => {
          if (getParentFolderPath(p) === path) subfolderCount++;
        });
        const avgScore = (isSubject && Object.prototype.hasOwnProperty.call(subjectGpaMap.value, path))
          ? subjectGpaMap.value[path]
          : null;
        return {
          path,
          name: getFolderLeafName(path),
          isSubject,
          directExamCount,
          totalExamCount,
          subfolderCount,
          avgScore
        };
      });
    });

    const visibleExamCards = computed(() => {
      if (homeTab.value === 'pinned') {
        return pinnedExamCards.value;
      }
      const query = searchQuery.value.trim().toLowerCase();
      if (query) {
        return examCards.value
          .filter((card) => (
            (card.title || '').toLowerCase().includes(query) ||
            (card.folder || '').toLowerCase().includes(query)
          ))
          .slice()
          .sort((a, b) => compareExamCards(a, b, { pinnedFirst: true }));
      }
      const cur = normalizeFolderPath(currentFolderPath.value);
      return examCards.value
        .filter((card) => card.folder === cur)
        .slice()
        .sort((a, b) => compareExamCards(a, b, { pinnedFirst: true }));
    });

    const filteredExamCards = computed(() => visibleExamCards.value);

    const moveDestinationOptions = computed(() => {
      const modal = moveModal.value;
      if (!modal) return [];
      if (modal.type === 'exam') {
        return [
          { path: '', label: 'Chưa phân loại (Ngoài cùng)', depth: 0 },
          ...allFolderPaths.value.map((p) => ({
            path: p,
            label: getFolderLeafName(p),
            fullPath: p,
            depth: p.split('/').length - 1
          }))
        ];
      }
      if (modal.type === 'folder') {
        const oldPath = normalizeFolderPath(modal.oldPath);
        const oldPrefix = `${oldPath}/`;
        const validPaths = allFolderPaths.value.filter((p) => p !== oldPath && !p.startsWith(oldPrefix));
        return [
          { path: '', label: 'Cấp Môn học (Gốc)', depth: 0 },
          ...validPaths.map((p) => ({
            path: p,
            label: getFolderLeafName(p),
            fullPath: p,
            depth: p.split('/').length - 1
          }))
        ];
      }
      return [];
    });

    const availableFolders = computed(() => {
      const set = new Set([...PRESET_FOLDERS, ...allFolderPaths.value]);
      return Array.from(set).sort(compareFolderPathsVi);
    });

    function togglePinExam(id) {
      const idx = exams.value.findIndex((e) => e.id === id);
      if (idx === -1) return;
      exams.value[idx] = { ...exams.value[idx], pinned: !exams.value[idx].pinned };
      persistExams();
      togglePinOnServer(id);
    }

    function resetFilters() {
      searchQuery.value = '';
      selectedFolder.value = 'ALL';
    }

    function closeContextMenu() {
      hasOpenContextMenu = false;
      contextMenu.value = null;
    }

    function clampMenuPos(e) {
      const rawX = Number(e?.clientX);
      const rawY = Number(e?.clientY);
      const maxX = Math.max(8, window.innerWidth - 230);
      const maxY = Math.max(8, window.innerHeight - 250);
      return {
        x: Math.max(8, Math.min(Number.isFinite(rawX) ? rawX : 8, maxX)),
        y: Math.max(8, Math.min(Number.isFinite(rawY) ? rawY : 8, maxY))
      };
    }

    function openFolder(path) {
      homeTab.value = 'browse';
      currentFolderPath.value = normalizeFolderPath(path);
      searchQuery.value = '';
      closeContextMenu();
    }

    function openBlankContextMenu(e) {
      if (view.value !== 'list' || homeTab.value !== 'browse' || searchQuery.value.trim()) {
        closeContextMenu();
        return;
      }
      const pos = clampMenuPos(e);
      hasOpenContextMenu = true;
      contextMenu.value = { x: pos.x, y: pos.y, type: 'blank', target: null };
    }

    function openFolderContextMenu(e, folder) {
      if (view.value !== 'list' || !folder) return;
      const pos = clampMenuPos(e);
      hasOpenContextMenu = true;
      contextMenu.value = { x: pos.x, y: pos.y, type: 'folder', target: folder };
    }

    function openExamContextMenu(e, card) {
      if (view.value !== 'list' || !card) return;
      const pos = clampMenuPos(e);
      hasOpenContextMenu = true;
      contextMenu.value = { x: pos.x, y: pos.y, type: 'exam', target: card };
    }

    function openCreateFolderModal(parentPath = currentFolderPath.value) {
      const cleanParent = normalizeFolderPath(parentPath);
      closeContextMenu();
      folderModal.value = {
        mode: cleanParent === '' ? 'create-subject' : 'create-folder',
        parentPath: cleanParent,
        oldPath: '',
        name: ''
      };
      nextTick(() => {
        const input = document.getElementById('folder-name-input');
        if (input) {
          input.focus();
          input.select();
        }
      });
    }

    function openRenameFolderModal(folderPath) {
      const cleanOld = normalizeFolderPath(folderPath);
      if (!cleanOld) return;
      closeContextMenu();
      folderModal.value = {
        mode: 'rename',
        parentPath: getParentFolderPath(cleanOld),
        oldPath: cleanOld,
        name: getFolderLeafName(cleanOld)
      };
      nextTick(() => {
        const input = document.getElementById('folder-name-input');
        if (input) {
          input.focus();
          input.select();
        }
      });
    }

    function updateExamFolderYaml(examItem, newFolderPath) {
      return updateExamFolderYamlBase(examItem, newFolderPath, {
        parseExamYaml,
        serializeExamYaml,
        parseYaml,
        jsyaml
      });
    }

    function getParsedCardFolderMap() {
      const map = new Map();
      examCards.value.forEach((card) => {
        if (card.ok) map.set(card.id, card.folder);
      });
      return map;
    }

    function submitFolderModal() {
      const modal = folderModal.value;
      if (!modal) return;
      const rawName = String(modal.name ?? '').trim();
      if (!rawName) {
        showToast('Tên thư mục không được để trống', 'error');
        return;
      }
      if (rawName.includes('/')) {
        showToast('Tên thư mục không được chứa dấu "/"', 'error');
        return;
      }

      const parentPath = normalizeFolderPath(modal.parentPath);
      const newPath = parentPath ? `${parentPath}/${rawName}` : rawName;

      if (modal.mode === 'rename') {
        const oldPath = normalizeFolderPath(modal.oldPath);
        if (!oldPath) {
          folderModal.value = null;
          return;
        }
        if (newPath === oldPath) {
          folderModal.value = null;
          return;
        }
        if (allFolderPaths.value.includes(newPath)) {
          showToast('Tên này đã tồn tại trong thư mục hiện tại', 'error');
          return;
        }

        const oldPrefix = `${oldPath}/`;
        const rewritePath = (p) => {
          const norm = normalizeFolderPath(p);
          if (norm === oldPath) return newPath;
          if (norm.startsWith(oldPrefix)) return `${newPath}/${norm.slice(oldPrefix.length)}`;
          return norm;
        };

        const nextFolderSet = new Set();
        savedFolders.value.forEach((p) => {
          const mapped = rewritePath(p);
          if (mapped) nextFolderSet.add(mapped);
        });
        collectAncestors(newPath).forEach((anc) => nextFolderSet.add(anc));
        savedFolders.value = Array.from(nextFolderSet);
        persistSavedFolders();

        const cardFolderById = getParsedCardFolderMap();
        let examsChanged = false;
        exams.value = exams.value.map((item) => {
          const curFolder = cardFolderById.get(item.id) || '';
          if (curFolder === oldPath || curFolder.startsWith(oldPrefix)) {
            examsChanged = true;
            return updateExamFolderYaml(item, rewritePath(curFolder));
          }
          return item;
        });
        if (examsChanged) {
          persistExams();
        }

        const curPath = normalizeFolderPath(currentFolderPath.value);
        if (curPath === oldPath || curPath.startsWith(oldPrefix)) {
          currentFolderPath.value = rewritePath(curPath);
        }

        if (!oldPath.includes('/')) {
          let historyChanged = false;
          quizHistory.value = quizHistory.value.map((h) => {
            if (getSubjectFromFolder(h.subject) === oldPath) {
              historyChanged = true;
              return { ...h, subject: newPath };
            }
            return h;
          });
          if (historyChanged) {
            persistQuizHistory();
          }
        }

        folderModal.value = null;
        persistFoldersAndExamsToServer({ examsChanged, foldersChanged: true });
        showToast(`Đã đổi tên thành "${rawName}"`, 'success');
        return;
      }

      if (allFolderPaths.value.includes(newPath)) {
        showToast('Tên này đã tồn tại trong thư mục hiện tại', 'error');
        return;
      }

      const nextSet = new Set(savedFolders.value);
      collectAncestors(newPath).forEach((anc) => nextSet.add(anc));
      savedFolders.value = Array.from(nextSet);
      persistSavedFolders();
      folderModal.value = null;
      pushFoldersToServer(savedFolders.value);
      showToast(
        modal.mode === 'create-subject' ? `Đã tạo môn "${rawName}"` : `Đã tạo thư mục "${rawName}"`,
        'success'
      );
    }

    function openMoveExamModal(card) {
      if (!card || !card.ok) return;
      closeContextMenu();
      const curFolder = normalizeFolderPath(card.folder || '');
      moveModal.value = {
        type: 'exam',
        id: card.id,
        oldPath: curFolder,
        title: card.title || 'Đề ôn tập',
        selectedPath: curFolder
      };
    }

    function openMoveFolderModal(folderPath) {
      const cleanOld = normalizeFolderPath(folderPath);
      if (!cleanOld || !getParentFolderPath(cleanOld)) return;
      closeContextMenu();
      moveModal.value = {
        type: 'folder',
        id: '',
        oldPath: cleanOld,
        title: getFolderLeafName(cleanOld),
        selectedPath: getParentFolderPath(cleanOld)
      };
    }

    function confirmMoveModal() {
      const modal = moveModal.value;
      if (!modal) return;

      if (modal.type === 'exam') {
        const targetPath = normalizeFolderPath(modal.selectedPath || '');
        if (targetPath === normalizeFolderPath(modal.oldPath)) {
          moveModal.value = null;
          return;
        }
        const idx = exams.value.findIndex((e) => e.id === modal.id);
        if (idx === -1) {
          moveModal.value = null;
          return;
        }
        const updatedEntry = updateExamFolderYaml(exams.value[idx], targetPath);
        exams.value[idx] = updatedEntry;
        persistExams();
        moveModal.value = null;
        pushExamToServer(updatedEntry, { isNew: false });
        showToast(
          targetPath ? `Đã chuyển đề tới "${targetPath}"` : 'Đã chuyển đề ra ngoài cùng',
          'success'
        );
        return;
      }

      if (modal.type === 'folder') {
        const oldPath = normalizeFolderPath(modal.oldPath);
        const targetParent = normalizeFolderPath(modal.selectedPath || '');
        const leafName = getFolderLeafName(oldPath);
        const newPath = targetParent ? `${targetParent}/${leafName}` : leafName;
        if (!oldPath || newPath === oldPath) {
          moveModal.value = null;
          return;
        }
        const oldPrefix = `${oldPath}/`;
        if (targetParent === oldPath || targetParent.startsWith(oldPrefix)) {
          showToast('Không thể di chuyển thư mục vào chính nó', 'error');
          return;
        }
        if (allFolderPaths.value.includes(newPath)) {
          showToast('Thư mục đích đã có thư mục trùng tên', 'error');
          return;
        }

        const rewritePath = (p) => {
          const norm = normalizeFolderPath(p);
          if (norm === oldPath) return newPath;
          if (norm.startsWith(oldPrefix)) return `${newPath}/${norm.slice(oldPrefix.length)}`;
          return norm;
        };

        const nextFolderSet = new Set();
        savedFolders.value.forEach((p) => {
          const mapped = rewritePath(p);
          if (mapped) nextFolderSet.add(mapped);
        });
        collectAncestors(newPath).forEach((anc) => nextFolderSet.add(anc));
        savedFolders.value = Array.from(nextFolderSet);
        persistSavedFolders();

        const cardFolderById = getParsedCardFolderMap();
        let examsChanged = false;
        exams.value = exams.value.map((item) => {
          const curFolder = cardFolderById.get(item.id) || '';
          if (curFolder === oldPath || curFolder.startsWith(oldPrefix)) {
            examsChanged = true;
            return updateExamFolderYaml(item, rewritePath(curFolder));
          }
          return item;
        });
        if (examsChanged) {
          persistExams();
        }

        const curPath = normalizeFolderPath(currentFolderPath.value);
        if (curPath === oldPath || curPath.startsWith(oldPrefix)) {
          currentFolderPath.value = rewritePath(curPath);
        }

        moveModal.value = null;
        persistFoldersAndExamsToServer({ examsChanged, foldersChanged: true });
        showToast(
          targetParent ? `Đã di chuyển "${leafName}" vào "${targetParent}"` : `Đã đưa "${leafName}" lên cấp Môn học`,
          'success'
        );
      }
    }

    function openDeleteFolderModal(folderOrPath) {
      const path = normalizeFolderPath(
        typeof folderOrPath === 'string' ? folderOrPath : folderOrPath?.path
      );
      if (!path) return;
      closeContextMenu();

      const prefix = `${path}/`;
      let examCount = 0;
      examCards.value.forEach((card) => {
        if (!card.ok) return;
        if (card.folder === path || card.folder.startsWith(prefix)) {
          examCount++;
        }
      });

      const parentPath = getParentFolderPath(path);
      if (examCount === 0) {
        const nextSet = new Set(
          savedFolders.value.filter((p) => p !== path && !p.startsWith(prefix))
        );
        const curPath = normalizeFolderPath(currentFolderPath.value);
        if (parentPath && (curPath === parentPath || curPath.startsWith(`${parentPath}/`))) {
          collectAncestors(parentPath).forEach((anc) => nextSet.add(anc));
        }
        savedFolders.value = Array.from(nextSet);
        persistSavedFolders();
        if (curPath === path || curPath.startsWith(prefix)) {
          currentFolderPath.value = parentPath;
        }
        pushFoldersToServer(savedFolders.value);
        showToast('Đã xóa thư mục rỗng', 'success');
        return;
      }

      deleteFolderModal.value = {
        path,
        name: getFolderLeafName(path),
        isSubject: parentPath === '',
        examCount
      };
    }

    function confirmDeleteFolder(mode) {
      const modal = deleteFolderModal.value;
      if (!modal) return;
      const path = normalizeFolderPath(modal.path);
      if (!path) {
        deleteFolderModal.value = null;
        return;
      }
      const prefix = `${path}/`;
      const parentPath = getParentFolderPath(path);
      const cardFolderById = getParsedCardFolderMap();

      const nextSet = new Set(
        savedFolders.value.filter((p) => p !== path && !p.startsWith(prefix))
      );

      if (mode === 'keep-exams') {
        let movedCount = 0;
        exams.value = exams.value.map((item) => {
          const curFolder = cardFolderById.get(item.id) || '';
          if (curFolder === path || curFolder.startsWith(prefix)) {
            movedCount++;
            return updateExamFolderYaml(item, parentPath);
          }
          return item;
        });
        if (movedCount > 0) {
          persistExams();
        }
        savedFolders.value = Array.from(nextSet);
        persistSavedFolders();

        const curPath = normalizeFolderPath(currentFolderPath.value);
        if (curPath === path || curPath.startsWith(prefix)) {
          currentFolderPath.value = parentPath;
        }

        deleteFolderModal.value = null;
        persistFoldersAndExamsToServer({ examsChanged: movedCount > 0, foldersChanged: true });
        showToast(`Đã xóa thư mục và giữ lại ${movedCount} đề`, 'success');
        return;
      }

      if (mode === 'delete-all') {
        const deletedIds = new Set();
        exams.value.forEach((item) => {
          const curFolder = cardFolderById.get(item.id) || '';
          if (curFolder === path || curFolder.startsWith(prefix)) {
            deletedIds.add(item.id);
          }
        });
        exams.value = exams.value.filter((item) => !deletedIds.has(item.id));
        deletedIds.forEach((id) => {
          clearSavedProgress(id);
          if (pendingResumeQuiz.value?.examId === id) {
            pendingResumeQuiz.value = null;
          }
          if (pendingDeleteId.value === id) {
            pendingDeleteId.value = null;
          }
        });
        if (deletedIds.size > 0) {
          persistExams();
        }

        const curPath = normalizeFolderPath(currentFolderPath.value);
        if (parentPath && (curPath === parentPath || curPath.startsWith(`${parentPath}/`))) {
          collectAncestors(parentPath).forEach((anc) => nextSet.add(anc));
        }
        savedFolders.value = Array.from(nextSet);
        persistSavedFolders();

        if (curPath === path || curPath.startsWith(prefix)) {
          currentFolderPath.value = parentPath;
        }

        deleteFolderModal.value = null;
        persistFoldersAndExamsToServer({ examsChanged: deletedIds.size > 0, foldersChanged: true });
        showToast(`Đã xóa thư mục và ${deletedIds.size} đề`, 'success');
      }
    }

    const pendingDeleteTitle = computed(() => {
      if (!pendingDeleteId.value) return 'đề này';
      const target = examCards.value.find((card) => card.id === pendingDeleteId.value);
      return target && target.ok ? target.title : 'đề này';
    });

    const editorStats = computed(() => validatedData.value
      ? countExamStats(validatedData.value)
      : { sections: 0, total: 0 });

    const quizProgressText = computed(() => {
      if (!activeExam.value) return '';
      const flat = quizQuestionMeta.value.flat;
      const total = flat.length;
      if (gradeResult.value) return `Đã nộp bài · ${total} câu`;
      let answered = 0;
      const ansMap = userAnswers.value;
      for (let i = 0; i < total; i++) {
        const item = flat[i];
        if (isQuestionAnswered(item.q, ansMap[item.key])) answered++;
      }
      return `Đã làm ${answered} / ${total} câu`;
    });

    function clearPreviewSyncTimer() {
      if (previewSyncTimer !== null) {
        clearTimeout(previewSyncTimer);
        previewSyncTimer = null;
      }
    }

    function flushPreviewSync() {
      if (previewSyncTimer !== null) {
        clearTimeout(previewSyncTimer);
        previewSyncTimer = null;
        syncPreviewToYaml();
      }
    }

    function rebuildYamlLineIndex(str) {
      yamlLineIndex = createYamlLineIndex(String(str ?? ''));
    }

    function flashLeftCardHighlight(el) {
      if (!el) return;
      if (lastHighlightedEl && lastHighlightedEl !== el) {
        lastHighlightedEl.classList.remove('jump-highlight');
      }
      clearTimeout(leftHighlightTimer);
      el.classList.remove('jump-highlight');
      void el.offsetWidth;
      el.classList.add('jump-highlight');
      lastHighlightedEl = el;
      leftHighlightTimer = setTimeout(() => {
        el.classList.remove('jump-highlight');
        if (lastHighlightedEl === el) lastHighlightedEl = null;
      }, 1100);
    }

    function flashMonacoLineHighlight(lineNum) {
      if (!monacoEditor || typeof window === 'undefined' || !window.monaco?.Range) return;
      clearTimeout(monacoHighlightTimer);
      monacoJumpDecorationIds = monacoEditor.deltaDecorations(monacoJumpDecorationIds, [
        {
          range: new window.monaco.Range(lineNum, 1, lineNum, 1),
          options: {
            isWholeLine: true,
            className: 'monaco-jump-line-highlight'
          }
        }
      ]);
      monacoHighlightTimer = setTimeout(() => {
        if (monacoEditor) {
          monacoJumpDecorationIds = monacoEditor.deltaDecorations(monacoJumpDecorationIds, []);
        } else {
          monacoJumpDecorationIds = [];
        }
      }, 1100);
    }

    function scrollLeftPaneToQuestion(sIdx, qIdx, subIdx = null, { highlight = true } = {}) {
      const targetId = subIdx != null ? `edq_${sIdx}_${qIdx}_${subIdx}` : `edq_${sIdx}_${qIdx}`;
      const el = document.getElementById(targetId) || document.getElementById(`edq_${sIdx}_${qIdx}`);
      const leftPane = previewPaneRef.value;
      if (!el || !leftPane) return;
      const paneRect = leftPane.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const stickyHeight = document.getElementById('editor-sticky-toolbar')?.offsetHeight || 56;
      const targetTop = leftPane.scrollTop + (elRect.top - paneRect.top) - (stickyHeight + 12);
      leftPane.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      if (highlight) {
        flashLeftCardHighlight(el);
      }
    }

    function scrollRightYamlToQuestion(sIdx, qIdx, subIdx = null, { moveCursor = false, highlight = true } = {}) {
      const entry = lookupLineByQuestion(yamlLineIndex, sIdx, qIdx, subIdx);
      const lineNum = entry?.startLine;
      if (!lineNum) return;

      if (monacoEditor) {
        const lineHeight = monacoEditor.getOption?.(window.monaco?.editor?.EditorOption?.lineHeight) || 21;
        const expectedStickyLines = entry.subIdx != null ? 5 : 3;
        const topPx = monacoEditor.getTopForLineNumber(lineNum);
        const initialOffset = expectedStickyLines * lineHeight + 16;
        monacoEditor.setScrollTop(Math.max(0, topPx - initialOffset));
        requestAnimationFrame(() => {
          if (!monacoEditor) return;
          const stickyEl = monacoEditor.getDomNode?.()?.querySelector('.sticky-widget');
          const actualStickyH = stickyEl?.offsetHeight || 0;
          if (actualStickyH + 12 > initialOffset) {
            monacoEditor.setScrollTop(Math.max(0, monacoEditor.getTopForLineNumber(lineNum) - actualStickyH - 16));
          }
        });
        if (moveCursor) {
          const prevSyncing = isSyncingFromPreview;
          isSyncingFromPreview = true;
          try {
            monacoEditor.setPosition({ lineNumber: lineNum, column: 1 });
          } finally {
            isSyncingFromPreview = prevSyncing;
          }
        }
        if (highlight) {
          flashMonacoLineHighlight(lineNum);
        }
        return;
      }

      const ta = document.getElementById('yaml-input');
      if (ta) {
        const totalLines = Math.max(1, yamlLineIndex.totalLines || yamlText.value.split('\n').length);
        const ratio = Math.min(1, Math.max(0, (lineNum - 1) / totalLines));
        ta.scrollTop = Math.round(ratio * Math.max(0, ta.scrollHeight - ta.clientHeight));
      }
    }

    function onLeftPaneInteract(event) {
      if (event?.target?.closest?.('#editor-sticky-toolbar')) return;
      const card = event?.target?.closest?.('[id^="edq_"]');
      if (!card) return;
      const parts = card.id.split('_');
      if (parts.length < 3) return;
      const sIdx = Number(parts[1]);
      const qIdx = Number(parts[2]);
      const subIdx = parts.length >= 4 ? Number(parts[3]) : null;
      if (!Number.isInteger(sIdx) || !Number.isInteger(qIdx)) return;

      const key = `${sIdx}_${qIdx}_${subIdx ?? ''}`;
      const now = Date.now();
      if (event?.type === 'focusin') {
        if (key === lastLeftJumpKey) return;
      } else if (key === lastLeftJumpKey && now - lastLeftJumpAt < 150) {
        return;
      }
      lastLeftJumpKey = key;
      lastLeftJumpAt = now;
      lastRightJumpKey = key;
      scrollRightYamlToQuestion(sIdx, qIdx, subIdx, { moveCursor: false });
    }

    function onYamlTextareaCursor(event) {
      const ta = event?.target;
      if (!ta || typeof ta.selectionStart !== 'number') return;
      if (yamlDebounceTimer) {
        rebuildYamlLineIndex(ta.value);
      }
      const lineNum = ta.value.slice(0, ta.selectionStart).split('\n').length;
      const found = lookupQuestionByLine(yamlLineIndex, lineNum);
      if (!found) return;
      const key = `${found.sIdx}_${found.qIdx}_${found.subIdx ?? ''}`;
      if (key === lastRightJumpKey) return;
      lastRightJumpKey = key;
      lastLeftJumpKey = key;
      if (editorLeftPanel.value === 'reorder' && found.subIdx != null) {
        const grp = validatedData.value?.sections?.[found.sIdx]?.questions?.[found.qIdx];
        if (grp?.type === 'group' && grp._uid && !expandedReorderGroups.value[grp._uid]) {
          expandedReorderGroups.value = { ...expandedReorderGroups.value, [grp._uid]: true };
          nextTick(() => {
            initSortables();
            scrollLeftPaneToQuestion(found.sIdx, found.qIdx, found.subIdx);
          });
          return;
        }
      }
      scrollLeftPaneToQuestion(found.sIdx, found.qIdx, found.subIdx);
    }

    function disposeMonaco() {
      monacoMountToken++;
      clearTimeout(monacoHighlightTimer);
      monacoHighlightTimer = null;
      monacoJumpDecorationIds = [];
      if (monacoCursorDisposable) {
        monacoCursorDisposable.dispose();
        monacoCursorDisposable = null;
      }
      if (monacoEditor) {
        monacoEditor.dispose();
        monacoEditor = null;
      }
      monacoReady.value = false;
    }

    function goList() {
      flushPreviewSync();
      clearTimeout(yamlDebounceTimer);
      quizTimer.stop();
      applyTimerSnap(quizTimer.getSnapshot(), { syncFinal: true });
      quizAutoSubmitted.value = false;
      disposeMonaco();
      destroySortables();
      pendingDeleteId.value = null;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      showEditorExitConfirm.value = false;
      editorCleanSnapshot = null;
      quizSubmittedAt.value = null;
      exitConfirmAutoPaused = false;
      pendingResumeQuiz.value = null;
      activeExamId.value = null;
      quizTurboMode.value = false;
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      canonicalQuizExam = null;
      closeContextMenu();
      folderModal.value = null;
      moveModal.value = null;
      deleteFolderModal.value = null;
      editorLeftPanel.value = 'edit';
      view.value = 'list';
      window.scrollTo(0, 0);
    }

    function requestDelete(id) {
      pendingDeleteId.value = id;
    }

    function confirmDelete() {
      if (!pendingDeleteId.value) return;
      const targetId = pendingDeleteId.value;
      exams.value = exams.value.filter((e) => e.id !== targetId);
      pendingDeleteId.value = null;
      if (pendingResumeQuiz.value?.examId === targetId) {
        pendingResumeQuiz.value = null;
      }
      clearSavedProgress(targetId);
      persistExams();
      deleteExamOnServer(targetId);
    }

    function setYamlValue(val) {
      isSyncingFromPreview = true;
      try {
        yamlText.value = val;
        if (monacoEditor && monacoEditor.getValue() !== val) {
          monacoEditor.setValue(val);
        }
      } finally {
        isSyncingFromPreview = false;
      }
    }

    function destroySortables() {
      sortableInitToken++;
      sortableInstances.forEach((inst) => inst.destroy());
      sortableInstances = [];
    }

    async function initSortables() {
      destroySortables();
      if (
        view.value !== 'editor' ||
        !validatedData.value ||
        editorErrors.value.length > 0 ||
        editorLeftPanel.value === 'points' ||
        editorLeftPanel.value === 'preview'
      ) {
        return;
      }

      const token = sortableInitToken;
      const Sortable = await loadSortable();

      if (
        token !== sortableInitToken ||
        view.value !== 'editor' ||
        !validatedData.value ||
        editorErrors.value.length > 0 ||
        editorLeftPanel.value === 'points' ||
        editorLeftPanel.value === 'preview'
      ) {
        return;
      }

      const isReorderPanel = editorLeftPanel.value === 'reorder';
      const secList = document.getElementById(isReorderPanel ? 'reorder-sections-list' : 'preview-sections-list');
      if (!Sortable || !secList) return;

      sortableInstances.push(Sortable.create(secList, {
        handle: '.gf-section-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd(evt) {
          if (evt.oldIndex === evt.newIndex || !validatedData.value) return;
          const { from, item, oldIndex, newIndex } = evt;
          if (item.parentNode === from) from.removeChild(item);
          from.insertBefore(item, from.children[oldIndex] || null);
          const secs = validatedData.value.sections;
          if (oldIndex == null || newIndex == null || oldIndex < 0 || oldIndex >= secs.length) return;
          const [moved] = secs.splice(oldIndex, 1);
          secs.splice(newIndex, 0, moved);
          syncPreviewToYaml();
          nextTick(initSortables);
        }
      }));

      const stackSelector = isReorderPanel ? '.reorder-questions-stack' : '.questions-stack';
      secList.querySelectorAll(stackSelector).forEach((stack) => {
        const opts = {
          handle: '.gf-question-handle',
          animation: 150,
          ghostClass: 'sortable-ghost',
          onEnd(evt) {
            const { from, to, item, oldIndex, newIndex } = evt;
            if (item.parentNode === to) to.removeChild(item);
            else if (item.parentNode === from) from.removeChild(item);
            from.insertBefore(item, from.children[oldIndex] || null);

            const fromSIdx = Number(from.dataset.sidx);
            const toSIdx = Number(to.dataset.sidx);
            const secs = validatedData.value?.sections;
            const fromSec = secs?.[fromSIdx];
            const toSec = secs?.[toSIdx];

            if (fromSIdx === toSIdx) {
              if (!fromSec || oldIndex === newIndex || oldIndex == null || newIndex == null) return;
              if (oldIndex < 0 || oldIndex >= fromSec.questions.length) return;
              const [moved] = fromSec.questions.splice(oldIndex, 1);
              fromSec.questions.splice(newIndex, 0, moved);
              syncPreviewToYaml();
              return;
            }

            if (!fromSec || !toSec || oldIndex == null || newIndex == null) return;
            if (fromSec.questions.length <= 1) {
              showToast('Mỗi phần cần giữ ít nhất 1 câu hỏi', 'error');
              return;
            }
            if (oldIndex < 0 || oldIndex >= fromSec.questions.length) return;
            const [moved] = fromSec.questions.splice(oldIndex, 1);
            toSec.questions.splice(newIndex, 0, moved);
            syncPreviewToYaml();
            nextTick(initSortables);
          }
        };
        if (isReorderPanel) {
          opts.group = 'reorder-questions';
        }
        sortableInstances.push(Sortable.create(stack, opts));
      });

      if (isReorderPanel) {
        secList.querySelectorAll('.reorder-subquestions-stack').forEach((subStack) => {
          sortableInstances.push(Sortable.create(subStack, {
            handle: '.gf-subquestion-handle',
            animation: 150,
            ghostClass: 'sortable-ghost',
            onEnd(evt) {
              const { from, item, oldIndex, newIndex } = evt;
              if (item.parentNode === from) from.removeChild(item);
              from.insertBefore(item, from.children[oldIndex] || null);
              if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
              const sIdx = Number(from.dataset.sidx);
              const qIdx = Number(from.dataset.qidx);
              const group = validatedData.value?.sections?.[sIdx]?.questions?.[qIdx];
              if (!group || group.type !== 'group' || !Array.isArray(group.questions)) return;
              if (oldIndex < 0 || oldIndex >= group.questions.length) return;
              const [moved] = group.questions.splice(oldIndex, 1);
              group.questions.splice(newIndex, 0, moved);
              syncPreviewToYaml();
            }
          }));
        });
      }
    }

    function isReorderGroupExpanded(uid) {
      return Boolean(uid && expandedReorderGroups.value[uid]);
    }

    function toggleReorderGroup(uid) {
      if (!uid) return;
      expandedReorderGroups.value = {
        ...expandedReorderGroups.value,
        [uid]: !expandedReorderGroups.value[uid]
      };
      nextTick(initSortables);
    }

    function jumpToEditorQuestion(sIdx, qIdx, subIdx = null) {
      showEditorJumpMenu.value = false;
      const group = validatedData.value?.sections?.[sIdx]?.questions?.[qIdx];
      if (editorLeftPanel.value === 'reorder' && subIdx != null && group?.type === 'group' && group._uid) {
        if (!expandedReorderGroups.value[group._uid]) {
          expandedReorderGroups.value = { ...expandedReorderGroups.value, [group._uid]: true };
          nextTick(initSortables);
        }
      }

      nextTick(() => {
        const key = `${sIdx}_${qIdx}_${subIdx ?? ''}`;
        lastLeftJumpKey = key;
        lastLeftJumpAt = Date.now();
        lastRightJumpKey = key;
        scrollLeftPaneToQuestion(sIdx, qIdx, subIdx);
        scrollRightYamlToQuestion(sIdx, qIdx, subIdx, { moveCursor: true });
      });
    }

    function setEditorLeftPanel(panel) {
      const nextPanel = panel === 'points' || panel === 'reorder' || panel === 'preview' ? panel : 'edit';
      showEditorJumpMenu.value = false;
      flushPreviewSync();
      editorLeftPanel.value = nextPanel;
      if (nextPanel === 'points' || nextPanel === 'preview') {
        destroySortables();
      } else {
        nextTick(initSortables);
      }
    }

    function validateAndPreview() {
      clearPreviewSyncTimer();
      clearTimeout(yamlDebounceTimer);
      yamlDebounceTimer = null;
      rebuildYamlLineIndex(yamlText.value);
      const res = parseExamYaml(yamlText.value);
      if (!res.ok) {
        validatedData.value = null;
        editorErrors.value = res.errors;
        canSaveExam.value = false;
        syncMonacoMarkers(monacoEditor, res.errors);
        destroySortables();
        return;
      }

      syncMonacoMarkers(monacoEditor, []);
      editorErrors.value = [];
      validatedData.value = attachUids(res.data);

      const titleInput = document.getElementById('editor-title-input');
      if (document.activeElement !== titleInput) {
        editorTitle.value = res.data.meta.title;
      }
      const folderInput = document.getElementById('editor-folder-input');
      if (document.activeElement !== folderInput) {
        editorFolder.value = normalizeFolderPath(res.data.meta.folder || '');
      }
      const timeLimitInput = document.getElementById('editor-time-limit-input');
      if (document.activeElement !== timeLimitInput) {
        editorTimeLimit.value = res.data.meta.time_limit ? String(res.data.meta.time_limit) : '';
      }

      canSaveExam.value = true;
      nextTick(initSortables);
    }

    function handleYamlInput() {
      if (isSyncingFromPreview) return;
      clearPreviewSyncTimer();
      canSaveExam.value = false;
      syncMonacoMarkers(monacoEditor, []);
      clearTimeout(yamlDebounceTimer);
      yamlDebounceTimer = setTimeout(validateAndPreview, 250);
    }

    function handleYamlTab(e) {
      const el = e.target;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      yamlText.value = yamlText.value.slice(0, start) + '  ' + yamlText.value.slice(end);
      nextTick(() => { el.selectionStart = el.selectionEnd = start + 2; });
      handleYamlInput();
    }

    function syncPreviewToYaml() {
      clearPreviewSyncTimer();
      if (!validatedData.value) return;
      clearTimeout(yamlDebounceTimer);
      yamlDebounceTimer = null;
      const yaml = serializeExamYaml(validatedData.value);
      setYamlValue(yaml);
      rebuildYamlLineIndex(yaml);
      syncMonacoMarkers(monacoEditor, []);
      const hadErrors = editorErrors.value.length > 0;
      const res = parseExamYaml(yaml);
      canSaveExam.value = res.ok;
      if (hadErrors) {
        if (res.ok) {
          editorErrors.value = [];
          nextTick(initSortables);
        } else {
          validatedData.value = null;
          editorErrors.value = res.errors;
          syncMonacoMarkers(monacoEditor, res.errors);
        }
      }
    }

    function scheduleSyncPreviewToYaml() {
      if (!validatedData.value) return;
      clearTimeout(previewSyncTimer);
      previewSyncTimer = setTimeout(() => {
        previewSyncTimer = null;
        syncPreviewToYaml();
      }, 180);
    }

    function onHeaderTitleInput() {
      flushPreviewSync();
      const newTitle = editorTitle.value;
      if (validatedData.value) {
        validatedData.value.meta.title = newTitle;
        syncPreviewToYaml();
        return;
      }
      const cur = yamlText.value;
      if (cur.trim() && /(^meta:\s*\r?\n[ \t]*title:[ \t]*)(.*)$/m.test(cur)) {
        const quoted = '"' + newTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        setYamlValue(cur.replace(/(^meta:\s*\r?\n[ \t]*title:[ \t]*)(.*)$/m, `$1${quoted}`));
        validateAndPreview();
      }
    }

    function onHeaderFolderInput() {
      flushPreviewSync();
      const folderVal = normalizeFolderPath(editorFolder.value);
      if (validatedData.value) {
        if (folderVal) validatedData.value.meta.folder = folderVal;
        else delete validatedData.value.meta.folder;
        syncPreviewToYaml();
        return;
      }

      try {
        const doc = jsyaml.load(yamlText.value);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
        if (!doc.meta || typeof doc.meta !== 'object' || Array.isArray(doc.meta)) {
          doc.meta = {};
        }
        if (folderVal) doc.meta.folder = folderVal;
        else delete doc.meta.folder;
        const dumped = jsyaml.dump(doc, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          quotingType: '"',
          forceQuotes: false
        });
        setYamlValue(dumped);
        validateAndPreview();
      } catch {
        // Ignore while raw YAML has syntax errors
      }
    }

    function updateRawYamlMetaTimeLimit(limitValue) {
      const isInvalidValue = limitValue !== undefined &&
        !(typeof limitValue === 'number' && Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 600);
      const surfaceInvalidFallback = () => {
        if (!isInvalidValue) return;
        canSaveExam.value = false;
        if (!editorErrors.value.some((e) => /time_limit/.test(e))) {
          editorErrors.value = [
            ...editorErrors.value,
            'meta.time_limit: Thời gian làm bài phải là số nguyên dương (đơn vị phút, từ 1 đến 600).'
          ];
        }
      };

      try {
        const sourceYaml = validatedData.value ? serializeExamYaml(validatedData.value) : yamlText.value;
        const doc = jsyaml.load(sourceYaml);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          surfaceInvalidFallback();
          return;
        }
        if (!doc.meta || typeof doc.meta !== 'object' || Array.isArray(doc.meta)) {
          doc.meta = {};
        }
        if (limitValue === undefined) delete doc.meta.time_limit;
        else doc.meta.time_limit = limitValue;

        const dumped = jsyaml.dump(doc, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          quotingType: '"',
          forceQuotes: false
        });
        setYamlValue(dumped);
        validateAndPreview();
      } catch {
        surfaceInvalidFallback();
      }
    }

    function onHeaderTimeLimitInput(event) {
      flushPreviewSync();
      const isBadInput = Boolean(event?.target?.validity?.badInput);
      const rawStr = String(editorTimeLimit.value ?? '').trim();

      if (isBadInput) {
        clearTimeout(yamlDebounceTimer);
        destroySortables();
        canSaveExam.value = false;
        if (!editorErrors.value.some((e) => /time_limit/.test(e))) {
          editorErrors.value = [
            ...editorErrors.value,
            'meta.time_limit: Thời gian làm bài phải là số nguyên dương (đơn vị phút, từ 1 đến 600).'
          ];
        }
        return;
      }

      if (rawStr === '') {
        if (validatedData.value) {
          delete validatedData.value.meta.time_limit;
          syncPreviewToYaml();
          return;
        }
        updateRawYamlMetaTimeLimit(undefined);
        return;
      }

      const isDigits = /^\d+$/.test(rawStr);
      const parsedNum = isDigits ? Number(rawStr) : NaN;
      if (Number.isInteger(parsedNum) && parsedNum >= 1 && parsedNum <= 600) {
        if (validatedData.value) {
          validatedData.value.meta.time_limit = parsedNum;
          syncPreviewToYaml();
          return;
        }
        updateRawYamlMetaTimeLimit(parsedNum);
        return;
      }

      const invalidYamlVal = /^-?\d+(?:\.\d+)?$/.test(rawStr) ? Number(rawStr) : rawStr;
      updateRawYamlMetaTimeLimit(invalidYamlVal);
    }

    function triggerImportYaml() {
      const input = document.getElementById('import-yaml-file');
      if (input) input.click();
    }

    async function handleImportYamlFile(event) {
      const input = event?.target;
      const file = input?.files?.[0];
      if (!file) return;

      try {
        clearPreviewSyncTimer();
        clearTimeout(yamlDebounceTimer);
        const content = (await file.text()).replace(/^\uFEFF/, '');
        setYamlValue(content);
        validateAndPreview();
        if (editorErrors.value.length === 0) {
          showToast(`Đã nhập file "${file.name}"`, 'success');
        } else {
          showToast(`Đã nhập "${file.name}" nhưng YAML có ${editorErrors.value.length} lỗi cần sửa`, 'error', 4500);
        }
      } catch {
        showToast('Không thể đọc file YAML đã chọn.', 'error', 4000);
      } finally {
        if (input) input.value = '';
      }
    }

    function exportYaml() {
      flushPreviewSync();
      const raw = yamlText.value;
      if (!String(raw ?? '').trim()) {
        showToast('Nội dung YAML đang trống, chưa thể xuất file.', 'error');
        return;
      }
      const res = parseExamYaml(raw);
      if (!res.ok) {
        validateAndPreview();
        showToast('YAML đang có lỗi, vui lòng sửa trước khi xuất file.', 'error');
        return;
      }

      const blob = new Blob([raw], { type: 'text/yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${toSafeFilenameSlug(res.data.meta.title)}.yaml`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Đã xuất file .yaml', 'success');
    }

    async function mountMonacoInContainer() {
      const token = ++monacoMountToken;
      try {
        await ensureMonacoLoaded();
      } catch (err) {
        console.warn('Không thể tải Monaco Editor, dùng trình soạn thảo YAML dự phòng:', err);
        if (token === monacoMountToken) {
          monacoReady.value = false;
        }
        return;
      }

      if (token !== monacoMountToken || view.value !== 'editor') return;

      monacoReady.value = true;
      await nextTick();

      if (token !== monacoMountToken || view.value !== 'editor') {
        monacoReady.value = false;
        return;
      }
      const mountedContainer = document.getElementById('monaco-container');
      if (!mountedContainer) {
        monacoReady.value = false;
        return;
      }

      if (monacoEditor) {
        monacoEditor.dispose();
        monacoEditor = null;
      }

      try {
        const editor = await createMonacoYamlEditor(mountedContainer, {
          value: yamlText.value,
          onChange(nextVal, e) {
            if (isSyncingFromPreview) return;
            yamlText.value = nextVal;
            if (e?.changes?.length) {
              applyIncrementalChanges(yamlLineIndex, e.changes);
            }
            handleYamlInput();
          }
        });
        if (!editor || token !== monacoMountToken || view.value !== 'editor') {
          if (editor) editor.dispose();
          if (token === monacoMountToken) monacoReady.value = false;
          return;
        }
        monacoEditor = editor;
        if (monacoCursorDisposable) {
          monacoCursorDisposable.dispose();
        }
        monacoCursorDisposable = editor.onDidChangeCursorPosition((e) => {
          if (isSyncingFromPreview || !editor.hasTextFocus()) return;
          const lineNum = e?.position?.lineNumber;
          if (!lineNum) return;
          const found = lookupQuestionByLine(yamlLineIndex, lineNum);
          if (!found) return;
          const key = `${found.sIdx}_${found.qIdx}_${found.subIdx ?? ''}`;
          if (key === lastRightJumpKey) return;
          lastRightJumpKey = key;
          lastLeftJumpKey = key;
          if (editorLeftPanel.value === 'reorder' && found.subIdx != null) {
            const grp = validatedData.value?.sections?.[found.sIdx]?.questions?.[found.qIdx];
            if (grp?.type === 'group' && grp._uid && !expandedReorderGroups.value[grp._uid]) {
              expandedReorderGroups.value = { ...expandedReorderGroups.value, [grp._uid]: true };
              nextTick(() => {
                initSortables();
                scrollLeftPaneToQuestion(found.sIdx, found.qIdx, found.subIdx);
              });
              return;
            }
          }
          scrollLeftPaneToQuestion(found.sIdx, found.qIdx, found.subIdx);
        });
        syncMonacoMarkers(monacoEditor, editorErrors.value);
      } catch (err) {
        console.warn('Không thể tải Monaco Editor, dùng trình soạn thảo YAML dự phòng:', err);
        if (token === monacoMountToken) {
          monacoReady.value = false;
        }
      }
    }

    function normalizeLineEndings(str) {
      return String(str ?? '').replace(/\r\n/g, '\n');
    }

    function captureEditorSnapshot() {
      return {
        yaml: normalizeLineEndings(yamlText.value),
        title: String(editorTitle.value ?? ''),
        folder: normalizeFolderPath(editorFolder.value ?? ''),
        timeLimit: String(editorTimeLimit.value ?? '').trim()
      };
    }

    function isEditorDirty() {
      if (!editorCleanSnapshot) return false;
      const curYaml = normalizeLineEndings(monacoEditor ? monacoEditor.getValue() : yamlText.value);
      if (curYaml !== editorCleanSnapshot.yaml) return true;
      if (String(editorTitle.value ?? '') !== editorCleanSnapshot.title) return true;
      if (normalizeFolderPath(editorFolder.value ?? '') !== editorCleanSnapshot.folder) return true;
      if (String(editorTimeLimit.value ?? '').trim() !== editorCleanSnapshot.timeLimit) return true;
      if (typeof document !== 'undefined' && document.getElementById('editor-time-limit-input')?.validity?.badInput) {
        return true;
      }
      return false;
    }

    function requestExitEditor() {
      flushPreviewSync();
      if (yamlDebounceTimer !== null) {
        validateAndPreview();
      }
      if (!isEditorDirty()) {
        goList();
        return;
      }
      showEditorJumpMenu.value = false;
      showEditorExitConfirm.value = true;
      nextTick(() => {
        const focusTarget = (canSaveExam.value && validatedData.value)
          ? document.getElementById('btn-editor-save-exit')
          : document.getElementById('btn-editor-cancel-exit');
        if (focusTarget) focusTarget.focus();
      });
    }

    function cancelExitEditor() {
      showEditorExitConfirm.value = false;
    }

    function discardAndExitEditor() {
      clearPreviewSyncTimer();
      clearTimeout(yamlDebounceTimer);
      yamlDebounceTimer = null;
      showEditorExitConfirm.value = false;
      editorCleanSnapshot = null;
      goList();
    }

    function saveAndExitEditor() {
      flushPreviewSync();
      if (yamlDebounceTimer !== null) {
        validateAndPreview();
      }
      if (!validatedData.value || !canSaveExam.value) {
        showToast('YAML đang có lỗi, vui lòng sửa trước khi lưu.', 'error');
        return;
      }
      showEditorExitConfirm.value = false;
      saveCurrentExam();
    }

    async function openEditor(examId) {
      clearPreviewSyncTimer();
      clearTimeout(yamlDebounceTimer);
      yamlDebounceTimer = null;
      clearTimeout(leftHighlightTimer);
      leftHighlightTimer = null;
      lastHighlightedEl = null;
      lastLeftJumpKey = '';
      lastLeftJumpAt = 0;
      lastRightJumpKey = '';
      quizTimer.stop();
      disposeMonaco();
      destroySortables();
      showExitQuizConfirm.value = false;
      showEditorExitConfirm.value = false;
      editorCleanSnapshot = null;
      quizSubmittedAt.value = null;
      exitConfirmAutoPaused = false;
      pendingResumeQuiz.value = null;
      activeExamId.value = null;
      quizTurboMode.value = false;
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      canonicalQuizExam = null;
      editingId.value = examId || null;
      editorErrors.value = [];
      editorLeftPanel.value = 'edit';
      view.value = 'editor';
      window.scrollTo(0, 0);
      triggerRichTextLoad();

      if (examId) {
        const found = exams.value.find((e) => e.id === examId);
        editorTitle.value = '';
        editorFolder.value = '';
        editorTimeLimit.value = '';
        setYamlValue(found ? found.rawYaml : '');
        validateAndPreview();
      } else {
        const initialFolder = normalizeFolderPath(currentFolderPath.value);
        const meta = { title: 'Đề ôn tập mới' };
        if (initialFolder) meta.folder = initialFolder;
        const starter = attachUids({
          meta,
          sections: [{ title: 'Phần I. Trắc nghiệm nhiều phương án lựa chọn', questions: [createDefaultQuestion('multiple_choice')] }]
        });
        validatedData.value = starter;
        editorTitle.value = starter.meta.title;
        editorFolder.value = initialFolder;
        editorTimeLimit.value = '';
        const starterYaml = serializeExamYaml(starter);
        setYamlValue(starterYaml);
        rebuildYamlLineIndex(starterYaml);
        syncMonacoMarkers(monacoEditor, []);
        canSaveExam.value = true;
        nextTick(initSortables);
      }

      editorCleanSnapshot = captureEditorSnapshot();

      await nextTick();
      if (view.value !== 'editor') return;
      await mountMonacoInContainer();
    }

    function saveCurrentExam() {
      flushPreviewSync();
      if (!validatedData.value || !canSaveExam.value) return;
      const rawYaml = yamlText.value;
      let savedEntry = null;
      let isNew = false;
      if (editingId.value) {
        const idx = exams.value.findIndex((e) => e.id === editingId.value);
        if (idx !== -1) {
          const prevRawYaml = exams.value[idx].rawYaml;
          savedEntry = { ...exams.value[idx], rawYaml, updatedAt: Date.now() };
          exams.value[idx] = savedEntry;
          if (prevRawYaml !== rawYaml) {
            clearSavedProgress(editingId.value);
          }
        }
      } else {
        isNew = true;
        savedEntry = { id: `exam-${Date.now()}`, rawYaml, updatedAt: Date.now(), pinned: false };
        exams.value.unshift(savedEntry);
      }
      persistExams();
      if (savedEntry) {
        pushExamToServer(savedEntry, { isNew });
      }
      goList();
    }

    function focusRichInput(e) {
      if (!e.target.closest('.gf-rich-preview')) return;
      const input = e.currentTarget.querySelector('.inline-input, .inline-textarea');
      if (input) input.focus();
    }

    function lineCount(str) {
      return Math.max(2, String(str || '').split('\n').length);
    }

    function changeQuestionType(sec, qIdx, newType) {
      const oldQ = sec.questions[qIdx];
      const seedText = oldQ.type === 'group' ? (oldQ.content || oldQ.title || '') : oldQ.question;
      sec.questions[qIdx] = createDefaultQuestion(newType, seedText, oldQ.explanation);
      syncPreviewToYaml();
    }

    function changeSubQuestionType(groupQ, subIdx, newType) {
      if (!groupQ || !Array.isArray(groupQ.questions)) return;
      const oldSub = groupQ.questions[subIdx];
      if (!oldSub) return;
      const nextSub = createDefaultSubQuestion(newType, oldSub.question || '', oldSub.explanation || '');
      if (oldSub.points != null) nextSub.points = oldSub.points;
      groupQ.questions[subIdx] = nextSub;
      syncPreviewToYaml();
    }

    function addSubQuestion(groupQ) {
      if (!groupQ || !Array.isArray(groupQ.questions) || groupQ.questions.length >= 50) return;
      const lastType = groupQ.questions[groupQ.questions.length - 1]?.type || 'multiple_choice';
      groupQ.questions.push(createDefaultSubQuestion(lastType, ''));
      syncPreviewToYaml();
    }

    function deleteSubQuestion(groupQ, subIdx) {
      if (!groupQ || !Array.isArray(groupQ.questions) || groupQ.questions.length <= 1) return;
      groupQ.questions.splice(subIdx, 1);
      syncPreviewToYaml();
    }

    function moveSubQuestion(groupQ, subIdx, dir) {
      if (!groupQ || !Array.isArray(groupQ.questions)) return;
      const targetIdx = subIdx + dir;
      if (targetIdx < 0 || targetIdx >= groupQ.questions.length) return;
      [groupQ.questions[subIdx], groupQ.questions[targetIdx]] = [groupQ.questions[targetIdx], groupQ.questions[subIdx]];
      syncPreviewToYaml();
    }

    function setStatementBool(st, val) {
      st.is_true = val;
      syncPreviewToYaml();
    }

    function addStatement(q) {
      if (q.statements.length >= 8) return;
      q.statements.push({ text: 'Mệnh đề mới', is_true: true });
      syncPreviewToYaml();
    }

    function deleteStatement(q, stIdx) {
      if (q.statements.length <= 1) return;
      q.statements.splice(stIdx, 1);
      syncPreviewToYaml();
    }

    function addShortAnswer(q) {
      q.accepted_answers.push('Đáp án mới');
      syncPreviewToYaml();
    }

    function deleteShortAnswer(q, aIdx) {
      if (q.accepted_answers.length <= 1) return;
      q.accepted_answers.splice(aIdx, 1);
      syncPreviewToYaml();
    }

    function insertQuestionBelow(sec, qIdx) {
      const curType = sec.questions[qIdx]?.type;
      sec.questions.splice(qIdx + 1, 0, createDefaultQuestion(curType === 'group' ? 'multiple_choice' : curType));
      syncPreviewToYaml();
    }

    function insertGroupBelow(sec, qIdx) {
      sec.questions.splice(qIdx + 1, 0, createDefaultQuestion('group'));
      syncPreviewToYaml();
    }

    function addGroupToSection(sec) {
      if (!sec || !Array.isArray(sec.questions)) return;
      sec.questions.push(createDefaultQuestion('group'));
      syncPreviewToYaml();
    }

    function duplicateQuestion(sec, qIdx) {
      const clone = JSON.parse(JSON.stringify(sec.questions[qIdx]));
      clone._uid = nextUid();
      if (clone.type === 'group' && Array.isArray(clone.questions)) {
        clone.questions.forEach((subQ) => {
          subQ._uid = nextUid();
        });
      }
      sec.questions.splice(qIdx + 1, 0, clone);
      syncPreviewToYaml();
    }

    function moveQuestion(sec, qIdx, dir) {
      const targetIdx = qIdx + dir;
      if (targetIdx < 0 || targetIdx >= sec.questions.length) return;
      [sec.questions[qIdx], sec.questions[targetIdx]] = [sec.questions[targetIdx], sec.questions[qIdx]];
      syncPreviewToYaml();
    }

    function deleteQuestion(sec, qIdx) {
      if (sec.questions.length <= 1) return;
      sec.questions.splice(qIdx, 1);
      syncPreviewToYaml();
    }

    function addSection() {
      if (!validatedData.value) return;
      validatedData.value.sections.push({
        _uid: nextUid(),
        title: 'Phần mới',
        questions: [createDefaultQuestion('multiple_choice')]
      });
      syncPreviewToYaml();
      nextTick(initSortables);
    }

    function moveSection(sIdx, dir) {
      const secs = validatedData.value?.sections;
      const targetIdx = sIdx + dir;
      if (!secs || targetIdx < 0 || targetIdx >= secs.length) return;
      [secs[sIdx], secs[targetIdx]] = [secs[targetIdx], secs[sIdx]];
      syncPreviewToYaml();
      nextTick(initSortables);
    }

    function deleteSection(sIdx) {
      const secs = validatedData.value?.sections;
      if (!secs || secs.length <= 1) return;
      secs.splice(sIdx, 1);
      syncPreviewToYaml();
      nextTick(initSortables);
    }

    async function copyAiPrompt() {
      const promptText = buildAiPrompt(editorTitle.value.trim(), {
        folder: editorFolder.value.trim(),
        timeLimit: editorTimeLimit.value
      });
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(promptText);
          copied = true;
        } catch {}
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = promptText;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyLabel.value = copied ? 'Đã copy Prompt!' : 'Không thể copy';
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => { copyLabel.value = 'Copy Prompt AI'; }, 2000);
    }

    function launchQuiz(examId, { resumeSaved = false } = {}) {
      const found = exams.value.find((e) => e.id === examId);
      if (!found) return;
      const parsed = parseExamYaml(found.rawYaml);
      if (!parsed.ok) return;

      const saved = resumeSaved ? savedProgressMap.value[examId] : null;
      const initialAnswers = saved && saved.userAnswers && typeof saved.userAnswers === 'object'
        ? JSON.parse(JSON.stringify(saved.userAnswers))
        : {};
      const rawLimit = resumeSaved && saved
        ? Number(saved.limitMinutes ?? parsed.data.meta.time_limit ?? 0)
        : (parsed.data.meta.time_limit || 0);
      const initialElapsedSeconds = resumeSaved && saved ? (saved.elapsedSeconds || 0) : 0;

      const taggedCanonical = tagCanonicalIndices(parsed.data);
      canonicalQuizExam = taggedCanonical;
      const initialExam = resumeSaved && saved && Array.isArray(saved.shuffleOrder)
        ? applyShuffleOrder(taggedCanonical, saved.shuffleOrder)
        : taggedCanonical;

      triggerRichTextLoad();
      isReviewingHistory.value = false;
      activeExamId.value = examId;
      activeExam.value = initialExam;
      userAnswers.value = initialAnswers;
      quizTurboMode.value = resumeSaved && saved ? Boolean(saved.turboMode) : Boolean(turboModePref.value);
      turboChecked.value = resumeSaved && saved ? { ...(saved.turboChecked || {}) } : {};
      turboDetailsCache = Object.create(null);
      lastMouseOptionHandledKey = '';
      gradeResult.value = null;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      exitConfirmAutoPaused = false;
      pendingResumeQuiz.value = null;
      quizAutoSubmitted.value = false;
      quizSubmittedAt.value = null;
      quizTimerLimit.value = Number.isFinite(rawLimit) ? rawLimit : 0;
      quizRenderEpoch.value++;
      view.value = 'quiz';
      quizTimer.start(quizTimerLimit.value, { initialElapsedSeconds });
      applyTimerSnap(quizTimer.getSnapshot(), { syncFinal: true });
      window.scrollTo(0, 0);
    }

    function startQuiz(examId) {
      const found = exams.value.find((e) => e.id === examId);
      if (!found) return;
      const parsed = parseExamYaml(found.rawYaml);
      if (!parsed.ok) return;

      const saved = savedProgressMap.value[examId];
      if (saved) {
        const previewExam = Array.isArray(saved.shuffleOrder)
          ? applyShuffleOrder(tagCanonicalIndices(parsed.data), saved.shuffleOrder)
          : parsed.data;
        let totalQuestions = 0;
        let answeredCount = 0;
        previewExam.sections.forEach((sec, sIdx) => {
          sec.questions.forEach((q, qIdx) => {
            if (q.type === 'group' && Array.isArray(q.questions)) {
              q.questions.forEach((subQ, subIdx) => {
                totalQuestions++;
                if (isQuestionAnswered(subQ, saved.userAnswers?.[`${sIdx}_${qIdx}_${subIdx}`])) {
                  answeredCount++;
                }
              });
            } else {
              totalQuestions++;
              if (isQuestionAnswered(q, saved.userAnswers?.[`${sIdx}_${qIdx}`])) {
                answeredCount++;
              }
            }
          });
        });

        pendingResumeQuiz.value = {
          examId,
          title: parsed.data.meta.title,
          answeredCount,
          totalQuestions,
          elapsedDisplay: formatDuration(saved.elapsedSeconds),
          limitMinutes: Number(saved.limitMinutes || parsed.data.meta.time_limit || 0)
        };
        return;
      }

      launchQuiz(examId, { resumeSaved: false });
    }

    function resumeSavedQuiz() {
      if (!pendingResumeQuiz.value) return;
      const id = pendingResumeQuiz.value.examId;
      pendingResumeQuiz.value = null;
      launchQuiz(id, { resumeSaved: true });
    }

    function restartSavedQuiz() {
      if (!pendingResumeQuiz.value) return;
      const id = pendingResumeQuiz.value.examId;
      pendingResumeQuiz.value = null;
      clearSavedProgress(id);
      launchQuiz(id, { resumeSaved: false });
    }

    function cancelResumeQuiz() {
      pendingResumeQuiz.value = null;
    }

    const canShuffleActiveExam = computed(() => {
      const secs = activeExam.value?.sections;
      if (!Array.isArray(secs)) return false;
      return secs.some((sec) => Array.isArray(sec?.questions) && sec.questions.length >= 2);
    });

    function shuffleTurboQuiz() {
      if (!activeExam.value || !quizTurboMode.value || gradeResult.value !== null || showExitQuizConfirm.value) return;
      const res = shuffleExamState({
        exam: activeExam.value,
        userAnswers: userAnswers.value,
        turboChecked: turboChecked.value
      });
      if (!res || !res.shuffled) {
        showToast('Đề không đủ câu để đảo thứ tự', 'error', 2000);
        return;
      }
      turboDetailsCache = Object.create(null);
      lastMouseOptionHandledKey = '';
      activeExam.value = res.exam;
      userAnswers.value = res.userAnswers;
      turboChecked.value = res.turboChecked;
      quizRenderEpoch.value++;
      window.scrollTo(0, 0);
      showToast('Đã đảo thứ tự câu hỏi', 'success', 1800);
    }

    function resetTurboQuiz() {
      if (!activeExam.value || !quizTurboMode.value || gradeResult.value !== null || showExitQuizConfirm.value) return;
      activeExam.value = canonicalQuizExam ? tagCanonicalIndices(canonicalQuizExam) : activeExam.value;
      userAnswers.value = {};
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      lastMouseOptionHandledKey = '';
      showSubmitConfirm.value = false;
      clearSavedProgress(activeExamId.value);
      quizRenderEpoch.value++;
      quizTimer.start(quizTimerLimit.value);
      applyTimerSnap(quizTimer.getSnapshot(), { syncFinal: true });
      window.scrollTo(0, 0);
      showToast('Đã xóa hết đáp án và quay về ban đầu', 'success', 1800);
    }

    function retryQuiz() {
      if (!activeExam.value) return;
      isReviewingHistory.value = false;
      clearSavedProgress(activeExamId.value);
      if (canonicalQuizExam) {
        activeExam.value = tagCanonicalIndices(canonicalQuizExam);
      }
      userAnswers.value = {};
      turboChecked.value = {};
      turboDetailsCache = Object.create(null);
      lastMouseOptionHandledKey = '';
      gradeResult.value = null;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      exitConfirmAutoPaused = false;
      quizAutoSubmitted.value = false;
      quizSubmittedAt.value = null;
      quizRenderEpoch.value++;
      quizTimer.start(quizTimerLimit.value);
      applyTimerSnap(quizTimer.getSnapshot(), { syncFinal: true });
      window.scrollTo(0, 0);
    }

    function toggleQuizTimerPause() {
      if (!activeExam.value || gradeResult.value || showExitQuizConfirm.value) return;
      quizTimer.togglePause();
      applyTimerSnap(quizTimer.getSnapshot());
    }

    function requestExitQuiz() {
      if (isReviewingHistory.value) {
        openProfile('stats');
        return;
      }
      if (!activeExam.value || gradeResult.value !== null) {
        goList();
        return;
      }
      if (showExitQuizConfirm.value) return;
      exitConfirmAutoPaused = !quizTimerPaused.value;
      if (!quizTimerPaused.value) {
        quizTimer.pause();
        applyTimerSnap(quizTimer.getSnapshot());
      }
      showExitQuizConfirm.value = true;
    }

    function cancelExitQuiz() {
      showExitQuizConfirm.value = false;
      if (exitConfirmAutoPaused) {
        quizTimer.resume();
        applyTimerSnap(quizTimer.getSnapshot());
      }
      exitConfirmAutoPaused = false;
    }

    function confirmExitQuiz() {
      saveActiveQuizProgress();
      showExitQuizConfirm.value = false;
      exitConfirmAutoPaused = false;
      goList();
      showToast('Đã lưu tiến trình làm bài', 'success');
    }

    function qKey(sIdx, qIdx, subIdx = null) {
      return subIdx === null || subIdx === undefined ? `${sIdx}_${qIdx}` : `${sIdx}_${qIdx}_${subIdx}`;
    }

    function getSectionQuestionCount(sec) {
      if (!sec || !Array.isArray(sec.questions)) return 0;
      let count = 0;
      sec.questions.forEach((q) => {
        if (q?.type === 'group' && Array.isArray(q.questions)) {
          count += q.questions.length;
        } else {
          count += 1;
        }
      });
      return count;
    }

    function getQuestionDisplayNum(exam, sIdx, qIdx, subIdx = null) {
      const sec = exam?.sections?.[sIdx];
      if (!sec || !Array.isArray(sec.questions)) return qIdx + 1;
      let num = 0;
      for (let i = 0; i < qIdx; i++) {
        const item = sec.questions[i];
        num += item?.type === 'group' && Array.isArray(item.questions) ? item.questions.length : 1;
      }
      if (subIdx !== null && subIdx !== undefined) {
        return num + subIdx + 1;
      }
      return num + 1;
    }

    function getGroupRangeLabel(exam, sIdx, qIdx, groupQ) {
      const start = getQuestionDisplayNum(exam, sIdx, qIdx, 0);
      const count = Array.isArray(groupQ?.questions) ? groupQ.questions.length : 1;
      const end = start + Math.max(1, count) - 1;
      return count > 1 ? `Câu ${start}–${end}` : `Câu ${start}`;
    }

    function getSectionNavItems(sec, sIdx) {
      if (!sec || !Array.isArray(sec.questions)) return [];
      const items = [];
      let num = 1;
      sec.questions.forEach((q, qIdx) => {
        if (q?.type === 'group' && Array.isArray(q.questions)) {
          q.questions.forEach((subQ, subIdx) => {
            items.push({
              key: `${sIdx}_${qIdx}_${subIdx}`,
              num: num++,
              q: subQ,
              sIdx,
              qIdx,
              subIdx
            });
          });
        } else {
          items.push({
            key: `${sIdx}_${qIdx}`,
            num: num++,
            q,
            sIdx,
            qIdx,
            subIdx: null
          });
        }
      });
      return items;
    }

    const quizSectionNavItems = computed(() => {
      if (!activeExam.value || !Array.isArray(activeExam.value.sections)) return [];
      return activeExam.value.sections.map((sec, sIdx) => getSectionNavItems(sec, sIdx));
    });

    const quizQuestionMeta = computed(() => {
      const exam = activeExam.value;
      if (!exam || !Array.isArray(exam.sections)) {
        return {
          numMap: Object.create(null),
          groupRangeMap: Object.create(null),
          maxPointsMap: Object.create(null),
          flat: []
        };
      }
      const ptsMap = quizPointsSummary.value?.questionMaxPoints || {};
      const numMap = Object.create(null);
      const groupRangeMap = Object.create(null);
      const maxPointsMap = Object.create(null);
      const flat = [];
      for (let sIdx = 0; sIdx < exam.sections.length; sIdx++) {
        const qs = exam.sections[sIdx]?.questions || [];
        let num = 1;
        for (let qIdx = 0; qIdx < qs.length; qIdx++) {
          const q = qs[qIdx];
          if (q?.type === 'group' && Array.isArray(q.questions)) {
            const start = num;
            let grpSum = 0;
            for (let subIdx = 0; subIdx < q.questions.length; subIdx++) {
              const key = `${sIdx}_${qIdx}_${subIdx}`;
              const subQ = q.questions[subIdx];
              const mp = ptsMap[key] ?? 0;
              numMap[key] = num++;
              maxPointsMap[key] = mp;
              grpSum += Number(mp);
              flat.push({ key, q: subQ });
            }
            const end = Math.max(start, num - 1);
            const gKey = `${sIdx}_${qIdx}`;
            groupRangeMap[gKey] = end > start ? `Câu ${start}–${end}` : `Câu ${start}`;
            maxPointsMap[gKey] = Number(grpSum.toFixed(4));
          } else {
            const key = `${sIdx}_${qIdx}`;
            const mp = ptsMap[key] ?? 0;
            numMap[key] = num++;
            maxPointsMap[key] = mp;
            flat.push({ key, q });
          }
        }
      }
      return { numMap, groupRangeMap, maxPointsMap, flat };
    });

    function getQuizQuestionNum(sIdx, qIdx, subIdx = null) {
      return quizQuestionMeta.value.numMap[qKey(sIdx, qIdx, subIdx)] ?? (qIdx + 1);
    }

    function getQuizGroupRangeLabel(sIdx, qIdx) {
      return quizQuestionMeta.value.groupRangeMap[`${sIdx}_${qIdx}`] || '';
    }

    function getQuizTargetQuestion(sIdx, qIdx, subIdx = null) {
      const rawQ = activeExam.value?.sections?.[sIdx]?.questions?.[qIdx];
      return (subIdx !== null && subIdx !== undefined) ? rawQ?.questions?.[subIdx] : rawQ;
    }

    function hasSubQuestionText(subQ) {
      return Boolean(String(subQ?.question ?? '').trim());
    }

    function getGroupAnswerSig(q, sIdx, qIdx) {
      if (!q || !Array.isArray(q.questions)) return '';
      let sig = '';
      for (let subIdx = 0; subIdx < q.questions.length; subIdx++) {
        const key = `${sIdx}_${qIdx}_${subIdx}`;
        const ans = userAnswers.value[key];
        const tc = turboChecked.value[key] ? '1' : '0';
        if (ans && typeof ans === 'object') {
          sig += `|${tc}:`;
          for (const k in ans) {
            sig += `${k}=${ans[k]},`;
          }
        } else {
          sig += `|${tc}:${ans ?? ''}`;
        }
      }
      return sig;
    }

    function computeTurboQuestionDetail(sIdx, qIdx, subIdx = null) {
      const id = qKey(sIdx, qIdx, subIdx);
      const q = getQuizTargetQuestion(sIdx, qIdx, subIdx);
      if (!q) return null;
      const detail = gradeSingleQuestion(q, userAnswers.value[id], getQuizQuestionMaxPoints(sIdx, qIdx, subIdx)).detail;
      turboDetailsCache[id] = detail;
      return detail;
    }

    function isQuestionRevealed(sIdx, qIdx, subIdx = null) {
      return Boolean(
        gradeResult.value !== null ||
        (quizTurboMode.value && turboChecked.value[qKey(sIdx, qIdx, subIdx)])
      );
    }

    function isQuestionLocked(sIdx, qIdx, subIdx = null) {
      return isQuestionRevealed(sIdx, qIdx, subIdx);
    }

    function isTfStatementRevealed(sIdx, qIdx, stIdx, subIdx = null) {
      const id = qKey(sIdx, qIdx, subIdx);
      return Boolean(
        gradeResult.value !== null ||
        (quizTurboMode.value && (turboChecked.value[id] || turboChecked.value[`${id}__st_${stIdx}`]))
      );
    }

    function getDisplayDetail(sIdx, qIdx, subIdx = null) {
      const id = qKey(sIdx, qIdx, subIdx);
      if (gradeResult.value) return gradeResult.value.details[id];
      if (!isQuestionRevealed(sIdx, qIdx, subIdx)) return null;
      return turboDetailsCache[id] || computeTurboQuestionDetail(sIdx, qIdx, subIdx);
    }

    function getStatementDisplayResult(sIdx, qIdx, stIdx, subIdx = null) {
      const id = qKey(sIdx, qIdx, subIdx);
      if (gradeResult.value) return gradeResult.value.details[id]?.statementResults?.[stIdx];
      if (!isTfStatementRevealed(sIdx, qIdx, stIdx, subIdx)) return null;
      const detail = turboDetailsCache[id] || computeTurboQuestionDetail(sIdx, qIdx, subIdx);
      return detail?.statementResults?.[stIdx] || null;
    }

    function selectMcOption(sIdx, qIdx, key, subIdx = null) {
      if (gradeResult.value !== null || isQuestionLocked(sIdx, qIdx, subIdx)) return;
      const id = qKey(sIdx, qIdx, subIdx);
      if (userAnswers.value[id] === key && (!quizTurboMode.value || turboChecked.value[id])) return;
      userAnswers.value[id] = key;
      if (quizTurboMode.value) {
        computeTurboQuestionDetail(sIdx, qIdx, subIdx);
        turboChecked.value[id] = true;
      }
    }

    function onMcOptionPointerDown(e, sIdx, qIdx, key, subIdx = null) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (gradeResult.value !== null || isQuestionLocked(sIdx, qIdx, subIdx)) return;
      e.preventDefault();
      lastMouseOptionHandledKey = `${qKey(sIdx, qIdx, subIdx)}_${key}`;
      lastMouseOptionHandledAt = performance.now();
      selectMcOption(sIdx, qIdx, key, subIdx);
    }

    function onMcLabelClick(e, id, key) {
      if (lastMouseOptionHandledKey === `${id}_${key}` && (performance.now() - lastMouseOptionHandledAt) < 400) {
        e.preventDefault();
      }
    }

    function onMcAnswerChange(sIdx, qIdx, subIdx = null) {
      if (!quizTurboMode.value || gradeResult.value !== null) return;
      const id = qKey(sIdx, qIdx, subIdx);
      if (turboChecked.value[id]) return;
      computeTurboQuestionDetail(sIdx, qIdx, subIdx);
      turboChecked.value[id] = true;
    }

    function checkShortAnswerTurbo(sIdx, qIdx, subIdx = null) {
      if (!quizTurboMode.value || isQuestionLocked(sIdx, qIdx, subIdx)) return;
      const id = qKey(sIdx, qIdx, subIdx);
      if (!String(userAnswers.value[id] ?? '').trim()) {
        showToast('Vui lòng nhập đáp án trước khi kiểm tra', 'error', 1800);
        return;
      }
      computeTurboQuestionDetail(sIdx, qIdx, subIdx);
      turboChecked.value[id] = true;
    }

    function getTfPick(sIdx, qIdx, stIdx, subIdx = null) {
      return userAnswers.value[qKey(sIdx, qIdx, subIdx)]?.[stIdx];
    }

    function onTfBtnPointerDown(e, sIdx, qIdx, stIdx, val, subIdx = null) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (gradeResult.value !== null || isTfStatementRevealed(sIdx, qIdx, stIdx, subIdx)) return;
      e.preventDefault();
      setTfPick(sIdx, qIdx, stIdx, val, subIdx);
    }

    function setTfPick(sIdx, qIdx, stIdx, val, subIdx = null) {
      if (gradeResult.value !== null || isTfStatementRevealed(sIdx, qIdx, stIdx, subIdx)) return;
      const qId = qKey(sIdx, qIdx, subIdx);
      const prevMap = userAnswers.value[qId] && typeof userAnswers.value[qId] === 'object'
        ? userAnswers.value[qId]
        : {};
      if (prevMap[stIdx] === val && (!quizTurboMode.value || turboChecked.value[`${qId}__st_${stIdx}`])) return;
      const nextMap = { ...prevMap, [stIdx]: val };
      userAnswers.value[qId] = nextMap;

      if (quizTurboMode.value) {
        computeTurboQuestionDetail(sIdx, qIdx, subIdx);
        turboChecked.value[`${qId}__st_${stIdx}`] = true;
        const targetQ = getQuizTargetQuestion(sIdx, qIdx, subIdx);
        const statements = Array.isArray(targetQ?.statements) ? targetQ.statements : [];
        if (
          statements.length > 0 &&
          statements.every((_, idx) => Boolean(turboChecked.value[`${qId}__st_${idx}`]) || typeof nextMap[idx] === 'boolean')
        ) {
          turboChecked.value[qId] = true;
        }
      }
    }

    function requestSubmitQuiz() {
      if (!activeExam.value || gradeResult.value || showExitQuizConfirm.value) return;
      const preview = gradeExam(activeExam.value, userAnswers.value);
      if (preview.unansweredCount > 0) {
        pendingUnanswered.value = preview.unansweredCount;
        showSubmitConfirm.value = true;
        window.scrollTo(0, 0);
        return;
      }
      finalizeSubmit();
    }

    function finalizeSubmit(opts) {
      if (!activeExam.value || gradeResult.value) return;
      const autoSubmitted = Boolean(opts && typeof opts === 'object' && opts.autoSubmitted === true);
      quizTimer.stop();
      applyTimerSnap(quizTimer.getSnapshot(), { syncFinal: true });
      quizAutoSubmitted.value = autoSubmitted;
      const result = gradeExam(activeExam.value, userAnswers.value);
      gradeResult.value = result;
      showSubmitConfirm.value = false;
      showExitQuizConfirm.value = false;
      exitConfirmAutoPaused = false;
      clearSavedProgress(activeExamId.value);

      const nowTs = Date.now();
      quizSubmittedAt.value = nowTs;
      if (!isReviewingHistory.value) {
        const canonicalAnswers = remapAnswersToCanonical(activeExam.value, userAnswers.value || {});
        const attempt = sanitizeHistoryEntry({
          id: `att-${nowTs}-${Math.random().toString(36).slice(2, 6)}`,
          examId: activeExamId.value || '',
          examTitle: activeExam.value.meta?.title || 'Đề ôn tập',
          subject: getSubjectFromFolder(activeExam.value.meta?.folder || ''),
          scale10: result.scale10,
          rawPoints: result.rawPoints,
          fullCorrectCount: result.fullCorrectCount,
          totalQuestions: result.totalQuestions,
          elapsedSeconds: quizElapsedSeconds.value,
          limitMinutes: quizTimerLimit.value,
          autoSubmitted,
          submittedAt: nowTs,
          userAnswers: canonicalAnswers
        });
        if (attempt) {
          quizHistory.value = [attempt, ...quizHistory.value].slice(0, MAX_HISTORY_ENTRIES);
          persistQuizHistory();
        }
      }
      window.scrollTo(0, 0);
    }

    function exportCurrentQuizResult() {
      if (!activeExam.value || !gradeResult.value) {
        showToast('Chưa có kết quả bài làm để xuất.', 'error');
        return;
      }
      try {
        downloadAttemptExport({
          exam: activeExam.value,
          userAnswers: userAnswers.value || {},
          gradeResult: gradeResult.value,
          elapsedSeconds: quizElapsedSeconds.value,
          limitMinutes: quizTimerLimit.value,
          submittedAt: quizSubmittedAt.value || Date.now(),
          autoSubmitted: quizAutoSubmitted.value
        });
        showToast('Đã xuất file bài làm (.md)', 'success');
      } catch (err) {
        console.error('Lỗi khi xuất bài làm:', err);
        showToast('Không thể xuất file bài làm.', 'error');
      }
    }

    function scrollToQuestion(sIdx, qIdx, subIdx = null) {
      const target = document.getElementById(`qcard_${qKey(sIdx, qIdx, subIdx)}`);
      if (!target) return;
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      target.scrollIntoView({ behavior, block: 'center' });
    }

    function quizCardClass(sIdx, qIdx, subIdx = null) {
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (!d) return '';
      if (d.isFullCorrect) return 'is-correct';
      return d.score > 0 ? 'is-partial' : 'is-wrong';
    }

    function quizBadgeClass(sIdx, qIdx, subIdx = null) {
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (!d) return '';
      if (d.isFullCorrect) return 'badge-success';
      return d.score > 0 ? '' : 'badge-error';
    }

    function quizBadgeText(sIdx, qIdx, subIdx = null) {
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (!d) return '';
      const earned = formatPointNum(d.earnedPoints ?? d.score);
      const max = formatPointNum(d.maxPoints ?? 1);
      if (d.isFullCorrect) return `Đúng (+${earned}/${max}đ)`;
      return d.score > 0 ? `Đúng một phần (+${earned}/${max}đ)` : `Sai (0/${max}đ)`;
    }

    const editorPointsSummary = computed(() => (
      validatedData.value
        ? resolveExamPoints(validatedData.value)
        : { hasCustomPoints: false, totalMaxPoints: 10, sectionMaxPoints: [], questionMaxPoints: {} }
    ));

    const quizPointsSummary = computed(() => (
      activeExam.value
        ? resolveExamPoints(activeExam.value)
        : { hasCustomPoints: false, totalMaxPoints: 10, sectionMaxPoints: [], questionMaxPoints: {} }
    ));

    function formatPointNum(n) {
      const val = Number(n);
      if (!Number.isFinite(val)) return '0';
      return String(Number(val.toFixed(2)));
    }

    function resolveItemMaxPoints(exam, summary, sIdx, qIdx, subIdx = null) {
      const map = summary?.questionMaxPoints || {};
      if (subIdx !== null && subIdx !== undefined) {
        return map[`${sIdx}_${qIdx}_${subIdx}`] ?? 0;
      }
      const q = exam?.sections?.[sIdx]?.questions?.[qIdx];
      if (q?.type === 'group' && Array.isArray(q.questions)) {
        let sum = 0;
        q.questions.forEach((_, idx) => {
          sum += Number(map[`${sIdx}_${qIdx}_${idx}`] ?? 0);
        });
        return Number(sum.toFixed(4));
      }
      return map[`${sIdx}_${qIdx}`] ?? 0;
    }

    function getEditorQuestionMaxPoints(sIdx, qIdx, subIdx = null) {
      return resolveItemMaxPoints(validatedData.value, editorPointsSummary.value, sIdx, qIdx, subIdx);
    }

    function getQuizQuestionMaxPoints(sIdx, qIdx, subIdx = null) {
      return quizQuestionMeta.value.maxPointsMap[qKey(sIdx, qIdx, subIdx)] ?? 0;
    }

    function onSectionPointsInput(sec, rawVal) {
      if (!sec) return;
      const trimmed = String(rawVal ?? '').trim();
      if (trimmed === '') {
        delete sec.points;
        scheduleSyncPreviewToYaml();
        return;
      }
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0 && num <= 100) {
        sec.points = Number(num.toFixed(4));
        scheduleSyncPreviewToYaml();
      }
    }

    function onQuestionPointsInput(q, rawVal) {
      if (!q) return;
      const trimmed = String(rawVal ?? '').trim();
      if (trimmed === '') {
        delete q.points;
        scheduleSyncPreviewToYaml();
        return;
      }
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0 && num <= 100) {
        q.points = Number(num.toFixed(4));
        scheduleSyncPreviewToYaml();
      }
    }

    function clearQuestionPoints(q) {
      if (!q) return;
      delete q.points;
      syncPreviewToYaml();
    }

    function questionTypeShortLabel(type) {
      if (type === 'multiple_choice') return 'TN';
      if (type === 'true_false') return 'Đ/S';
      if (type === 'short_answer') return 'TLN';
      if (type === 'group') return 'Nhóm';
      return String(type || '');
    }

    function questionItemSnippet(q, fallback = 'Câu hỏi chưa có nội dung') {
      if (!q) return fallback;
      if (q.type === 'group') {
        const src = String(q.title || '').trim() || String(q.content || '').trim();
        return src ? plainQuestionSnippet(src) : 'Câu hỏi nhóm';
      }
      const src = String(q.question || '').trim();
      return src ? plainQuestionSnippet(src) : fallback;
    }

    function subQuestionReorderSnippet(subQ) {
      if (!subQ) return 'Câu con';
      const prompt = String(subQ.question || '').trim();
      if (prompt) return plainQuestionSnippet(prompt);
      if (subQ.type === 'multiple_choice' && subQ.options) {
        const preview = ['A', 'B', 'C', 'D']
          .map((k) => (subQ.options[k] ? `${k}. ${subQ.options[k]}` : ''))
          .filter(Boolean)
          .join(' · ');
        return preview ? plainQuestionSnippet(preview) : 'Trắc nghiệm ABCD';
      }
      return 'Câu con (điền khuyết)';
    }

    function plainQuestionSnippet(str) {
      const cleaned = String(str ?? '')
        .replace(/```[^\n]*\n?/g, ' ')
        .replace(/\$\$?/g, '')
        .replace(/\\[()[\]]/g, '')
        .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
        .replace(/__([\s\S]*?)__/g, '$1')
        .replace(/\+\+([\s\S]*?)\+\+/g, '$1')
        .replace(/`+/g, '')
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=\s|[.,;:!?)]|$)/g, '$1$2')
        .replace(/^\s{0,3}#+\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleaned) return 'Câu hỏi chưa có nội dung';
      if (cleaned.length <= 110) return cleaned;
      return `${cleaned.slice(0, 107).trimEnd()}...`;
    }

    function autoDividePointsEqual() {
      if (!validatedData.value) return;
      validatedData.value.sections.forEach((sec) => {
        delete sec.points;
        (sec.questions || []).forEach((q) => {
          delete q.points;
          if (q.type === 'group' && Array.isArray(q.questions)) {
            q.questions.forEach((subQ) => {
              delete subQ.points;
            });
          }
        });
      });
      syncPreviewToYaml();
      showToast('Đã tự chia đều 10 điểm cho toàn bộ câu hỏi', 'success');
    }

    function autoDividePointsBySection() {
      if (!validatedData.value) return;
      const secs = validatedData.value.sections || [];
      if (secs.length === 0) return;
      const eachSec = Number((10 / secs.length).toFixed(2));
      let running = 0;
      secs.forEach((sec, idx) => {
        const pt = idx === secs.length - 1
          ? Number(Math.max(0.1, 10 - running).toFixed(2))
          : eachSec;
        running += pt;
        sec.points = pt;
        (sec.questions || []).forEach((q) => {
          delete q.points;
          if (q.type === 'group' && Array.isArray(q.questions)) {
            q.questions.forEach((subQ) => {
              delete subQ.points;
            });
          }
        });
      });
      syncPreviewToYaml();
      showToast(`Đã tự chia đều 10 điểm cho ${secs.length} phần`, 'success');
    }

    function autoDividePointsThpt() {
      if (!validatedData.value) return;
      const secs = validatedData.value.sections || [];
      let assigned = 0;
      const saQuestions = [];
      const applyToLeaf = (leafQ) => {
        if (leafQ.type === 'multiple_choice') {
          leafQ.points = 0.25;
          assigned += 0.25;
        } else if (leafQ.type === 'true_false') {
          leafQ.points = 1;
          assigned += 1;
        } else {
          delete leafQ.points;
          saQuestions.push(leafQ);
        }
      };
      secs.forEach((sec) => {
        delete sec.points;
        (sec.questions || []).forEach((q) => {
          if (q.type === 'group' && Array.isArray(q.questions)) {
            delete q.points;
            q.questions.forEach(applyToLeaf);
          } else {
            applyToLeaf(q);
          }
        });
      });
      if (saQuestions.length > 0) {
        const rem = Math.max(0, 10 - assigned);
        const saEach = rem > 0 ? Number((rem / saQuestions.length).toFixed(4)) : 0.5;
        saQuestions.forEach((q) => {
          q.points = saEach;
        });
      }
      syncPreviewToYaml();
      showToast('Đã áp dụng thang điểm chuẩn THPT (TN 0.25đ · Đ/S 1.0đ)', 'success');
    }

    function quizOptionClass(q, sIdx, qIdx, key, subIdx = null) {
      const picked = userAnswers.value[qKey(sIdx, qIdx, subIdx)];
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (!d) return picked === key ? 'opt-selected' : '';
      if (key === q.answer) return 'is-locked opt-correct';
      if (picked === key) return 'is-locked opt-wrong';
      return 'is-locked';
    }

    function quizStatementClass(sIdx, qIdx, stIdx, subIdx = null) {
      const stRes = getStatementDisplayResult(sIdx, qIdx, stIdx, subIdx);
      if (!stRes) return '';
      return stRes.isCorrect ? 'st-correct' : 'st-wrong';
    }

    function quizShortInputClass(sIdx, qIdx, subIdx = null) {
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (!d) return '';
      return d.isFullCorrect ? 'input-correct' : 'input-wrong';
    }

    function quizNavCellClass(q, sIdx, qIdx, subIdx = null) {
      const qId = qKey(sIdx, qIdx, subIdx);
      const d = getDisplayDetail(sIdx, qIdx, subIdx);
      if (d) {
        if (d.isFullCorrect) return 'is-correct';
        return d.score > 0 ? 'is-partial' : 'is-wrong';
      }
      return isQuestionAnswered(q, userAnswers.value[qId]) ? 'is-answered' : '';
    }

    function onGlobalWindowClick() {
      if (hasOpenContextMenu) closeContextMenu();
    }

    function onGlobalWindowKeydown(e) {
      if (e.key !== 'Escape') return;
      if (hasOpenContextMenu) {
        closeContextMenu();
        return;
      }
      if (folderModal.value) {
        folderModal.value = null;
        return;
      }
      if (moveModal.value) {
        moveModal.value = null;
        return;
      }
      if (deleteFolderModal.value) {
        deleteFolderModal.value = null;
        return;
      }
      if (deleteHistoryModal.value) {
        deleteHistoryModal.value = null;
        return;
      }
      if (showEditorExitConfirm.value) {
        cancelExitEditor();
      }
    }

    function onGlobalWindowScroll() {
      if (hasOpenContextMenu) closeContextMenu();
    }

    watch(view, (nextView, prevView) => {
      if (nextView !== 'list') {
        closeContextMenu();
        folderModal.value = null;
        moveModal.value = null;
        deleteFolderModal.value = null;
      } else if (prevView === 'quiz') {
        syncExamsFromServer({ notify: true });
      }
      if (nextView !== 'profile') {
        deleteHistoryModal.value = null;
      }
      if (nextView !== 'editor') {
        showEditorExitConfirm.value = false;
      }
    });

    watch([homeTab, searchQuery], () => {
      if (contextMenu.value) closeContextMenu();
    });

    window.addEventListener('click', onGlobalWindowClick);
    window.addEventListener('keydown', onGlobalWindowKeydown);
    window.addEventListener('scroll', onGlobalWindowScroll, { passive: true });
    document.addEventListener('visibilitychange', onDocumentVisibilityChange);

    window.addEventListener('beforeunload', () => {
      if (view.value === 'quiz' && activeExamId.value && gradeResult.value === null) {
        saveActiveQuizProgress();
      }
      window.removeEventListener('click', onGlobalWindowClick);
      window.removeEventListener('keydown', onGlobalWindowKeydown);
      window.removeEventListener('scroll', onGlobalWindowScroll);
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
      clearPreviewSyncTimer();
      clearTimeout(yamlDebounceTimer);
      clearTimeout(copyResetTimer);
      clearTimeout(toastTimer);
      stopServerSyncInterval();
      quizTimer.destroy();
    });

    provide(QUIZ_CTX_KEY, {
      userAnswers,
      turboChecked,
      gradeResult,
      quizTurboMode,
      quizProgressText,
      getQuizQuestionNum,
      getQuizQuestionMaxPoints,
      formatPointNum,
      isQuestionRevealed,
      isTfStatementRevealed,
      getDisplayDetail,
      getStatementDisplayResult,
      quizBadgeText,
      quizNavCellClass,
      hasSubQuestionText,
      renderRichText: renderRichTextReactive,
      selectMcOption,
      onMcOptionPointerDown,
      onMcLabelClick,
      setTfPick,
      onTfBtnPointerDown,
      checkShortAnswerTurbo,
      scrollToQuestion
    });

    loadExams();
    startServerPolling();

    return {
      view, exams, examCards, savedFolders, homeTab, currentFolderPath,
      contextMenu, folderModal, moveModal, deleteFolderModal,
      allFolderPaths, breadcrumbSegments, subjectGpaMap,
      pinnedExamCards, childFolders, visibleExamCards, moveDestinationOptions,
      filteredExamCards, availableFolders,
      presetFolders: PRESET_FOLDERS,
      searchQuery, selectedFolder, sortBy, togglePinExam, resetFilters,
      openFolder, openBlankContextMenu, openFolderContextMenu, openExamContextMenu, closeContextMenu,
      openCreateFolderModal, openRenameFolderModal, submitFolderModal,
      openMoveExamModal, openMoveFolderModal, confirmMoveModal,
      openDeleteFolderModal, confirmDeleteFolder,
      pendingDeleteId, pendingDeleteTitle,
      editorTitle, editorFolder, editorTimeLimit, yamlText, validatedData, editorErrors, canSaveExam,
      monacoReady, richTextReady, editorLeftPanel, setEditorLeftPanel, showEditorJumpMenu, showEditorExitConfirm, jumpToEditorQuestion, copyLabel, previewPaneRef, editorStats, toast, serverConnected,
      activeExam, activeExamId, userAnswers, gradeResult, showSubmitConfirm, pendingUnanswered, quizProgressText,
      showExitQuizConfirm, pendingResumeQuiz,
      turboModePref, toggleTurboModePref, quizTurboMode, turboChecked, quizRenderEpoch, canShuffleActiveExam,
      shuffleTurboQuiz, resetTurboQuiz,
      isQuestionRevealed, isQuestionLocked, isTfStatementRevealed,
      getDisplayDetail, getStatementDisplayResult,
      selectMcOption, onMcOptionPointerDown, onMcAnswerChange, checkShortAnswerTurbo,
      quizTimerLimit, quizTimerDisplayRef, quizElapsedDisplay, quizElapsedSeconds,
      quizTimerPaused, quizTimerStatus, quizTimerMode, quizAutoSubmitted,
      quizSectionNavItems, getQuizQuestionNum, getQuizGroupRangeLabel,
      quizHistory, userProfile, analyticsReady, profileTab, heatmapYear,
      calendarYear, calendarMonth, selectedWeekIndex,
      historyRangeFilter, historySubjectFilter, isReviewingHistory, deleteHistoryModal,
      headerCurrentStreak, profileKpis, subjectAverages, yearHeatmap,
      monthCalendar, weeklyBreakdown, historySubjectOptions, filteredHistoryList,
      formatAttemptDuration, formatAttemptTime,
      openProfile, saveProfileName, shiftCalendarMonth, selectCalendarWeek,
      setHeatmapYear, filterHistoryBySubject, reviewHistoryAttempt, retryHistoryAttempt, exportHistoryAttempt,
      requestDeleteHistoryAttempt, requestClearFilteredHistory, confirmDeleteHistory,
      editorPointsSummary, quizPointsSummary, formatPointNum,
      getEditorQuestionMaxPoints, getQuizQuestionMaxPoints,
      onSectionPointsInput, onQuestionPointsInput, clearQuestionPoints,
      questionTypeShortLabel, plainQuestionSnippet, questionItemSnippet, subQuestionReorderSnippet,
      isReorderGroupExpanded, toggleReorderGroup,
      getSectionQuestionCount, getQuestionDisplayNum, getGroupRangeLabel,
      getSectionNavItems, hasSubQuestionText, getGroupAnswerSig,
      autoDividePointsEqual, autoDividePointsBySection, autoDividePointsThpt,
      renderRichText: renderRichTextReactive,
      renderRichPreviewHtml: renderRichPreviewHtmlReactive,
      lineCount, focusRichInput,
      goList, requestDelete, confirmDelete,
      openEditor, requestExitEditor, cancelExitEditor, discardAndExitEditor, saveAndExitEditor, saveCurrentExam, onHeaderTitleInput, onHeaderFolderInput, onHeaderTimeLimitInput,
      copyAiPrompt, triggerImportYaml, handleImportYamlFile, exportYaml,
      handleYamlInput, handleYamlTab, onLeftPaneInteract, onYamlTextareaCursor, syncPreviewToYaml, scheduleSyncPreviewToYaml,
      changeQuestionType, changeSubQuestionType, addSubQuestion, deleteSubQuestion, moveSubQuestion,
      setStatementBool, addStatement, deleteStatement,
      addShortAnswer, deleteShortAnswer, insertQuestionBelow, insertGroupBelow, addGroupToSection, duplicateQuestion,
      moveQuestion, deleteQuestion, addSection, moveSection, deleteSection,
      startQuiz, resumeSavedQuiz, restartSavedQuiz, cancelResumeQuiz,
      retryQuiz, toggleQuizTimerPause, requestExitQuiz, cancelExitQuiz, confirmExitQuiz,
      getTfPick, setTfPick, onTfBtnPointerDown, requestSubmitQuiz, finalizeSubmit, exportCurrentQuizResult,
      scrollToQuestion, quizCardClass, quizBadgeClass, quizBadgeText,
      quizOptionClass, quizStatementClass, quizShortInputClass, quizNavCellClass
    };
  }
}).mount('#app');
