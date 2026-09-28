// Web Speech API wrapper. SpeechRecognition is Chrome/Chromium-only; everything else works without it.
const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const voiceSupported = !!SR;

export function createRecognizer(cb: {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onSilence: () => void;
  onError: (err: string) => void;
}) {
  if (!SR) return { start() {}, stop() {} };
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let active = false;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let pending = ""; // heard but not final yet

  rec.onresult = (e: any) => {
    if (!active) return; // after Stop, the caller already kept what was heard; late results would duplicate it
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) cb.onFinal(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    pending = interim.trim();
    cb.onInterim(pending);
    clearTimeout(silence);
    silence = setTimeout(cb.onSilence, 1500); // a pause after speech
  };
  // Chrome ends continuous recognition on its own every so often; keep it alive while we want it.
  // When Chrome restarts it, a phrase that never became final would be lost: keep it as final.
  rec.onend = () => {
    if (!active) return;
    if (pending) { cb.onFinal(pending); cb.onInterim(""); pending = ""; }
    try { rec.start(); } catch { /* already started */ }
  };
  rec.onerror = (e: any) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") active = false;
    cb.onError(e.error);
  };

  return {
    start() { if (active) return; active = true; try { rec.start(); } catch { /* already started */ } },
    stop() { active = false; clearTimeout(silence); cb.onInterim(""); try { rec.stop(); } catch { /* not started */ } },
  };
}

export const sentences = (text: string) =>
  (text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);

/** Speaks sentence by sentence (also keeps Chrome's long-utterance cut-off away); onSentence(i) fires as each starts. */
export function speak(text: string, onDone: () => void, onSentence?: (i: number) => void) {
  onSentence?.(0);
  if (!("speechSynthesis" in window) || !text.trim()) return onDone();
  let finished = false;
  const done = () => { if (!finished) { finished = true; clearTimeout(guard); onDone(); } };
  // ponytail: Chrome sometimes never fires onend; a length-based guard unsticks the turn
  const guard = setTimeout(done, 3000 + text.length * 90);
  speechSynthesis.cancel();
  const parts = sentences(text);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.onstart = () => onSentence?.(i);
    u.onerror = done; // also fires when cancelled (Stop / interrupt)
    if (i === parts.length - 1) u.onend = done;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
