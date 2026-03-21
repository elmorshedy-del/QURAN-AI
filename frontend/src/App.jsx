import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchAyah, fetchHealth, fetchSegmenterHealth } from "./api";
import { useRecitation } from "./hooks/useRecitation";

const SURAHS = [
  { number: 1, name: "Al-Fatiha", nameAr: "الفاتحة", verses: 7, difficulty: "Beginner", juz: 1 },
  { number: 67, name: "Al-Mulk", nameAr: "الملك", verses: 30, difficulty: "Intermediate", juz: 29 },
  { number: 78, name: "An-Naba", nameAr: "النبأ", verses: 40, difficulty: "Intermediate", juz: 30 },
  { number: 112, name: "Al-Ikhlas", nameAr: "الإخلاص", verses: 4, difficulty: "Beginner", juz: 30 },
  { number: 113, name: "Al-Falaq", nameAr: "الفلق", verses: 5, difficulty: "Beginner", juz: 30 },
  { number: 114, name: "An-Nas", nameAr: "الناس", verses: 6, difficulty: "Beginner", juz: 30 },
];

const MAKHARIJ = [
  { letter: "ق", latin: "Qaaf", origin: "Deep tongue against the soft palate", originAr: "أقصى اللسان مع الحنك اللين" },
  { letter: "ع", latin: "Ayn", origin: "Middle throat constriction", originAr: "وسط الحلق" },
  { letter: "ح", latin: "Haa", origin: "Open middle throat airflow", originAr: "وسط الحلق مع همس" },
  { letter: "ص", latin: "Saad", origin: "Tongue tip with elevated emphasis", originAr: "طرف اللسان مع الاستعلاء" },
  { letter: "ض", latin: "Daad", origin: "Side tongue against upper molars", originAr: "حافة اللسان مع الأضراس العليا" },
  { letter: "ط", latin: "Taa", origin: "Heavy stop at the gum ridge", originAr: "طرف اللسان مع اللثة بتفخيم" },
  { letter: "م", latin: "Meem", origin: "Closed lips with nasal resonance", originAr: "انطباق الشفتين مع غنة" },
  { letter: "ن", latin: "Noon", origin: "Tongue tip with nasal outlet", originAr: "طرف اللسان مع الخيشوم" },
];

function loadStoredProgress() {
  if (typeof window === "undefined") {
    return { sessions: 0, totalMinutes: 0, bestScore: 0, summaries: [] };
  }
  try {
    const raw = window.localStorage.getItem("tajweed-progress-v1");
    return raw ? JSON.parse(raw) : { sessions: 0, totalMinutes: 0, bestScore: 0, summaries: [] };
  } catch {
    return { sessions: 0, totalMinutes: 0, bestScore: 0, summaries: [] };
  }
}

function persistProgress(progress) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem("tajweed-progress-v1", JSON.stringify(progress));
}

function formatAyah(words) {
  return (words || []).join(" ");
}

function ayahCacheKey(surah, ayah) {
  return `${surah}:${ayah}`;
}

function buildReviewItems(summary, ayahPayload) {
  if (!summary?.errors?.length) {
    return [];
  }
  return summary.errors.map((error, index) => ({
    id: `${error.word_index}-${error.rule || error.error_type}-${index}`,
    ...error,
    word_ar: error.word_ar || ayahPayload.words?.[error.word_index] || "",
    audio_url: error.audio_url || ayahPayload.word_audio_urls?.[error.word_index] || null,
  }));
}

function inferDifficultyColor(level) {
  if (level === "Beginner") {
    return "var(--emerald)";
  }
  if (level === "Intermediate") {
    return "var(--gold)";
  }
  return "var(--clay)";
}

function describeBackendStatus(health, error) {
  if (error) {
    return { label: "Unavailable", detail: error };
  }
  if (!health) {
    return { label: "Checking", detail: "Waiting for the backend health response." };
  }
  if (health.ready) {
    const device = health.device ? ` on ${health.device}` : "";
    return { label: "Ready", detail: `${health.model || "Backend model"}${device}` };
  }
  return { label: "Warming", detail: health.model || "The backend is starting up." };
}

function describeSegmenterStatus(health, error) {
  const segmenter = health?.segmenter || null;
  if (error) {
    return { label: "Unavailable", detail: error };
  }
  if (!health || !segmenter) {
    return { label: "Checking", detail: "Waiting for the segmenter health response." };
  }
  if (segmenter.warm_loaded) {
    return { label: "Warm loaded", detail: "Segmenter model is loaded and ready for requests." };
  }
  if (segmenter.ready) {
    return { label: "Cached", detail: "Segmenter service is reachable and its model files are cached." };
  }
  if (segmenter.load_error) {
    return { label: "Error", detail: segmenter.load_error };
  }
  return { label: "Starting", detail: "Segmenter service is reachable but still preparing runtime state." };
}

