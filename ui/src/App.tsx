import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { Canvas, applyAiTurn, exportImage, migrateNotes, serialize, fit } from "./Canvas";
import { ChatPanel, type ChatMsg, type Toggles } from "./ChatPanel";
import { connect, type Msg } from "./socket";
import { createRecognizer, sentences, speak, stopSpeaking, voiceSupported } from "./voice";
import { TemplatePicker, scaffold, type Template } from "./TemplatePicker";
import "./App.css";

type Phase = "user" | "thinking" | "speaking" | "ended";
type Tab = { id: string; name: string; template?: string };
export type Tokens = { turn: { in: number; out: number }; last: { in: number; out: number }; total: { in: number; out: number } };
const PHASE_LABEL: Record<Phase, string> = { user: "Your turn", thinking: "AI is thinking…", speaking: "AI is speaking…", ended: "Session ended" };

export default function App() {
  const [title, setTitle] = useState("Design session");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [phase, setPhase] = useState<Phase>("user");
  const [connected, setConnected] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [toggles, setToggles] = useState<Toggles>({ mute: false, autoEnd: false, interject: true });
  // You drive the mic: Talk starts listening, Stop sends. Clicking Talk while the AI speaks cuts it off.
  const [listening, setListening] = useState(false);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [voiceError, setVoiceError] = useState("");
  // Auto-end on silence doesn't send straight away: the transcript is shown for a few seconds so it can be fixed.
  const [countdown, setCountdown] = useState<number | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "b1", name: "Main" }]);
  const [active, setActive] = useState("b1");
  const [status, setStatus] = useState("");
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [undo, setUndo] = useState<{ board: string; elements: any[] } | null>(null);
  const [notice, setNotice] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [picker, setPicker] = useState<"new" | "apply" | null>(null);

  const api = useRef<any>(null);
  // Excalidraw is hydrated through initialData; until the scene holds the server's elements we must not
  // sync, or Excalidraw's initial empty scene would overwrite the server state.
  const initial = useMemo(() => { let resolve!: (v: any) => void; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; }, []);
  const expected = useRef(Infinity);
  const sock = useRef<ReturnType<typeof connect> | null>(null);
  const lastSig = useRef("");
  const syncTimer = useRef<ReturnType<typeof setTimeout>>();
  const usedVoice = useRef(false);
  const lastSketch = useRef("");
  const rejected = useRef(false);
  const interrupted = useRef(false); // the user cut the AI's speech short
  const interjecting = useRef(false); // the AI is cutting in while the user holds the floor
  const lastPartial = useRef("");
  const hlTimer = useRef<ReturnType<typeof setTimeout>>();
  const speech = useRef<{ text: string; i: number; along?: (i: number) => void }>({ text: "", i: 0 });
  const scenes = useRef(new Map<string, any[]>()); // elements of the tabs not on screen
  // Latest values for callbacks created once (socket + recognizer).
  const live = useRef({ draft, interim, toggles, phase, active, tabs, answers, listening });
  live.current = { ...live.current, draft, interim, toggles, phase, answers, listening };

  const point = (ids: string[]) => {
    clearTimeout(hlTimer.current);
    setHighlight(ids);
    if (ids.length) hlTimer.current = setTimeout(() => setHighlight([]), 15_000);
  };
  /**
   * Pointing that follows the speech: during each sentence, glow the highlighted shapes it mentions (by label
   * words or id). If no sentence names any of them, they all glow for the whole reply.
   */
  const say = (text: string, along: ((i: number) => void) | undefined, after: () => void) => {
    speech.current = { text, i: 0, along };
    speak(text, () => { speech.current = { text: "", i: 0 }; point([]); after(); }, (i) => { speech.current.i = i; speech.current.along?.(i); });
  };
  const pointAlong = (ids: string[], text: string) => {
    const els = api.current?.getSceneElements() ?? [];
    const STOP = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "via", "per", "its", "our", "your"]);
    const words = (id: string) => {
      const e = els.find((x: any) => x.id === id);
      const label = els.find((x: any) => x.containerId === id)?.text ?? e?.text ?? e?.name ?? "";
      return [id, ...String(label).toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length >= 3 && !STOP.has(w));
    };
    const per = sentences(text).map((s) => { const low = s.toLowerCase(); return ids.filter((id) => words(id).some((w) => low.includes(w))); });
    const named = per.some((p) => p.length);
    return (i: number) => { if (!named) point(ids); else if (per[i]?.length) point(per[i]); };
  };
  const selectedIds = () => {
    const a = api.current;
    if (!a) return [];
    const byId = new Map(a.getSceneElements().map((e: any) => [e.id, e]));
    return [...new Set(Object.keys(a.getAppState().selectedElementIds ?? {})
      .map((id) => (byId.get(id) as any)?.containerId ?? id).filter((id) => byId.has(id)))];
  };

  const send = (m: Msg) => sock.current?.send(m);

  /** Put a tab on screen; the one leaving is stashed and synced right away. */
  const showTab = useCallback((id: string) => {
    const a = api.current, cur = live.current.active;
    if (!a || id === cur) return;
    scenes.current.set(cur, a.getSceneElementsIncludingDeleted());
    clearTimeout(syncTimer.current);
    send({ type: "scene", board: cur, elements: serialize(a) });
    live.current.active = id;
    setActive(id);
    a.updateScene({ elements: scenes.current.get(id) ?? [], captureUpdate: CaptureUpdateAction.NEVER });
    a.history.clear(); // undo must not cross tabs
    lastSig.current = "";
    setTimeout(() => fit(a), 0);
  }, []);

  const saveTabs = (next: Tab[]) => { setTabs(next); live.current.tabs = next; send({ type: "boards", boards: next }); };

  const loadState = (m: Msg) => {
    const boards: { id: string; name: string; elements: any[] }[] = m.boards;
    const act = boards.find((b) => b.id === m.active)?.id ?? boards[0].id;
    for (const b of boards) scenes.current.set(b.id, migrateNotes(b.elements));
    const list = boards.map(({ id, name, template }: any) => ({ id, name, ...(template && { template }) }));
    setTabs(list); live.current.tabs = list;
    const elements = scenes.current.get(act)!;
    live.current.active = act;
    setActive(act);
    if (expected.current === Infinity) {
      expected.current = elements.length;
      initial.resolve({ elements, scrollToContent: true });
    } else api.current?.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  };

  const endTurn = useCallback(async (opts: { done?: boolean; answers?: Record<string, string[]>; applyTemplate?: Template } = {}) => {
    const { draft, interim, phase, active, tabs } = live.current;
    if (phase !== "user" || !api.current) return;
    setPhase("thinking");
    setCountdown(null);
    setNotice("");
    setListening(false);
    point([]);
    const picked = Object.entries(opts.answers ?? live.current.answers).filter(([, v]) => v.length)
      .map(([id, v]) => ({ id, answer: v.length === 1 ? v[0] : v }));
    const message = `${draft} ${interim}`.trim() || (opts.done ? "I'm done." : ""); // the server words template requests
    const a = api.current;
    const els = a.getSceneElements();
    const selected = selectedIds(); // whatever is selected when the turn ends is what "this"/"these" refers to
    // Freehand strokes only reach the agent as bounding boxes, so send a picture when they changed.
    const sketch = els.filter((e: any) => e.type === "freedraw").map((e: any) => `${e.id}:${e.version}`).join();
    let image: string | undefined;
    if (sketch && sketch !== lastSketch.current) {
      try { image = await exportImage(a, "png", 1024); } catch { /* send the turn without it */ }
    }
    lastSketch.current = sketch;
    send({
      type: "user_turn",
      input_mode: !message && !picked.length && !opts.applyTemplate ? "canvas_only" : usedVoice.current ? "voice" : "text",
      message, board: active, boards: tabs, elements: serialize(a), selected, image,
      answers: picked, rejected: rejected.current, done: !!opts.done, apply_template: opts.applyTemplate?.id, interrupted: interrupted.current,
    });
    usedVoice.current = false;
    rejected.current = false;
    interrupted.current = false;
    lastPartial.current = "";
    setDraft(""); setInterim(""); setAnswers({}); setUndo(null);
  }, []);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) { endTurn(); return; }
    const t = setTimeout(() => setCountdown((c) => (c === null ? c : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, endTurn]);

  const onAiTurn = useCallback(async (m: Msg) => {
    setStatus("");
    const board = m.board as { id: string; name: string };
    const cur = live.current.tabs;
    if (!cur.some((t) => t.id === board.id && t.name === board.name)) { // new tab, or the AI named the default one
      const next = cur.some((t) => t.id === board.id) ? cur.map((t) => (t.id === board.id ? { ...t, name: board.name } : t)) : [...cur, { id: board.id, name: board.name }];
      setTabs(next); live.current.tabs = next;
    }
    showTab(board.id);
    const before = api.current.getSceneElementsIncludingDeleted();
    let reply: Msg;
    try {
      const { failed } = applyAiTurn(api.current, m as any);
      reply = { reqId: m.reqId, board: board.id, elements: serialize(api.current), failed };
    } catch (e) {
      reply = { reqId: m.reqId, board: board.id, elements: serialize(api.current), failed: [{ id: "*", reason: String(e) }] };
    }
    send(reply);
    if (m.create?.length || m.update?.length || m.del?.length) setUndo({ board: board.id, elements: before });
    const along = m.highlight?.length ? pointAlong(m.highlight, m.speech_text ?? "") : undefined;
    if (live.current.toggles.mute || !m.speech_text) { along?.(0); return setPhase("user"); }
    setPhase("speaking");
    say(m.speech_text, along, () => setPhase((p) => (p === "speaking" ? "user" : p)));
  }, [showTab]);

  useEffect(() => {
    const s = connect(async (m) => {
      if (m.type === "state") {
        setTitle(m.title); setChat(m.chat); loadState(m); setTemplates(m.templates ?? []);
        if (m.tokens) setTokens(m.tokens);
        setPhase(m.turn === "ai" ? "thinking" : "user");
        document.title = `${m.title} · Design Canvas`;
      } else if (m.type === "chat") setChat((c) => [...c, m.message]);
      else if (m.type === "turn") { setPhase((p) => (m.turn === "ai" ? "thinking" : p === "speaking" ? p : "user")); if (m.turn === "user") setStatus(""); }
      else if (m.type === "status") setStatus(m.text);
      else if (m.type === "highlight") { // older servers send pointing separately, just after the reply starts
        if (m.board !== live.current.active) return;
        const along = pointAlong(m.ids ?? [], speech.current.text);
        speech.current.along = along;
        along(speech.current.i);
      }
      else if (m.type === "ai_interject") {
        // The AI cuts in while you hold the floor: it speaks, you keep your turn (and your mic).
        setChat((c) => [...c, m.message]);
        const along = m.board === live.current.active && m.highlight?.length ? pointAlong(m.highlight, m.speech_text) : undefined;
        if (live.current.toggles.mute) along?.(0);
        else { interjecting.current = true; say(m.speech_text, along, () => { interjecting.current = false; }); }
      }
      else if (m.type === "tokens") setTokens(m as unknown as Tokens);
      else if (m.type === "ai_turn") onAiTurn(m);
      else if (m.type === "export_request") {
        const els = m.board && m.board !== live.current.active ? scenes.current.get(m.board) ?? [] : undefined;
        try { s.send({ reqId: m.reqId, data: await exportImage(api.current, m.format, undefined, els) }); }
        catch (e) { s.send({ reqId: m.reqId, error: (e as Error).message }); }
      } else if (m.type === "session_ended") { setPhase("ended"); s.stop(); }
    }, setConnected);
    sock.current = s;
    return s.stop;
  }, [onAiTurn]);

  // Talking over the AI's interjection stops it, like a teammate who lets you finish.
  const heardSpeech = () => { if (interjecting.current) { interjecting.current = false; stopSpeaking(); } };
  const recognizer = useMemo(() => createRecognizer({
    onInterim: (text) => { setInterim(text); if (text) { setCountdown(null); heardSpeech(); } }, // still talking: no auto-send
    onFinal: (text) => { if (!text) return; usedVoice.current = true; setCountdown(null); heardSpeech(); setDraft((d) => (d ? `${d} ${text}` : text)); },
    onSilence: () => {
      const l = live.current;
      const said = `${l.draft} ${l.interim}`.trim();
      if (!said) return;
      if (l.toggles.autoEnd) { setCountdown(2); return; }
      // A pause mid-thought: let the agent hear it so far, in case it wants to cut in.
      if (l.toggles.interject && said !== lastPartial.current) {
        lastPartial.current = said;
        send({ type: "user_partial", message: said, board: l.active, selected: selectedIds() });
      }
    },
    onError: (err) => setVoiceError(err === "not-allowed" ? "Microphone permission denied." : `Voice error: ${err}`),
  }), [endTurn]);
  useEffect(() => {
    if (voiceSupported && listening && phase === "user" && connected) recognizer.start();
    else recognizer.stop();
  }, [listening, phase, connected, recognizer]);

  const talk = () => {
    if (live.current.phase === "speaking") { interrupted.current = true; stopSpeaking(); } // barge in
    setVoiceError("");
    setListening(true);
  };
  const stopAndSend = () => {
    // keep what's on screen (including the not-yet-final part), then hand over the turn
    const { draft: d, interim: i } = live.current;
    const all = `${d} ${i}`.trim();
    live.current.draft = all; live.current.interim = "";
    setDraft(all); setInterim(""); setListening(false);
    if (all) endTurn();
  };

  // Esc cuts the AI off mid-sentence.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (live.current.phase === "speaking") { interrupted.current = true; stopSpeaking(); }
      else if (interjecting.current) { interjecting.current = false; stopSpeaking(); }
    };
    window.addEventListener("keydown", onKey, true); // capture: the mid-turn keyboard lock must not swallow it
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => { if (toggles.mute) stopSpeaking(); }, [toggles.mute]);

  // Debounced live sync so a reload mid-turn keeps what the user drew.
  const onChange = useCallback(() => {
    const els = api.current?.getSceneElements() ?? [];
    if (els.length < expected.current) return;
    if (expected.current) setTimeout(() => fit(api.current), 0); // just hydrated: show the whole diagram
    expected.current = 0;
    const board = live.current.active;
    const sig = `${board}:${els.length}:${els.reduce((a: number, e: any) => a + e.version, 0)}`;
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => send({ type: "scene", board, elements: serialize(api.current) }), 500);
  }, []);

  const onApi = useCallback((a: any) => {
    api.current = a;
    (window as any).__excalidrawAPI = a; // handy for debugging from devtools
  }, []);

  const undoAiTurn = () => {
    if (!undo) return;
    showTab(undo.board);
    api.current.updateScene({ elements: undo.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    rejected.current = true;
    setUndo(null);
    setNotice("Undid the AI's last changes. Your next turn tells it so; say why if you like.");
  };

  const answer = (qid: string, option: string, multi: boolean, only: boolean) => {
    const cur = live.current.answers[qid] ?? [];
    const next = multi ? (cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option]) : [option];
    const all = { ...live.current.answers, [qid]: next };
    setAnswers(all);
    live.current.answers = all;
    // one single-choice question and nothing typed: a click is the whole answer
    if (only && !multi && !live.current.draft.trim()) endTurn({ answers: all });
  };

  /** Put a template's starter shapes on the current (empty) tab as the user's own shapes. */
  const instantiate = (tpl: Template) => {
    applyAiTurn(api.current, { create: scaffold(tpl, `${live.current.active}${Date.now().toString(36)}_`), update: [], del: [] }, { author: "user" });
  };
  const onPick = (tpl: Template | null, name: string) => {
    const mode = picker;
    setPicker(null);
    if (mode === "new") {
      const t: Tab = { id: `b${Date.now().toString(36)}`, name: name || tpl?.name || `Diagram ${tabs.length + 1}`, ...(tpl && { template: tpl.id }) };
      saveTabs([...live.current.tabs, t]);
      showTab(t.id);
      if (tpl) instantiate(tpl);
      return;
    }
    if (!tpl) return;
    saveTabs(live.current.tabs.map((x) => (x.id === live.current.active ? { ...x, template: tpl.id } : x)));
    if (!api.current.getSceneElements().length) instantiate(tpl);
    else endTurn({ applyTemplate: tpl }); // existing content: the AI restructures it toward the template in a normal turn
  };
  const renameTab = (t: Tab) => {
    const name = prompt("Rename diagram", t.name)?.trim();
    if (name) saveTabs(tabs.map((x) => (x.id === t.id ? { ...x, name } : x)));
  };
  const closeTab = (t: Tab) => {
    if (tabs.length < 2 || !confirm(`Delete the "${t.name}" diagram? This can't be undone.`)) return;
    const next = tabs.filter((x) => x.id !== t.id);
    if (t.id === active) showTab(next[0].id);
    scenes.current.delete(t.id);
    saveTabs(next);
  };

  const locked = phase !== "user" || !connected;

  // While locked, keep keyboard shortcuts (delete, undo, tool keys…) from editing the canvas mid-turn.
  useEffect(() => {
    if (!locked) return;
    const block = (e: KeyboardEvent) => { if (!(e.target as HTMLElement | null)?.closest?.(".chat")) e.stopPropagation(); };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [locked]);
  const pill = !connected && phase !== "ended" ? "Reconnecting…" : PHASE_LABEL[phase];

  return (
    <div className="app">
      <header className="top">
        <span className="title">{title}</span>
        <span className="hint">R box · O ellipse · D diamond · A arrow · T text · P pen · F frame · Q keep tool · double-click to type</span>
        <span className={`pill ${connected ? phase : "offline"}`}>{pill}</span>
        {phase === "speaking" && <button onClick={() => { interrupted.current = true; stopSpeaking(); }} title="Stop the AI's voice (Esc)">■ Stop</button>}
        <button disabled={locked} title="End the session (it stays saved)"
          onClick={() => { if (confirm("Finish this design session? It stays saved and can be reopened later.")) endTurn({ done: true }); }}>Done</button>
        <button className="ghost" onClick={() => setChatOpen((o) => !o)}>{chatOpen ? "Hide chat ▸" : "◂ Chat"}</button>
      </header>
      <nav className="tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`tab ${t.id === active ? "on" : ""}`}>
            <button className="tab-name" disabled={locked} onClick={() => showTab(t.id)} onDoubleClick={() => renameTab(t)} title="Double-click to rename">{t.name}</button>
            {tabs.length > 1 && <button className="tab-x" disabled={locked} onClick={() => closeTab(t)} title="Delete diagram">×</button>}
          </span>
        ))}
        <button className="tab-add" disabled={locked} onClick={() => setPicker("new")} title="New diagram (optionally from a template)">＋</button>
        <button className="tab-tpl" disabled={locked || !templates.length} onClick={() => setPicker("apply")} title="Restructure this diagram toward a standard template">Apply template…</button>
        {tabs.find((t) => t.id === active)?.template && (
          <span className="tab-badge" title="This diagram follows a template's conventions">{templates.find((x) => x.id === tabs.find((t) => t.id === active)?.template)?.name}</span>
        )}
      </nav>
      <main>
        <div className="canvas">
          <Canvas locked={locked} onApi={onApi} onChange={onChange} initialData={initial.promise} highlight={highlight} />
          {locked && <div className="dim"><span>{phase === "thinking" && status ? status : pill}</span></div>}
        </div>
        {chatOpen && (
          <ChatPanel
            chat={chat} canAct={!locked} draft={draft} interim={interim} setDraft={setDraft}
            onSend={() => endTurn()} onEndTurn={() => endTurn()}
            countdown={countdown} onCancelCountdown={() => setCountdown(null)}
            toggles={toggles} setToggles={setToggles} voiceSupported={voiceSupported} voiceError={voiceError}
            listening={listening} speaking={phase === "speaking"} onTalk={talk} onStopTalk={stopAndSend}
            answers={answers} onAnswer={answer} status={phase === "thinking" ? status : ""}
            tokens={tokens} thinking={phase === "thinking"}
            canUndo={!!undo && !locked} onUndo={undoAiTurn} notice={notice}
          />
        )}
      </main>
      {picker && (
        <TemplatePicker mode={picker} templates={templates} defaultName={`Diagram ${tabs.length + 1}`}
          tabHasContent={picker === "apply" && (api.current?.getSceneElements().length ?? 0) > 0}
          onPick={onPick} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
