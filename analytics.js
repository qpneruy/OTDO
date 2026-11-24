function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a timestamp or Date into a local YYYY-MM-DD key.
 */
export function toLocalDateKey(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateKeyLocal(dateKey) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

function addDaysToKey(dateKey, deltaDays) {
  const dt = parseDateKeyLocal(dateKey);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateKey(dt);
}

/**
 * Format duration in seconds into compact Vietnamese label (0p, 45s, 15p, 1h35m).
 */
export function formatCompactDuration(totalSeconds) {
  const sec = Number.isFinite(Number(totalSeconds)) ? Math.max(0, Math.floor(Number(totalSeconds))) : 0;
  if (sec === 0) return '0p';
  if (sec < 60) return `${sec}s`;
  const totalMinutes = Math.round(sec / 60);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}p`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h${pad2(mins)}m` : `${hours}h`;
}

/**
 * Format submission timestamp into DD/MM/YY HH:mm:ss.
 */
export function formatSubmittedAt(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const yy = String(d.getFullYear()).slice(-2);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${yy} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Compute current streak, best streak, and active day set from attempt history.
 */
export function computeStreaks(history = [], nowMs = Date.now()) {
  const keySet = new Set();
  for (const item of history || []) {
    const key = toLocalDateKey(item?.submittedAt);
    if (key) keySet.add(key);
  }

  const sortedKeys = Array.from(keySet).sort();
  if (sortedKeys.length === 0) {
    return { currentStreak: 0, bestStreak: 0, activeDaysCount: 0, activeDateKeys: [] };
  }

  let bestStreak = 1;
  let run = 1;
  for (let i = 1; i < sortedKeys.length; i++) {
    if (addDaysToKey(sortedKeys[i - 1], 1) === sortedKeys[i]) {
      run++;
      if (run > bestStreak) bestStreak = run;
    } else {
      run = 1;
    }
  }

  const todayKey = toLocalDateKey(nowMs);
  const yesterdayKey = addDaysToKey(todayKey, -1);
  let anchor = keySet.has(todayKey) ? todayKey : keySet.has(yesterdayKey) ? yesterdayKey : null;
  let currentStreak = 0;
  while (anchor && keySet.has(anchor)) {
    currentStreak++;
    anchor = addDaysToKey(anchor, -1);
  }

  return {
    currentStreak,
    bestStreak,
    activeDaysCount: sortedKeys.length,
    activeDateKeys: sortedKeys
  };
}

/**
 * Compute overall KPIs across all recorded attempts.
 */
export function computeOverallKpis(history = [], nowMs = Date.now()) {
  const list = Array.isArray(history) ? history : [];
  const streaks = computeStreaks(list, nowMs);
  if (list.length === 0) {
    return {
      totalAttempts: 0,
      avgScore: 0,
      bestScore: 0,
      totalSeconds: 0,
      totalDurationText: '0p',
      currentStreak: 0,
      bestStreak: 0,
      activeDaysCount: 0
    };
  }

  let sumScore = 0;
  let bestScore = 0;
  let totalSeconds = 0;
  for (const item of list) {
    const sc = Number(item?.scale10) || 0;
    const sec = Math.max(0, Math.floor(Number(item?.elapsedSeconds) || 0));
    sumScore += sc;
    if (sc > bestScore) bestScore = sc;
    totalSeconds += sec;
  }

  return {
    totalAttempts: list.length,
    avgScore: Number((sumScore / list.length).toFixed(2)),
    bestScore: Number(bestScore.toFixed(2)),
    totalSeconds,
    totalDurationText: formatCompactDuration(totalSeconds),
    currentStreak: streaks.currentStreak,
    bestStreak: streaks.bestStreak,
    activeDaysCount: streaks.activeDaysCount
  };
}

/**
 * Extract the root subject segment from a folder/subject path, defaulting to 'Chưa phân loại'.
 */
export function extractRootSubject(raw) {
  return String(raw || '').split('/').map((s) => s.trim()).filter(Boolean)[0] || 'Chưa phân loại';
}

/**
 * Compute GPA / average score breakdown per subject (meta.folder).
 */
export function computeSubjectAverages(history = []) {
  const map = new Map();
  for (const item of history || []) {
    const subject = extractRootSubject(item?.subject);
    const sc = Number(item?.scale10) || 0;
    const sec = Math.max(0, Math.floor(Number(item?.elapsedSeconds) || 0));
    let group = map.get(subject);
    if (!group) {
      group = { subject, attempts: 0, sumScore: 0, bestScore: 0, totalSeconds: 0 };
      map.set(subject, group);
    }
    group.attempts++;
    group.sumScore += sc;
    if (sc > group.bestScore) group.bestScore = sc;
    group.totalSeconds += sec;
  }

  return Array.from(map.values())
    .map((g) => {
      const avgScore = Number((g.sumScore / g.attempts).toFixed(2));
      const bestScore = Number(g.bestScore.toFixed(2));
      const avgSeconds = Math.round(g.totalSeconds / g.attempts);
      const level = avgScore >= 8 ? 'excellent' : avgScore >= 6.5 ? 'good' : avgScore >= 5 ? 'fair' : 'low';
      return {
        subject: g.subject,
        attempts: g.attempts,
        avgScore,
        bestScore,
        totalSeconds: g.totalSeconds,
        totalDurationText: formatCompactDuration(g.totalSeconds),
        avgDurationText: formatCompactDuration(avgSeconds),
        scorePercent: Math.min(100, Math.max(0, Math.round(avgScore * 10))),
        level
      };
    })
    .sort((a, b) => (b.attempts - a.attempts) || a.subject.localeCompare(b.subject, 'vi'));
}

function getMondayFirstDayIndex(dateObj) {
  return (dateObj.getDay() + 6) % 7; // Mon=0 .. Sun=6
}

const MONTH_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Build a 365/366-day Monday-first heatmap for a target year.
 */
export function buildYearHeatmap(history = [], year = new Date().getFullYear(), nowMs = Date.now()) {
  const targetYear = Number(year) || new Date(nowMs).getFullYear();
  const currentYear = new Date(nowMs).getFullYear();
  const yearSet = new Set([currentYear, targetYear]);

  const dailyMap = new Map();
  for (const item of history || []) {
    const d = new Date(Number(item?.submittedAt));
    if (Number.isNaN(d.getTime())) continue;
    yearSet.add(d.getFullYear());
    if (d.getFullYear() !== targetYear) continue;
    const key = toLocalDateKey(d);
    let rec = dailyMap.get(key);
    if (!rec) {
      rec = { count: 0, totalSeconds: 0, sumScore: 0 };
      dailyMap.set(key, rec);
    }
    rec.count++;
    rec.totalSeconds += Math.max(0, Math.floor(Number(item?.elapsedSeconds) || 0));
    rec.sumScore += Number(item?.scale10) || 0;
  }

  const jan1 = new Date(targetYear, 0, 1, 12, 0, 0, 0);
  const dec31 = new Date(targetYear, 11, 31, 12, 0, 0, 0);
  const startOffset = getMondayFirstDayIndex(jan1);

  const weeks = [];
  const monthLabels = [];
  const seenMonths = new Set();
  let totalDaysInYear = 0;
  let activeDaysInYear = 0;

  let cur = new Date(targetYear, 0, 1 - startOffset, 12, 0, 0, 0);
  while (cur <= dec31 || getMondayFirstDayIndex(cur) !== 0) {
    const weekIndex = weeks.length;
    const days = [];
    for (let dow = 0; dow < 7; dow++) {
      const inYear = cur.getFullYear() === targetYear;
      const dateKey = toLocalDateKey(cur);
      const monthIdx = cur.getMonth();
      const dayOfMonth = cur.getDate();

      if (inYear && dayOfMonth === 1 && !seenMonths.has(monthIdx)) {
        seenMonths.add(monthIdx);
        monthLabels.push({ monthIndex: monthIdx, label: MONTH_SHORT_EN[monthIdx], weekIndex });
      }

      if (!inYear) {
        days.push({ dateKey, inYear: false, count: 0, level: -1, tooltip: '' });
      } else {
        totalDaysInYear++;
        const stat = dailyMap.get(dateKey);
        const count = stat ? stat.count : 0;
        const totalSeconds = stat ? stat.totalSeconds : 0;
        const avgScore = stat && count > 0 ? Number((stat.sumScore / count).toFixed(2)) : 0;
        if (count > 0) activeDaysInYear++;
        const level = count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : count === 3 ? 3 : 4;
        const dStr = `${pad2(dayOfMonth)}/${pad2(monthIdx + 1)}/${targetYear}`;
        const tooltip = count > 0
          ? `${dStr}: ${count} bài · ${formatCompactDuration(totalSeconds)} · ĐTB ${avgScore}/10`
          : `${dStr}: Chưa làm bài`;
        days.push({
          dateKey,
          inYear: true,
          dayOfMonth,
          monthIndex: monthIdx,
          count,
          totalSeconds,
          avgScore,
          level,
          tooltip
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push({ weekIndex, days });
    if (cur > dec31 && getMondayFirstDayIndex(cur) === 0) break;
  }

  const availableYears = Array.from(yearSet).sort((a, b) => b - a);
  return {
    year: targetYear,
    totalDaysInYear,
    activeDaysInYear,
    weeks,
    monthLabels,
    availableYears
  };
}

/**
 * Build Monday-first calendar week rows for a specific (year, monthIndex 0..11).
 */
export function buildMonthCalendarWeeks(year, monthIndex, history = [], nowMs = Date.now()) {
  const firstDay = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const targetYear = firstDay.getFullYear();
  const targetMonth = firstDay.getMonth();
  const lastDay = new Date(targetYear, targetMonth + 1, 0, 12, 0, 0, 0);
  const todayKey = toLocalDateKey(nowMs);

  const dailyMap = new Map();
  for (const item of history || []) {
    const key = toLocalDateKey(item?.submittedAt);
    if (!key) continue;
    let rec = dailyMap.get(key);
    if (!rec) {
      rec = { count: 0, totalSeconds: 0 };
      dailyMap.set(key, rec);
    }
    rec.count++;
    rec.totalSeconds += Math.max(0, Math.floor(Number(item?.elapsedSeconds) || 0));
  }

  const startOffset = getMondayFirstDayIndex(firstDay);
  let cur = new Date(targetYear, targetMonth, 1 - startOffset, 12, 0, 0, 0);
  const weeks = [];
  let defaultWeekIndex = 0;
  let foundToday = false;

  while (cur <= lastDay || getMondayFirstDayIndex(cur) !== 0) {
    const weekIdx = weeks.length;
    const days = [];
    let weekAttempts = 0;
    for (let dow = 0; dow < 7; dow++) {
      const dateKey = toLocalDateKey(cur);
      const inMonth = cur.getMonth() === targetMonth && cur.getFullYear() === targetYear;
      const isToday = dateKey === todayKey;
      const stat = dailyMap.get(dateKey);
      const count = stat ? stat.count : 0;
      const totalSeconds = stat ? stat.totalSeconds : 0;
      weekAttempts += count;
      if (isToday) {
        defaultWeekIndex = weekIdx;
        foundToday = true;
      }
      days.push({
        dateKey,
        day: cur.getDate(),
        month: cur.getMonth() + 1,
        year: cur.getFullYear(),
        inMonth,
        isToday,
        count,
        totalSeconds
      });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push({
      weekIndex: weekIdx,
      label: `Tuần ${weekIdx + 1}`,
      days,
      weekAttempts
    });
    if (cur > lastDay && getMondayFirstDayIndex(cur) === 0) break;
  }

  if (!foundToday) {
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].weekAttempts > 0) {
        defaultWeekIndex = i;
        break;
      }
    }
  }

  return {
    year: targetYear,
    monthIndex: targetMonth,
    monthLabel: `Tháng ${targetMonth + 1} - ${targetYear}`,
    weeks,
    defaultWeekIndex
  };
}

const DOW_LABELS_VI = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/**
 * Build the weekly breakdown panel ("Số bài làm trong tuần") for a selected calendar week row.
 */
export function buildWeeklyBreakdown(weekRow, history = [], presetSubjects = []) {
  const rawDays = weekRow?.days && weekRow.days.length === 7 ? weekRow.days : [];
  if (rawDays.length !== 7) {
    return {
      rangeLabel: '',
      days: [],
      subjectRows: [],
      weekTotalAttempts: 0,
      weekTotalSeconds: 0,
      weekTotalDurationText: '0p',
      avgDailyDurationText: '0p/ngày'
    };
  }

  const keyIndexMap = new Map();
  rawDays.forEach((d, idx) => keyIndexMap.set(d.dateKey, idx));

  const dayTotals = rawDays.map(() => ({ count: 0, totalSeconds: 0 }));
  const subjectList = [];
  const seenSubjects = new Set();
  const addSubject = (s) => {
    const clean = extractRootSubject(s);
    if (!seenSubjects.has(clean)) {
      seenSubjects.add(clean);
      subjectList.push(clean);
    }
    return clean;
  };

  (presetSubjects || []).slice(0, 5).forEach(addSubject);

  const subjectMatrix = new Map();
  for (const item of history || []) {
    const key = toLocalDateKey(item?.submittedAt);
    if (!keyIndexMap.has(key)) continue;
    const dayIdx = keyIndexMap.get(key);
    const subj = addSubject(extractRootSubject(item?.subject));
    if (!subjectMatrix.has(subj)) {
      subjectMatrix.set(subj, [0, 0, 0, 0, 0, 0, 0]);
    }
    subjectMatrix.get(subj)[dayIdx]++;
    dayTotals[dayIdx].count++;
    dayTotals[dayIdx].totalSeconds += Math.max(0, Math.floor(Number(item?.elapsedSeconds) || 0));
  }

  const subjectRows = subjectList.map((subject) => {
    const countsByDay = subjectMatrix.get(subject) || [0, 0, 0, 0, 0, 0, 0];
    const totalInWeek = countsByDay.reduce((a, b) => a + b, 0);
    return { subject, countsByDay, totalInWeek };
  });

  let weekTotalAttempts = 0;
  let weekTotalSeconds = 0;
  const days = rawDays.map((d, idx) => {
    const count = dayTotals[idx].count;
    const totalSeconds = dayTotals[idx].totalSeconds;
    weekTotalAttempts += count;
    weekTotalSeconds += totalSeconds;
    return {
      dowLabel: DOW_LABELS_VI[idx],
      shortDate: `${pad2(d.day)}/${pad2(d.month)}`,
      dateKey: d.dateKey,
      isToday: Boolean(d.isToday),
      hasActivity: count > 0,
      count,
      totalSeconds,
      durationText: count > 0 ? formatCompactDuration(totalSeconds) : '-'
    };
  });

  const first = rawDays[0];
  const last = rawDays[6];
  const rangeLabel = first.month === last.month
    ? `Ngày ${first.day} → ${last.day} tháng ${last.month} ${last.year}`
    : `Ngày ${first.day}/${first.month} → ${last.day}/${last.month} ${last.year}`;

  const avgDailySeconds = Math.round(weekTotalSeconds / 7);
  return {
    rangeLabel,
    days,
    subjectRows,
    weekTotalAttempts,
    weekTotalSeconds,
    weekTotalDurationText: formatCompactDuration(weekTotalSeconds),
    avgDailyDurationText: `${formatCompactDuration(avgDailySeconds)}/ngày`
  };
}

/**
 * Filter attempt history by time range ('all' | '7d' | '30d' | 'year') and subject.
 */
export function filterHistory(history = [], { range = 'all', subject = 'ALL', nowMs = Date.now() } = {}) {
  const list = Array.isArray(history) ? history : [];
  const nowYear = new Date(nowMs).getFullYear();
  const cutoffMs = range === '7d'
    ? nowMs - 7 * 86400 * 1000
    : range === '30d'
      ? nowMs - 30 * 86400 * 1000
      : null;

  return list
    .filter((item) => {
      const ts = Number(item?.submittedAt) || 0;
      if (cutoffMs !== null && ts < cutoffMs) return false;
      if (range === 'year' && new Date(ts).getFullYear() !== nowYear) return false;
      if (subject && subject !== 'ALL') {
        const itemSubj = extractRootSubject(item?.subject);
        if (itemSubj !== subject) return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => (Number(b.submittedAt) || 0) - (Number(a.submittedAt) || 0));
}