function describeSocketStatus(sessionState, recitation) {
  const socketState = sessionState.socketState || recitation.socketState || "idle";
  if (recitation.connectionError) {
    return { label: "Error", detail: recitation.connectionError };
  }
  if (socketState === "connected") {
    return { label: "Connected", detail: "WebSocket session is connected to the live recitation backend." };
  }
  if (socketState === "connecting") {
    return { label: "Connecting", detail: "Opening the live recitation socket." };
  }
  if (socketState === "error") {
    return { label: "Error", detail: "The live recitation socket could not be established." };
  }
  return { label: "Idle", detail: "The recitation socket will connect when you start a live session." };
}

function describeAudioStatus(recitation) {
  if (recitation.micPermission === "denied") {
    return { label: "Blocked", detail: "Microphone access is denied in this browser." };
  }
  if (recitation.audioState === "speech") {
    return { label: "Speech detected", detail: "Live audio is reaching the browser capture pipeline." };
  }
  if (recitation.audioState === "quiet") {
    return { label: "Listening", detail: "Microphone is open but the current input level is low." };
  }
  if (recitation.audioState === "requesting") {
    return { label: "Waiting", detail: "Requesting microphone permission." };
  }
  if (recitation.isRecording) {
    return { label: "Open", detail: "Microphone is active and waiting for clearer speech." };
  }
  return { label: "Idle", detail: "Microphone capture starts when you begin a recitation session." };
}

