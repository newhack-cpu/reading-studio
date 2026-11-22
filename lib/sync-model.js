'use strict';

// Shared cross-device sync & exam-track analytics model used by both OPPO Android APK and Huawei Tablet Web.
const SyncModel = (() => {
  const EXAM_TRACKS = {
    cet4: { id: 'cet4', label: '四级 CET-4', defaultDate: '2026-12-12', defaultBook: 'cet4', focus: '基础词汇覆盖、直接定位速度与常规句意理解' },
    cet6: { id: 'cet6', label: '六级 CET-6', defaultDate: '2026-12-12', defaultBook: 'cet6', focus: '高频学术词、同义替换识别、长段扫读定位与听力反应' },
    kaoyan1: { id: 'kaoyan1', label: '考研英语一', defaultDate: '2027-12-18', defaultBook: 'core', focus: '熟词僻义、超长难句主干与指代、推断题过度推理及态度陷阱' },
    kaoyan2: { id: 'kaoyan2', label: '考研英语二', defaultDate: '2027-12-18', defaultBook: 'core', focus: '核心词汇稳固、细节定位准确率与图表/应用文表达' },
  };

  const ERROR_TAGS = [
    '生词卡壳',
    '熟词僻义',
    '长难句结构',
    '定位偏差',
    '过度推理',
    '选项偷换概念',
    '粗心漏看',
  ];

  const QUESTION_TYPES = ['细节题', '推断题', '主旨题', '态度题', '词义题', '例证题'];

  function normWord(word) {
    return String(word || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function daysUntil(dateStr, now = Date.now()) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3_600_000;
    const todayStart = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
    return Math.round((target - todayStart) / 86_400_000);
  }

  function cardStamp(card) {
    if (!card || typeof card !== 'object') return 0;
    return Number(card.history?.lastStudy || card.history?.lastReview || card.updatedAt || 0);
  }

  function pickCard(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = cardStamp(a);
    const tb = cardStamp(b);
    if (ta !== tb) return tb > ta ? b : a;
    if ((b.reps || 0) !== (a.reps || 0)) return (b.reps || 0) > (a.reps || 0) ? b : a;
    return (b.due || 0) >= (a.due || 0) ? b : a;
  }

  function mergeBundles(local, remote) {
    const a = local && typeof local === 'object' ? local : {};
    const b = remote && typeof remote === 'object' ? remote : {};

    // 1. Profile (latest updatedAt wins)
    const pa = a.profile || {};
    const pb = b.profile || {};
    const profile = (pb.updatedAt || 0) > (pa.updatedAt || 0) ? { ...pa, ...pb } : { ...pb, ...pa };
    if (!EXAM_TRACKS[profile.examTrack]) profile.examTrack = 'cet6';
    if (!profile.examDate) profile.examDate = EXAM_TRACKS[profile.examTrack].defaultDate;

    // 2. Devices timestamps
    const devices = { ...(b.devices || {}), ...(a.devices || {}) };

    // 3. Vocab cards, events, days, personal, collectedQueue
    const va = a.vocab || {};
    const vb = b.vocab || {};
    const cards = { ...(vb.cards || {}) };
    for (const [id, card] of Object.entries(va.cards || {})) {
      cards[id] = pickCard(cards[id], card);
    }

    const eventMap = new Map();
    for (const ev of [...(vb.events || []), ...(va.events || [])]) {
      if (ev && ev.id && !eventMap.has(ev.id)) eventMap.set(ev.id, ev);
    }
    const events = [...eventMap.values()].sort((x, y) => (x.t || 0) - (y.t || 0)).slice(-8000);

    const days = {};
    const allDayKeys = new Set([...Object.keys(vb.days || {}), ...Object.keys(va.days || {})]);
    for (const d of allDayKeys) {
      const rowA = va.days?.[d] || {};
      const rowB = vb.days?.[d] || {};
      const mergedDay = {};
      for (const metric of new Set([...Object.keys(rowA), ...Object.keys(rowB)])) {
        mergedDay[metric] = Math.max(Number(rowA[metric] || 0), Number(rowB[metric] || 0));
      }
      days[d] = mergedDay;
    }

    const personalMap = new Map();
    for (const item of [...(vb.personal || []), ...(va.personal || [])]) {
      if (!item || !item.word) continue;
      const key = normWord(item.word);
      const prev = personalMap.get(key);
      if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) personalMap.set(key, item);
    }
    const personal = [...personalMap.values()];

    const queueMap = new Map();
    for (const item of [...(vb.collectedQueue || []), ...(va.collectedQueue || [])]) {
      if (!item || !item.word) continue;
      const key = normWord(item.word);
      const prev = queueMap.get(key);
      if (!prev) queueMap.set(key, { ...item });
      else {
        const prevTs = Math.max(prev.updatedAt || 0, prev.collectedAt || 0);
        const itemTs = Math.max(item.updatedAt || 0, item.collectedAt || 0);
        const newer = itemTs >= prevTs ? item : prev;
        const older = itemTs >= prevTs ? prev : item;
        queueMap.set(key, {
          ...older,
          ...newer,
          collectedAt: Math.max(prev.collectedAt || 0, item.collectedAt || 0),
          updatedAt: Math.max(prevTs, itemTs),
          consumedOnPhone: itemTs === prevTs
            ? Boolean(prev.consumedOnPhone || item.consumedOnPhone)
            : Boolean(newer.consumedOnPhone),
          writingTag: itemTs === prevTs
            ? Boolean(prev.writingTag || item.writingTag)
            : Boolean(newer.writingTag),
          deleted: Boolean(newer.deleted),
        });
      }
    }
    const collectedQueue = [...queueMap.values()].sort((x, y) => (y.collectedAt || 0) - (x.collectedAt || 0));

    // 4. Reading attempts & highlights
    const ra = a.reading || {};
    const rb = b.reading || {};
    const attemptMap = new Map();
    for (const att of [...(rb.attempts || []), ...(ra.attempts || [])]) {
      if (!att || !att.id) continue;
      const prev = attemptMap.get(att.id);
      if (!prev || (att.updatedAt || att.submittedAt || 0) >= (prev.updatedAt || prev.submittedAt || 0)) {
        attemptMap.set(att.id, att);
      }
    }
    const attempts = [...attemptMap.values()].sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0));

    const highlights = {};
    for (const pid of new Set([...Object.keys(rb.highlights || {}), ...Object.keys(ra.highlights || {})])) {
      highlights[pid] = [...new Set([...(rb.highlights?.[pid] || []), ...(ra.highlights?.[pid] || [])])];
    }

    const paraNotes = {};
    for (const pid of new Set([...Object.keys(rb.paraNotes || {}), ...Object.keys(ra.paraNotes || {})])) {
      paraNotes[pid] = { ...(rb.paraNotes?.[pid] || {}), ...(ra.paraNotes?.[pid] || {}) };
    }

    const masteredMistakes = { ...(rb.masteredMistakes || {}), ...(ra.masteredMistakes || {}) };

    // 5. Listening attempts (deduped by id, latest updatedAt wins)
    const la = a.listening || {};
    const lb = b.listening || {};
    const listenMap = new Map();
    for (const att of [...(lb.attempts || []), ...(la.attempts || [])]) {
      if (!att || !att.id) continue;
      const prev = listenMap.get(att.id);
      if (!prev || (att.updatedAt || att.submittedAt || 0) >= (prev.updatedAt || prev.submittedAt || 0)) {
        listenMap.set(att.id, att);
      }
    }
    const listeningAttempts = [...listenMap.values()].sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0));

    return {
      syncVersion: 1,
      updatedAt: Date.now(),
      devices,
      profile,
      vocab: { cards, events, days, personal, collectedQueue },
      reading: { attempts, highlights, paraNotes, masteredMistakes },
      listening: { attempts: listeningAttempts },
    };
  }

  function readingSummary(attempts = [], vocabCards = {}, collectedQueue = []) {
    const list = Array.isArray(attempts) ? attempts : [];
    const byDifficulty = {};
    const byType = {};
    const byErrorTag = {};
    let totalQ = 0;
    let totalCorrect = 0;
    let totalSec = 0;
    let hesitantTotal = 0;
    let hesitantWrong = 0;
    const recentMistakes = [];

    for (const att of list) {
      const diff = att.difficulty || 'L2';
      byDifficulty[diff] ||= { passages: 0, correct: 0, total: 0, sec: 0 };
      byDifficulty[diff].passages++;
      byDifficulty[diff].sec += att.durationSec || 0;
      totalSec += att.durationSec || 0;

      for (const item of (att.items || [])) {
        totalQ++;
        byDifficulty[diff].total++;
        const qtype = item.type || '细节题';
        byType[qtype] ||= { correct: 0, total: 0 };
        byType[qtype].total++;
        if (item.correct) {
          totalCorrect++;
          byDifficulty[diff].correct++;
          byType[qtype].correct++;
        }
        if (item.mark === 'hesitant') {
          hesitantTotal++;
          if (!item.correct) hesitantWrong++;
        }
        for (const tag of (item.errorTags || [])) {
          byErrorTag[tag] = (byErrorTag[tag] || 0) + 1;
        }
        if (!item.correct && recentMistakes.length < 15) {
          recentMistakes.push({
            passageId: att.passageId,
            title: att.title || att.passageId,
            difficulty: diff,
            no: item.no,
            type: qtype,
            errorTags: item.errorTags || [],
            note: item.note || '',
          });
        }
      }
    }

    // Cross-reference reading collected words with phone vocab SM-2 cards
    const activeCollected = (collectedQueue || []).filter(x => x && !x.deleted);
    let collectedTotal = activeCollected.length;
    let collectedAlreadyLearned = 0;
    let collectedUnseen = 0;
    let collectedLapsed = 0;
    for (const item of activeCollected) {
      const wid = item.id || `w:${normWord(item.word)}`;
      const card = vocabCards[wid];
      if (!card || card.phase === 'queued') collectedUnseen++;
      else if (card.lapses > 0 || card.grade === 1) collectedLapsed++;
      else collectedAlreadyLearned++;
    }

    return {
      passagesDone: list.length,
      totalQuestions: totalQ,
      totalCorrect,
      accuracy: totalQ ? Math.round((totalCorrect / totalQ) * 1000) / 1000 : null,
      avgMinutesPerPassage: list.length ? Math.round((totalSec / list.length / 60) * 10) / 10 : null,
      hesitantTotal,
      hesitantWrong,
      byDifficulty,
      byType,
      byErrorTag,
      recentMistakes,
      vocabBridge: {
        collectedTotal,
        collectedUnseen,
        collectedLapsed,
        collectedAlreadyLearned,
      },
    };
  }

  return { EXAM_TRACKS, ERROR_TAGS, QUESTION_TYPES, normWord, daysUntil, mergeBundles, readingSummary };
})();

if (typeof module !== 'undefined') module.exports = SyncModel;
