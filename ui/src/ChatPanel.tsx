import { useEffect, useRef } from "react";
import type { Tokens } from "./App";

export interface Question { id: string; text: string; options?: string[]; multi?: boolean }
export interface ChatMsg { author: "user" | "ai"; text: string; timestamp: string; questions?: Question[]; interjection?: boolean }
export interface Toggles { mute: boolean; autoEnd: boolean; interject: boolean }

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function ChatPanel(p: {
  chat: ChatMsg[];
  canAct: boolean;
  draft: string;
  interim: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  onEndTurn: () => void;
  toggles: Toggles;
  setToggles: (t: Toggles) => void;
  voiceSupported: boolean;
  voiceError: string;
  countdown: number | null;
  onCancelCountdown: () => void;
  answers: Record<string, string[]>;
  onAnswer: (qid: string, option: string, multi: boolean, only: boolean) => void;
  status: string;
  tokens: Tokens | null;
  thinking: boolean;
  canUndo: boolean;
  onUndo: () => void;
  notice: string;
  listening: boolean;
  speaking: boolean;
  onTalk: () => void;
  onStopTalk: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [p.chat.length, p.status]);
  const t = p.toggles;
  const toggle = (key: keyof Toggles) => p.setToggles({ ...t, [key]: !t[key] });
  const last = p.chat[p.chat.length - 1];
  const open = last?.author === "ai" && p.canAct ? last.questions ?? [] : []; // only the latest AI message's questions are answerable
  const hasAnswers = Object.values(p.answers).some((v) => v.length);
  const tok = p.tokens;

  return (
    <aside className="chat">
      <div className="log" ref={log}>
        {p.chat.length === 0 && <p className="empty">Draw on the canvas and/or type a message, then Send (or End turn for drawing-only turns).</p>}
        {p.chat.map((m, i) => (
          <div key={i} className={`msg ${m.author}${m.interjection ? " interjection" : ""}`}>
            <div className="meta">{m.author === "ai" ? (m.interjection ? "AI cut in" : "AI") : "You"} · {new Date(m.timestamp).toLocaleTimeString()}</div>
            {m.text && <div className="text">{m.text}</div>}
            {m.questions?.map((q) => {
              const live = open.includes(q);
              return (
                <div key={q.id} className="question">
                  <div className="q-text">{q.text}</div>
                  {!!q.options?.length && (
                    <div className="chips">
                      {q.options.map((o) => (
                        <button key={o} type="button" disabled={!live}
                          className={`chip ${p.answers[q.id]?.includes(o) ? "on" : ""}`}
                          onClick={() => p.onAnswer(q.id, o, !!q.multi, open.length === 1)}>{o}</button>
                      ))}
                    </div>
                  )}
                  {live && <div className="q-hint">{q.options?.length ? `${q.multi ? "Pick any" : "Pick one"}, or type your own answer below` : "Answer below"}</div>}
                </div>
              );
            })}
          </div>
        ))}
        {p.status && <div className="status-line"><span className="dots" />{p.status}</div>}
      </div>
      {tok && (
        <div className="tokens" title="Estimated from what the board sent to and received from the AI (~4 chars/token, images by size). Your harness's own usage (system prompt, other tools, reasoning) isn't visible to the board.">
          {p.thinking ? `This turn so far ≈ ${k(tok.turn.in + tok.turn.out)} tok` : `Last turn ≈ ${k(tok.last.in + tok.last.out)} tok`}
          {" · "}Session ≈ {k(tok.total.in + tok.total.out)} tok ({k(tok.total.in)} to AI / {k(tok.total.out)} from AI)
        </div>
      )}
      <div className="toggles">
        <label><input type="checkbox" checked={t.mute} onChange={() => toggle("mute")} /> Mute AI voice</label>
        <label title="When you pause mid-thought, the AI hears what you said so far and may briefly cut in">
          <input type="checkbox" checked={t.interject} disabled={!p.voiceSupported} onChange={() => toggle("interject")} /> AI can cut in
        </label>
        <label title="Send automatically after a pause instead of pressing Stop">
          <input type="checkbox" checked={t.autoEnd} disabled={!p.voiceSupported} onChange={() => toggle("autoEnd")} /> Send on pause
        </label>
      </div>
      {p.notice && <div className="notice">{p.notice}</div>}
      {p.voiceError && <div className="notice">{p.voiceError}</div>}
      {!p.voiceSupported && <div className="notice">Voice input isn't available in this browser (needs Chrome/Chromium). Text chat works.</div>}
      {p.countdown !== null && (
        <div className="countdown">
          Sending in {p.countdown}… check the transcript
          <button type="button" onClick={p.onSend}>Send now</button>
          <button type="button" onClick={p.onCancelCountdown}>Edit</button>
        </div>
      )}
      <form className="input" onSubmit={(e) => { e.preventDefault(); p.onSend(); }}>
        <textarea
          value={p.interim ? `${p.draft}${p.draft ? " " : ""}${p.interim}` : p.draft}
          placeholder={p.canAct ? (open.length ? "Pick above or type an answer…" : "Type a message… (Enter to send, Shift+Enter for newline)") : "Wait for the AI…"}
          disabled={!p.canAct}
          onChange={(e) => p.setDraft(e.target.value)}
          onFocus={p.onCancelCountdown}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (p.draft.trim() || p.interim.trim() || hasAnswers) p.onSend(); } }}
        />
        <div className="buttons">
          {p.voiceSupported && (p.listening
            ? <button type="button" className="talk on" onClick={p.onStopTalk} title="Stop listening and send">■ Stop &amp; send</button>
            : <button type="button" className="talk" disabled={!p.canAct && !p.speaking} onClick={p.onTalk}
                title={p.speaking ? "Cut the AI off and start talking (Esc just stops it)" : "Start talking"}>🎤 {p.speaking ? "Interrupt" : "Talk"}</button>)}
          {p.canUndo && <button type="button" className="undo" onClick={p.onUndo} title="Revert everything the AI changed in its last turn">↶ Undo AI turn</button>}
          <button type="button" disabled={!p.canAct} onClick={p.onEndTurn}>End turn</button>
          <button type="submit" disabled={!p.canAct || !(p.draft.trim() || p.interim.trim() || hasAnswers)}>Send</button>
        </div>
      </form>
    </aside>
  );
}