function WaveBars({ active }) {
  return (
    <div className={`wave ${active ? "wave--active" : ""}`}>
      {Array.from({ length: 28 }).map((_, index) => (
        <span
          key={index}
          style={{ animationDelay: `${index * 45}ms` }}
        />
      ))}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("home");
  const [language, setLanguage] = useState("en");
  const [selectedSurah, setSelectedSurah] = useState(SURAHS[0]);
  const [currentAyah, setCurrentAyah] = useState(1);
  const [ayahPayload, setAyahPayload] = useState({ words: [], word_audio_urls: [] });
  const [loadingAyah, setLoadingAyah] = useState(true);
  const [backendHealth, setBackendHealth] = useState(null);
  const [segmenterHealth, setSegmenterHealth] = useState(null);
  const [backendError, setBackendError] = useState("");
  const [segmenterError, setSegmenterError] = useState("");
  const [sessionState, setSessionState] = useState({ status: "idle" });
  const [latestCorrection, setLatestCorrection] = useState(null);
  const [latestSummary, setLatestSummary] = useState(null);
  const [eventFeed, setEventFeed] = useState([]);
  const [progress, setProgress] = useState(loadStoredProgress);
  const [cacheVersion, setCacheVersion] = useState(0);
  const ayahCacheRef = useRef(new Map());
  const ayahRequestCacheRef = useRef(new Map());
  const feedCounterRef = useRef(0);

  const storeAyahPayload = useCallback((surah, ayah, payload) => {
    ayahCacheRef.current.set(ayahCacheKey(surah, ayah), payload);
    setCacheVersion((current) => current + 1);
    return payload;
  }, []);

  const primeAyahPayload = useCallback(
    (surah, ayah) => {
      const key = ayahCacheKey(surah, ayah);
      const cached = ayahCacheRef.current.get(key);
      if (cached) {
        return Promise.resolve(cached);
      }

      const inFlight = ayahRequestCacheRef.current.get(key);
      if (inFlight) {
        return inFlight;
      }

      const request = fetchAyah(surah, ayah)
        .then((payload) => storeAyahPayload(surah, ayah, payload))
        .finally(() => {
          ayahRequestCacheRef.current.delete(key);
        });
      ayahRequestCacheRef.current.set(key, request);
      return request;
    },
    [storeAyahPayload],
  );

  useEffect(() => {
    persistProgress(progress);
  }, [progress]);

  useEffect(() => {
    let cancelled = false;
    async function loadHealth() {
      try {
        const payload = await fetchHealth();
        if (!cancelled) {
          setBackendHealth(payload);
          setBackendError("");
        }
      } catch (error) {
        if (!cancelled) {
          setBackendError(String(error.message || error));
        }
      }
    }
    loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSegmenterHealth() {
      try {
        const payload = await fetchSegmenterHealth();
        if (!cancelled) {
          setSegmenterHealth(payload);
          setSegmenterError("");
        }
      } catch (error) {
        if (!cancelled) {
          setSegmenterError(String(error.message || error));
        }
      }
    }
    loadSegmenterHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadAyahPayload() {
      const cacheKey = ayahCacheKey(selectedSurah.number, currentAyah);
      const cached = ayahCacheRef.current.get(cacheKey);
      if (cached) {
        setAyahPayload(cached);
        setLoadingAyah(false);
      } else {
        setLoadingAyah(true);
      }
      try {
        const payload = await primeAyahPayload(selectedSurah.number, currentAyah);
        if (!cancelled) {
          setAyahPayload(payload);
          setBackendError("");
        }
      } catch (error) {
        if (!cancelled) {
          if (!cached) {
            setAyahPayload({ words: [], word_audio_urls: [] });
          }
          setBackendError(String(error.message || error));
        }
      } finally {
        if (!cancelled) {
          setLoadingAyah(false);
        }
      }
    }
    loadAyahPayload();
    return () => {
      cancelled = true;
    };
  }, [currentAyah, primeAyahPayload, selectedSurah.number]);

  useEffect(() => {
    const candidates = [currentAyah + 1, currentAyah + 2].filter((ayahNumber) => ayahNumber <= selectedSurah.verses);
    if (!candidates.length) {
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      candidates.map((ayahNumber) =>
        primeAyahPayload(selectedSurah.number, ayahNumber).catch(() => null),
      ),
    ).catch(() => {
      if (!cancelled) {
        return null;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentAyah, primeAyahPayload, selectedSurah.number, selectedSurah.verses]);

  const addFeedItem = (item) => {
    const id = `${Date.now()}-${feedCounterRef.current}`;
    feedCounterRef.current += 1;
    setEventFeed((current) => [{ id, ...item }, ...current].slice(0, 6));
  };

  const recitation = useRecitation({
    surah: selectedSurah.number,
    ayah: currentAyah,
    onReady: (message) => {
      if (Array.isArray(message.words) && message.words.length) {
        const payload = {
          words: message.words,
          word_audio_urls: message.word_audio_urls || [],
        };
        storeAyahPayload(message.surah, message.ayah, payload);
        if (message.surah === selectedSurah.number && message.ayah === currentAyah) {
          setAyahPayload(payload);
          setLoadingAyah(false);
        }
      }
      addFeedItem({
        kind: "ready",
        title: "Session ready",
        titleAr: "الجلسة جاهزة",
        body: `${message.total_words} words loaded for this ayah.`,
      });
    },
    onCorrection: (message) => {
      setLatestCorrection(message);
      addFeedItem({
        kind: "correction",
        title: message.rule || "Tajweed note",
        titleAr: message.word_ar || "تصحيح",
        body: message.description,
      });
    },
    onCorrect: () => {},
    onSummary: (message) => {
      setLatestSummary(message);
      setLatestCorrection(null);
      setProgress((current) => {
        const next = {
          sessions: current.sessions + 1,
          totalMinutes: current.totalMinutes + 2,
          bestScore: Math.max(current.bestScore, message.score || 0),
          summaries: [
            {
              score: message.score,
              errors: message.total_flagged_words ?? message.total_errors,
              surah: selectedSurah.number,
              ayah: currentAyah,
              createdAt: new Date().toISOString(),
            },
            ...current.summaries,
          ].slice(0, 12),
        };
        return next;
      });
      addFeedItem({
        kind: "summary",
        title: `Score ${message.score}`,
        titleAr: "ملخص التلاوة",
        body:
          message.total_flagged_words > 0
            ? `${message.total_flagged_words} words need review in this ayah.`
            : "No rule-level issues were flagged in this pass.",
      });
    },
    onStateChange: setSessionState,
  });

  const ayahText = useMemo(() => formatAyah(ayahPayload.words), [ayahPayload.words]);
  const reviewItems = useMemo(() => buildReviewItems(latestSummary, ayahPayload), [ayahPayload, latestSummary]);
  const flaggedWordIndexes = useMemo(
    () => new Set(reviewItems.map((item) => item.word_index)),
    [reviewItems],
  );
  const nextAyahNumber = useMemo(
    () => (currentAyah < selectedSurah.verses ? currentAyah + 1 : null),
    [currentAyah, selectedSurah.verses],
  );
  const nextAyahPayload = useMemo(
    () =>
      nextAyahNumber === null
        ? null
        : ayahCacheRef.current.get(ayahCacheKey(selectedSurah.number, nextAyahNumber)) || null,
    [cacheVersion, nextAyahNumber, selectedSurah.number],
  );
  const nextAyahText = useMemo(
    () => formatAyah(nextAyahPayload?.words || []),
    [nextAyahPayload],
  );
  const difficultyColor = inferDifficultyColor(selectedSurah.difficulty);
  const backendStatus = describeBackendStatus(backendHealth, backendError);
  const segmenterStatus = describeSegmenterStatus(segmenterHealth, segmenterError);
  const socketStatus = describeSocketStatus(sessionState, recitation);
  const audioStatus = describeAudioStatus(recitation);
  const t = (en, ar) => (language === "ar" ? ar : en);

  const playReference = (url) => {
    if (!url) {
      return;
    }
    const audio = new Audio(url);
    audio.play().catch(() => {});
  };

  const nextAyah = () => {
    const nextAyahNumber = Math.min(selectedSurah.verses, currentAyah + 1);
    if (nextAyahNumber === currentAyah) {
      return;
    }
    const cached = ayahCacheRef.current.get(ayahCacheKey(selectedSurah.number, nextAyahNumber));
    if (cached) {
      setAyahPayload(cached);
      setLoadingAyah(false);
    } else {
      setLoadingAyah(true);
      void primeAyahPayload(selectedSurah.number, nextAyahNumber).catch(() => {});
    }
    startTransition(() => {
      setCurrentAyah(nextAyahNumber);
    });
    setLatestCorrection(null);
    setLatestSummary(null);
    setEventFeed([]);
  };

  const previousAyah = () => {
    const previousAyahNumber = Math.max(1, currentAyah - 1);
    if (previousAyahNumber === currentAyah) {
      return;
    }
    const cached = ayahCacheRef.current.get(ayahCacheKey(selectedSurah.number, previousAyahNumber));
    if (cached) {
      setAyahPayload(cached);
      setLoadingAyah(false);
    } else {
      setLoadingAyah(true);
      void primeAyahPayload(selectedSurah.number, previousAyahNumber).catch(() => {});
    }
    startTransition(() => {
      setCurrentAyah(previousAyahNumber);
    });
    setLatestCorrection(null);
    setLatestSummary(null);
    setEventFeed([]);
  };

  return (
    <div className={language === "ar" ? "app-shell app-shell--rtl" : "app-shell"}>
      <div className="bg-orb bg-orb--top" />
      <div className="bg-orb bg-orb--side" />

      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">﷽</span>
          <div>
            <p className="eyebrow">{t("AI Quran Recitation Coach", "موجّه تلاوة القرآن بالذكاء الاصطناعي")}</p>
            <h1>الترتيل · Al Tarteel</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <nav className="nav-tabs">
            {[
              ["home", t("Home", "الرئيسية")],
              ["practice", t("Practice", "التدريب")],
              ["makharij", t("Letter sounds", "مخارج الحروف")],
              ["journey", t("Progress", "التقدم")],
            ].map(([id, label]) => (
              <button
                key={id}
                className={view === id ? "nav-tab nav-tab--active" : "nav-tab"}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="lang-switch" aria-label="Language switch">
            <button
              type="button"
              className={language === "en" ? "lang-switch__button lang-switch__button--active" : "lang-switch__button"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
            <button
              type="button"
              className={language === "ar" ? "lang-switch__button lang-switch__button--active" : "lang-switch__button"}
              onClick={() => setLanguage("ar")}
            >
              AR
            </button>
          </div>
        </div>
      </header>

      {view === "home" && (
        <main className="page page--home">
          <section className="hero-card">
            <div className="hero-copy">
              <p className="eyebrow">{t("One ayah at a time", "آية واحدة في كل مرة")}</p>
              <h2>{t("Recite, hear what needs revision, then repeat with a clear example.", "اقرأ، اسمع ما يحتاج مراجعة، ثم أعد القراءة مع مثال واضح.")}</h2>
              <p className="hero-text">
                {t(
                  "The current website helps you practice a single ayah, stop, review the words that need work, and replay the Husary example for those words.",
                  "الموقع الحالي يساعدك على تدريب آية واحدة، ثم التوقف، ومراجعة الكلمات التي تحتاج عملاً، وتشغيل مثال الحصري لهذه الكلمات."
                )}
              </p>
              <div className="hero-actions">
                <button className="button button--primary" onClick={() => setView("practice")}>
                  {t("Start practicing now", "ابدأ التدريب الآن")}
                </button>
                <button className="button button--ghost" onClick={() => setView("makharij")}>
                  {t("Open letter sounds guide", "افتح دليل مخارج الحروف")}
                </button>
              </div>
            </div>

            <aside className="hero-guide">
              <div className="hero-guide__card">
                <span className="status-label">{t("What it does now", "ما الذي يفعله الآن")}</span>
                <strong>{t("Guided ayah practice", "تدريب موجّه على الآيات")}</strong>
                <p>{t("You recite one ayah, get a short review list, and hear the Husary word again where needed.", "تقرأ آية واحدة، ثم تحصل على قائمة مراجعة قصيرة، وتسمع كلمة الحصري مرة أخرى عند الحاجة.")}</p>
              </div>
              <div className="hero-guide__card">
                <span className="status-label">{t("What it does not do yet", "ما الذي لا يفعله بعد")}</span>
                <strong>{t("Not full Quran coverage yet", "ليس تغطية كاملة لكل القرآن بعد")}</strong>
                <p>{t("Some surahs are still being tightened for production, so the strongest experience today is on the guided paths already wired end to end.", "بعض السور ما زالت قيد التشديد للإطلاق، لذلك أقوى تجربة اليوم هي في المسارات الموصولة بالكامل من البداية إلى النهاية.")}</p>
              </div>
              <div className="hero-guide__card">
                <span className="status-label">{t("What future versions will add", "ما الذي ستضيفه النسخ القادمة")}</span>
                <strong>{t("Smoother full-surah reading", "تلاوة أسلس للسور كاملة")}</strong>
                <p>{t("Future versions will support more continuous reading, stronger non-Fatiha coverage, and clearer teacher-style progress tracking.", "النسخ القادمة ستدعم تلاوة أكثر استمرارية، وتغطية أقوى خارج الفاتحة، وتتبعاً أوضح للتقدم بأسلوب المعلم.")}</p>
              </div>
            </aside>
          </section>

          <section className="capability-grid">
            <article className="capability-card">
              <span className="capability-ar">{t("1", "١")}</span>
              <h3>{t("Read the ayah", "اقرأ الآية")}</h3>
              <p>{t("Open practice mode, choose a surah, and read the current ayah from start to finish in one pass.", "افتح وضع التدريب، واختر السورة، ثم اقرأ الآية الحالية من البداية إلى النهاية في مرور واحد.")}</p>
            </article>
            <article className="capability-card">
              <span className="capability-ar">{t("2", "٢")}</span>
              <h3>{t("Review flagged words", "راجع الكلمات المعلّمة")}</h3>
              <p>{t("After you stop, the app turns the result into a short revision queue instead of a flood of raw technical messages.", "بعد التوقف، يحول التطبيق النتيجة إلى قائمة مراجعة قصيرة بدلاً من سيل من الرسائل التقنية الخام.")}</p>
            </article>
            <article className="capability-card">
              <span className="capability-ar">{t("3", "٣")}</span>
              <h3>{t("Replay Husary and repeat", "استمع للحصري ثم أعد القراءة")}</h3>
              <p>{t("Use the built-in Husary playback for the exact word that needs revision, then recite the full ayah again smoothly.", "استخدم تشغيل الحصري المدمج للكلمة نفسها التي تحتاج مراجعة، ثم أعد تلاوة الآية كاملة بسلاسة.")}</p>
            </article>
          </section>

          <section className="overview-grid">
            <article className="panel">
              <div className="panel-heading">
                <h3>{t("Current focus", "التركيز الحالي")}</h3>
                <p>{t("Straightforward, user-facing practice flow", "تجربة بسيطة وواضحة للمستخدم")}</p>
              </div>
              <div className="simple-list">
                <div className="simple-list__item">
                  <strong>{t("What you will see", "ما الذي ستراه")}</strong>
                  <p>{t("The current ayah, a clear live note if something important happens, and a short revision queue after you stop.", "الآية الحالية، وملاحظة مباشرة واضحة إذا ظهر شيء مهم، ثم قائمة مراجعة قصيرة بعد التوقف.")}</p>
                </div>
                <div className="simple-list__item">
                  <strong>{t("What you will not see", "ما الذي لن تراه")}</strong>
                  <p>{t("Dense model jargon, long phoneme dumps, or health-check details mixed into the main reading experience.", "لن ترى مصطلحات نماذج كثيفة، أو سطور فونيمات طويلة، أو تفاصيل فحص الصحة داخل تجربة القراءة الأساسية.")}</p>
                </div>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <h3>{t("Start with these guided surahs", "ابدأ بهذه السور الموجّهة")}</h3>
                <p>{t("Choose a path that is already wired for the current practice flow.", "اختر مساراً موصولاً بالفعل مع تجربة التدريب الحالية.")}</p>
              </div>
              <div className="surah-list">
                {SURAHS.slice(0, 4).map((surah) => (
                  <button
                    key={surah.number}
                    className="surah-row"
                    onClick={() => {
                      setSelectedSurah(surah);
                      setCurrentAyah(1);
                      setEventFeed([]);
                      setView("practice");
                    }}
                  >
                    <div>
                      <strong>{surah.name}</strong>
                      <span>{surah.verses} ayahs · Juz {surah.juz}</span>
                    </div>
                    <div className="surah-meta">
                      <span className="surah-ar">{surah.nameAr}</span>
                      <span className="badge" style={{ color: inferDifficultyColor(surah.difficulty) }}>
                        {surah.difficulty}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </article>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h3>{t("Debug panel", "لوحة التصحيح")}</h3>
              <p>{t("Model readiness and connection details for troubleshooting only.", "جاهزية النماذج وتفاصيل الاتصال للتشخيص فقط.")}</p>
            </div>
            <div className="debug-grid">
              <div className="status-card">
                <span className="status-label">{t("Backend", "الخلفية")}</span>
                <strong>{backendStatus.label}</strong>
                <p>{backendStatus.detail}</p>
              </div>
              <div className="status-card">
                <span className="status-label">{t("Segmenter", "المقطّع")}</span>
                <strong>{segmenterStatus.label}</strong>
                <p>{segmenterStatus.detail}</p>
              </div>
              <div className="status-card">
                <span className="status-label">{t("Socket", "الاتصال")}</span>
                <strong>{socketStatus.label}</strong>
                <p>{socketStatus.detail}</p>
              </div>
              <div className="status-card">
                <span className="status-label">{t("Audio", "الصوت")}</span>
                <strong>{audioStatus.label}</strong>
                <p>{audioStatus.detail}</p>
                <small>{recitation.isRecording ? `Input level ${Math.max(1, Math.round(recitation.audioLevel * 900))}%` : t("Mic idle", "الميكروفون غير نشط")}</small>
              </div>
            </div>
          </section>
        </main>
      )}

      {view === "practice" && (
        <main className="page page--practice">
          <section className="practice-layout">
            <aside className="practice-sidebar panel">
              <div className="panel-heading">
                <h3>{t("Surah library", "مكتبة السور")}</h3>
                <p>{t("Choose a guided surah for practice", "اختر سورة موجّهة للتدريب")}</p>
              </div>
              <div className="surah-list">
                {SURAHS.map((surah) => (
                  <button
                    key={surah.number}
                    className={selectedSurah.number === surah.number ? "surah-row surah-row--active" : "surah-row"}
                    disabled={recitation.isRecording}
                    onClick={() => {
                      setSelectedSurah(surah);
                      setCurrentAyah(1);
                      setLatestCorrection(null);
                      setLatestSummary(null);
                      setEventFeed([]);
                    }}
                  >
                    <div>
                      <strong>{surah.name}</strong>
                      <span>{surah.verses} ayahs · Juz {surah.juz}</span>
                    </div>
                    <div className="surah-meta">
                      <span className="surah-ar">{surah.nameAr}</span>
                      <span className="badge" style={{ color: inferDifficultyColor(surah.difficulty) }}>
                        {surah.difficulty}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <section className="practice-main">
              <article className="panel ayah-panel">
                <div className="practice-header">
                  <div>
                    <span className="eyebrow">{t("Practice studio", "استوديو التدريب")}</span>
                    <h2>
                      {selectedSurah.nameAr} · {selectedSurah.name}
                    </h2>
                    <p>
                      {t(`Ayah ${currentAyah} of ${selectedSurah.verses}`, `الآية ${currentAyah} من ${selectedSurah.verses}`)}
                    </p>
                  </div>
                  <div className="practice-meta">
                    <span className="badge" style={{ color: difficultyColor }}>
                      {selectedSurah.difficulty}
                    </span>
                    <span className="badge">
                      {recitation.isConnected ? t("Live session ready", "الجلسة المباشرة جاهزة") : t("Session idle", "الجلسة غير نشطة")}
                    </span>
                  </div>
                </div>

                <div className="ayah-card">
                  <div className="reading-flow">
                    <div className="reading-flow__current">
                      <span className="status-label">{t("Current ayah", "الآية الحالية")}</span>
                      <strong>{t(`Ayah ${currentAyah}`, `الآية ${currentAyah}`)}</strong>
                      <p>{t("Read this ayah in one calm pass, then stop for revision.", "اقرأ هذه الآية في مرور هادئ واحد، ثم توقف للمراجعة.")}</p>
                    </div>
                    <div className={nextAyahPayload ? "reading-flow__next reading-flow__next--ready" : "reading-flow__next"}>
                      <span className="status-label">{t("Up next", "التالي")}</span>
                      <strong>
                        {nextAyahNumber ? t(`Ayah ${nextAyahNumber}`, `الآية ${nextAyahNumber}`) : t("End of surah", "نهاية السورة")}
                      </strong>
                      <p>
                        {nextAyahNumber
                          ? nextAyahPayload
                            ? nextAyahText || t("Ready to open instantly.", "جاهزة للفتح فوراً.")
                            : t("Preparing the next ayah in the background now.", "يتم تجهيز الآية التالية في الخلفية الآن.")
                          : t("You are on the last ayah of this guided surah.", "أنت على آخر آية في هذه السورة الموجّهة.")}
                      </p>
                    </div>
                  </div>
                  {loadingAyah ? (
                    <div className="loading-block">
                      <div className="loading-pulse loading-pulse--ayah" />
                      <p className="muted">{t("Loading ayah text…", "جاري تحميل نص الآية…")}</p>
                    </div>
                  ) : ayahText ? (
                    <>
                      <p className="ayah-ar">{ayahText}</p>
                      <p className="muted">{t("Tap any word chip to hear the Husary reference. Flagged words will be marked for revision here after each pass.", "اضغط على أي كلمة لسماع مثال الحصري. الكلمات التي تحتاج مراجعة ستظهر هنا بعد كل محاولة.")}</p>
                      <div className="word-grid">
                        {ayahPayload.words.map((word, index) => (
                          <button
                            type="button"
                            key={`${word}-${index}`}
                            className={flaggedWordIndexes.has(index) ? "word-chip word-chip--flagged" : "word-chip"}
                            onClick={() => playReference(ayahPayload.word_audio_urls?.[index])}
                            disabled={!ayahPayload.word_audio_urls?.[index]}
                          >
                            <span>{index + 1}</span>
                            <strong>{word}</strong>
                            {flaggedWordIndexes.has(index) ? <small>{t("Review", "مراجعة")}</small> : <small>{t("Husary", "الحصري")}</small>}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="muted">{t("No ayah data returned for this selection.", "لا توجد بيانات لهذه الآية حالياً.")}</p>
                  )}
                </div>

                <div className="control-row">
                  <button className="button button--ghost" onClick={previousAyah} disabled={currentAyah === 1 || recitation.isRecording}>
                    {t("Previous ayah", "الآية السابقة")}
                  </button>
                  {!recitation.isRecording ? (
                    <button className="button button--primary" onClick={recitation.startRecording}>
                      {t("Start live recitation", "ابدأ التلاوة المباشرة")}
                    </button>
                  ) : (
                    <button className="button button--danger" onClick={recitation.stopRecording}>
                      {t("Stop and review", "أوقف وراجع")}
                    </button>
                  )}
                  <button
                    className={nextAyahPayload ? "button button--primary button--soft" : "button button--ghost"}
                    onClick={nextAyah}
                    disabled={currentAyah === selectedSurah.verses || recitation.isRecording}
                  >
                    {nextAyahPayload ? t("Next ayah is ready", "الآية التالية جاهزة") : t("Next ayah", "الآية التالية")}
                  </button>
                </div>

                <div className="live-strip">
                  <div>
                    <span className="status-label">{t("Session state", "حالة الجلسة")}</span>
                    <strong>{sessionState.status || "idle"}</strong>
                  </div>
                  <div>
                    <span className="status-label">{t("Connection", "الاتصال")}</span>
                    <strong>{socketStatus.label}</strong>
                  </div>
                  <div>
                    <span className="status-label">{t("Mic", "الميكروفون")}</span>
                    <strong>{audioStatus.label}</strong>
                  </div>
                </div>

                <WaveBars active={recitation.isRecording} />
              </article>

              <div className="feedback-grid feedback-grid--practice">
                <article className="panel review-panel">
                  <div className="panel-heading">
                    <h3>{t("Revision queue", "قائمة المراجعة")}</h3>
                    <p>{t("Words that need work, with direct Husary playback", "الكلمات التي تحتاج عملاً مع تشغيل مباشر للحصري")}</p>
                  </div>
                  {latestSummary ? (
                    reviewItems.length ? (
                      <>
                        <div className="summary-block">
                          <div className="score-ring">
                            <span>{latestSummary.score}</span>
                          </div>
                          <div>
                            <strong>{t(`${reviewItems.length} words need revision`, `${reviewItems.length} كلمات تحتاج مراجعة`)}</strong>
                            <p>{t("Listen to the Husary word, then repeat the full ayah from the start with the same flow.", "استمع إلى كلمة الحصري، ثم أعد الآية كاملة من البداية بنفس السلاسة.")}</p>
                          </div>
                        </div>
                        <div className="review-list">
                          {reviewItems.map((item) => (
                            <div key={item.id} className="review-item">
                              <div className="review-head">
                                <div>
                                  <strong>{item.word_ar || `Word ${item.word_index + 1}`}</strong>
                                  <span>{item.rule || item.error_type}</span>
                                </div>
                                <span className={`review-severity review-severity--${item.severity || "medium"}`}>
                                  {item.severity || "medium"}
                                </span>
                              </div>
                              <p>{item.description}</p>
                              <div className="review-actions">
                                <button
                                  type="button"
                                  className="button button--primary button--compact"
                                  onClick={() => playReference(item.audio_url)}
                                  disabled={!item.audio_url}
                                >
                                  {t("Play Husary word", "شغّل كلمة الحصري")}
                                </button>
                                <span className="review-meta">{t(`Word ${item.word_index + 1}`, `الكلمة ${item.word_index + 1}`)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="review-success">
                        <div className="summary-block">
                          <div className="score-ring">
                            <span>{latestSummary.score}</span>
                          </div>
                          <div>
                            <strong>{t("Ayah passed cleanly", "تمت الآية بشكل سليم")}</strong>
                            <p>{t("No rule-level issues were flagged in this pass. Move to the next ayah or repeat for stability.", "لم تُرصد ملاحظات على مستوى القواعد في هذه المحاولة. انتقل إلى الآية التالية أو أعدها للتثبيت.")}</p>
                          </div>
                        </div>
                        <div className="review-actions">
                          <button
                            type="button"
                            className="button button--primary"
                            onClick={nextAyah}
                            disabled={currentAyah === selectedSurah.verses}
                          >
                            {t("Load next ayah", "حمّل الآية التالية")}
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <p className="muted">{t("Stop the recitation once to generate a clear review queue with Husary playback.", "أوقف التلاوة مرة واحدة لتوليد قائمة مراجعة واضحة مع تشغيل الحصري.")}</p>
                  )}
                </article>

                <div className="practice-sidepanels">
                  <article className="panel">
                    <div className="panel-heading">
                      <h3>{t("Live note", "الملاحظة المباشرة")}</h3>
                      <p>{t("Only the most important current note", "أهم ملاحظة حالية فقط")}</p>
                    </div>
                    {latestCorrection ? (
                      <div className="feedback-card feedback-card--warning">
                        <div className="feedback-topline">
                          <strong>{latestCorrection.word_ar || "Correction"}</strong>
                          <span>{latestCorrection.rule || latestCorrection.error_type}</span>
                        </div>
                        <p>{latestCorrection.description}</p>
                        <div className="review-actions">
                          <button
                            type="button"
                            className="button button--ghost button--compact"
                            onClick={() => playReference(latestCorrection.audio_url)}
                            disabled={!latestCorrection.audio_url}
                          >
                            {t("Play Husary word", "شغّل كلمة الحصري")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="muted">{t("No live correction is active. Start reciting to hear the first important note only.", "لا توجد ملاحظة مباشرة حالياً. ابدأ التلاوة لسماع أول ملاحظة مهمة فقط.")}</p>
                    )}
                  </article>

                  <article className="panel">
                    <div className="panel-heading">
                      <h3>{t("Session log", "سجل الجلسة")}</h3>
                      <p>{t("A short timeline of the current pass", "تسلسل مختصر للمحاولة الحالية")}</p>
                    </div>
                    <div className="feed-list">
                      {eventFeed.length ? (
                        eventFeed.map((item) => (
                          <div key={item.id} className="feed-item">
                            <div className="feed-head">
                              <strong>{item.title}</strong>
                              <span>{item.titleAr}</span>
                            </div>
                            <p>{item.body}</p>
                          </div>
                        ))
                      ) : (
                        <p className="muted">{t("No session events yet.", "لا توجد أحداث للجلسة بعد.")}</p>
                      )}
                    </div>
                  </article>
                </div>
              </div>
            </section>
          </section>
        </main>
      )}

      {view === "makharij" && (
        <main className="page">
          <section className="panel">
            <div className="panel-heading">
              <h2>{t("Letter sounds guide", "دليل مخارج الحروف")}</h2>
              <p>{t("A simple reference for the core letter sounds used in the current feedback.", "مرجع بسيط لأهم مخارج الحروف المستخدمة في الملاحظات الحالية.")}</p>
            </div>
            <div className="makharij-grid">
              {MAKHARIJ.map((item) => (
                <article key={item.letter} className="makhraj-card">
                  <span className="makhraj-letter">{item.letter}</span>
                  <div>
                    <h3>{item.latin}</h3>
                    <p>{item.origin}</p>
                    <p className="makhraj-ar">{item.originAr}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      )}

      {view === "journey" && (
        <main className="page">
          <section className="journey-grid">
            <article className="panel">
              <div className="panel-heading">
                <h2>{t("Practice progress", "تقدم التدريب")}</h2>
                <p>{t("A simple view of your recent sessions", "عرض بسيط لجلساتك الأخيرة")}</p>
              </div>
              <div className="metrics-grid">
                <div className="metric-card">
                  <strong>{progress.sessions}</strong>
                  <span>{t("Sessions", "الجلسات")}</span>
                </div>
                <div className="metric-card">
                  <strong>{progress.totalMinutes}</strong>
                  <span>{t("Tracked minutes", "الدقائق المسجّلة")}</span>
                </div>
                <div className="metric-card">
                  <strong>{progress.bestScore}</strong>
                  <span>{t("Best score", "أفضل نتيجة")}</span>
                </div>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <h2>{t("Recent summaries", "الملخصات الأخيرة")}</h2>
                <p>{t("Saved locally on this device", "محفوظة محلياً على هذا الجهاز")}</p>
              </div>
              <div className="feed-list">
                {progress.summaries.length ? (
                  progress.summaries.map((summary, index) => (
                      <div key={`${summary.createdAt}-${index}`} className="feed-item">
                      <div className="feed-head">
                        <strong>
                          Surah {summary.surah}, Ayah {summary.ayah}
                        </strong>
                        <span>Score {summary.score}</span>
                      </div>
                      <p>{summary.errors} flagged words in this saved session.</p>
                    </div>
                  ))
                ) : (
                  <p className="muted">{t("No local summaries yet. Complete one recording session to populate this panel.", "لا توجد ملخصات محلية بعد. أكمل جلسة تسجيل واحدة لملء هذه اللوحة.")}</p>
                )}
              </div>
            </article>
          </section>
        </main>
      )}
    </div>
  );
}
