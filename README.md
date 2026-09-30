# design-canvas-mcp

A local-first MCP server that turns any MCP-capable agent harness (Claude Code, Cursor, Codex, Antigravity, …) into a turn-based whiteboard partner. You draw on a shared Excalidraw canvas and talk (voice) or type. Then the harness's own model takes a turn: it answers in chat, and that answer is spoken aloud. It also draws on the same canvas, with a short **reason note** next to every shape it adds.

The server calls **no LLM**. It serves the UI, holds session state and exposes MCP tools. Whatever model runs your harness does all the reasoning, so there are no API keys and nothing provider-specific.

## Install & build

```bash
npm install
npm run build        # compiles the server (dist/) and the UI (ui/dist/)
npm test             # smoke test: real MCP client + fake browser
```

Node 20+.

## Register the server

**Claude Code** (user scope = available in every project):

```bash
claude mcp add --scope user design-canvas -- node /absolute/path/to/design-canvas/dist/index.js
```

Or put this in JSON config (`.mcp.json` in a project, or `claude mcp add-json`):

```json
{
  "mcpServers": {
    "design-canvas": {
      "command": "node",
      "args": ["/absolute/path/to/design-canvas/dist/index.js"]
    }
  }
}
```

**Claude Desktop (Chat)**: add the same block under `mcpServers` in `claude_desktop_config.json`. That's `%APPDATA%\Claude\` on Windows, or `~/Library/Application Support/Claude/` on macOS. Then fully restart the app. Set `DESIGN_CANVAS_EXPORT_DIR`, because Desktop's working directory is its install folder:

```json
"design-canvas": {
  "command": "node",
  "args": ["/absolute/path/to/design-canvas/dist/index.js"],
  "env": { "DESIGN_CANVAS_EXPORT_DIR": "C:\\Users\\you\\Documents\\design-canvas" }
}
```

**Antigravity**: same block in `~/.gemini/antigravity/mcp_config.json` (newer builds use `~/.gemini/config/mcp_config.json`).

**Any other MCP host (generic stdio):** command `node`, args `["/absolute/path/to/design-canvas/dist/index.js"]`, transport `stdio`. Set `DESIGN_CANVAS_NO_OPEN=1` in `env` if you don't want the server to open a browser tab itself.

### Show what the agent is doing (Claude Code)

The board shows a timer while the AI works. It can also show what the AI is doing ("Reading src/index.ts", "Drawing 12 shapes…"), through a Claude Code hook. Add this to `~/.claude/settings.json`:

```json
"hooks": {
  "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/design-canvas/scripts/activity-hook.mjs", "timeout": 5, "async": true }] }]
}
```

It runs in the background, so it never slows a tool call down. It does nothing when no board is open. Only the chat that drives the board appears on it; other Claude Code sessions don't.

## Starting a session

Any of these work:

- **Plain language.** The server sends MCP *instructions* telling the model when to use it, so phrases like *"let's whiteboard the checkout flow"*, *"draw the architecture"* or *"open my last diagram"* are enough.
- **The `design` prompt.** In Claude Code it's `/mcp__design-canvas__design`, and it takes optional `topic` and `resume` arguments. In Claude Desktop it's under the **+** menu, then design-canvas. Other hosts list MCP prompts in their own UI.
- **Resume.** Say *"continue the URL shortener diagram"*. The agent calls `list_design_sessions` and then `start_design_session({resume})`. `resume` accepts an id, words from the title, or `last`.

## On the board

- **Templates**: **＋** opens a picker with a preview of each template. Pick one to start a new tab from its starter shapes; they're yours to edit. **Apply template…** on a tab that already has content asks the AI, as a normal turn, to restructure what's there toward the template. It reuses and relabels your shapes instead of starting over. On an empty tab, the starter shapes are added directly. The tab keeps the template's conventions, and the AI follows them in later turns.
- **Diagram tabs**: one session holds several diagrams (Architecture, Request flow, Deployment, Data flow…). Use **＋** to add a tab, double-click a tab to rename it, and **×** to delete it. The agent picks a tab with `board` on `submit_ai_turn`, and a new name creates the tab.
- **Questions**: the agent can ask up to 3 structured questions, which you answer with clickable chips or by typing. With a single one-choice question, one click answers and ends your turn.
- **While the AI works**: the board shows a timer and a short feed of what the AI is doing. That's its own progress lines ("Comparing Kafka vs SQS…"), plus each tool call if the hook above is installed. Before a long turn it says one sentence out loud ("Let me split that into three rows"), so you aren't left waiting in silence. MCP servers can't see a model's raw reasoning.
- **Self-check**: after drawing, the AI gets a small picture of the board, so it can fix overlaps or crossed arrows. Boxes grow to fit their labels.
- **Design notes**: the AI records decisions, assumptions and open questions (`notes`). They come back when you resume, including in a new chat, and after the harness compacts its context. They're also in the markdown export.
- **Token meter**: estimated tokens for this turn and for the session, counting what the board sends to and receives from the AI (about 4 chars/token, images by size). Your harness's own usage (system prompt, other tools) isn't visible to the board; check that in the harness (`/cost` in Claude Code).
- **Frames**: zones like VPC, region or cluster. Shapes inside a frame are reported with `in: <frame id>`.
- **Undo AI turn**: reverts everything the AI changed last turn. The agent is told (`rejected_ai_turn`).
- **■ Stop**: cuts off the AI's voice mid-sentence.

- **Done** (top bar) ends the session. The agent says goodbye and closes it, and it stays saved.
- **"This" / "these"**: whatever you have selected when your turn ends is sent as `selected_ids`, so you can point and say "make this async".
- **Freehand sketches**: when your strokes change, a picture of the canvas goes along with the turn so the model can read the sketch. Arrows can point at sketches.
- **Why cards**: every AI shape has a reason. Select the shape to see it in a small card, and edit it there. Edits reach the agent.
- **Voice (you drive the mic)**: **🎤 Talk** starts listening and **■ Stop & send** hands over the turn. Headphones help: they keep the AI's voice out of the mic.
  - **Interrupt the AI**: while it speaks, **🎤 Interrupt** cuts it off and starts listening; **Esc** or **■ Stop** just silences it. The agent is told it was cut short (`interrupted_ai`).
  - **The AI can cut in** (toggle *AI can cut in*): when you pause mid-thought, what you've said so far goes to the agent (`status: "listening"`). It usually keeps listening. If something can't wait, it cuts in with one short sentence while you keep your turn, and it stops if you keep talking.
  - **Send on pause** (off by default): sends on its own after a pause, with a 2 s countdown to fix the transcript.
- **Teammate, not generator**: given a topic, the AI first puts a draft diagram on the board. From then on the discussion leads: it probes requirements, raises risks and trade-offs, pushes back, and draws when it helps. It **points** at the shapes it's talking about (`highlight_ids`), which glow while it speaks.
- **Shortcuts**: R box, O ellipse, D diamond, A arrow, T text, P pen, Q keeps the current tool, double-click to type. Your tool stays selected across turns.

## Saved sessions

Every session is saved automatically as JSON in `~/.design-canvas/sessions/` (override the location with `DESIGN_CANVAS_HOME`). **To keep a project's diagrams with its code**, create a `.design-canvas/` folder in the project. Sessions started from that folder are then saved in `.design-canvas/sessions/`, and you can commit them, so git gives you history and diffs. It's saved after each turn, on live canvas changes (debounced to 1 s) and at `end_session`. The file holds the canvas elements, chat, and the id mapping, so `u1` stays `u1` after a resume. The store lives with the server, not inside any one harness. So a diagram started in Claude Code can be resumed from Desktop Chat, Cursor and so on, and nothing depends on a particular host's memory feature.

## How the turn loop works

`start_design_session` starts an HTTP + WebSocket server on `127.0.0.1` (port 4173, or a free port) and opens the page. The agent then calls `wait_for_user_turn`, which blocks until the browser ends your turn. That happens when you send a message, voice auto-ends after ~2 s of silence, or you press **End turn**. The browser sends its full scene. The server diffs it against the last turn and returns a compact summary: your message, added/modified/deleted shapes, the whole canvas, layout hints and the last 20 chat messages. Shapes you draw get stable ids `u1, u2, …`, and the agent picks its own ids. The agent answers with `submit_ai_turn`: speech text plus simplified shape skeletons (boxes, arrows bound to ids, text, each with a `reason`). The server validates them, the browser converts them into Excalidraw elements, then renders them, speaks the text and hands the canvas back to you. The server keeps the canvas elements and chat history. The page restores from it on reload or reconnect.

## Timeouts

`wait_for_user_turn` returns `{"status":"still_waiting"}` after 50 s (configurable with `timeout_seconds`), and the agent just calls it again. That keeps the loop working on hosts that kill long tool calls at ~60 s. While it waits, it sends MCP progress notifications every 10 s to hosts that asked for them. In Claude Code you can raise the tool timeout with the `MCP_TOOL_TIMEOUT` env var (milliseconds).

## Tools

| tool | purpose |
|---|---|
| `start_design_session(title?, resume?)` | start/open the board, or reopen a saved one |
| `list_design_sessions(query?, limit?)` | saved sessions, newest first |
| `wait_for_user_turn(timeout_seconds?)` | block for the next user turn |
| `submit_ai_turn(speech_text, new_shapes?, update_shapes?, delete_shape_ids?)` | reply + draw; returns per-id failures |
| `get_canvas_snapshot(board?)` | full summary of a tab without waiting |
| `show_status(text)` | live progress line while the agent works |
| `list_templates()` | the template catalogue and each notation's conventions |
| `export_session(format, path?, board?)` | `png`, `svg`, `excalidraw` (one tab); `markdown`, `mermaid`, `pdf`, `pptx` (all tabs) |
| `end_session()` | close the board (session stays saved) |

PNG/SVG are rendered by the browser. PDF and PPTX get a canvas image from the browser, then components, connections with reasons, and the transcript are added server-side. Markdown and `.excalidraw` come straight from server state.

## Templates

| Template | Kind | Based on |
|---|---|---|
| C4 · System context, C4 · Containers | Architecture | [C4 model](https://c4model.com). The agent also gets the canonical **Big Bank plc** example from [Structurizr](https://github.com/structurizr/java) (Apache-2.0) as a reference |
| Microservices + gateway | Architecture | API gateway / database-per-service pattern |
| Three-tier web app | Deployment | AWS Well-Architected three-tier reference architecture |
| Kubernetes deployment | Deployment | Kubernetes docs concepts (Ingress, Service, Deployment, HPA) |
| Event-driven (pub/sub) | Data flow | Enterprise Integration Patterns, publish/subscribe |
| Data flow + trust boundaries | Data flow | Threat-modeling DFDs (OWASP, Microsoft STRIDE) |
| Sequence diagram | Flow | UML 2 |
| Flowchart | Flow | ISO 5807 symbols |
| UML activity (swimlanes), UML state machine, Entity relationship, Cross-functional flowchart | Flow / Data | Official [draw.io templates](https://github.com/jgraph/drawio/tree/dev/src/main/webapp/templates) © JGraph Ltd, **CC BY 4.0**, converted by `scripts/import-drawio.mjs` into `src/templates-drawio.ts` |

Each template has a short conventions guide, which the agent keeps to on that tab. The first nine are written for this project following the named notations. I looked for ready-made diagram sets first: the most polished public collection ([karanpratapsingh/system-design](https://github.com/karanpratapsingh/system-design)) is CC BY-NC-ND, which forbids modification, so it isn't bundled. For symbol palettes (C4 shapes, UML, cloud icons and so on), use Excalidraw's built-in **Library → Browse libraries**, which imports from the MIT-licensed [excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries). To add a template, add an entry to `src/templates.ts`, or add a draw.io template path to `PICKS` in the importer and re-run it.

## Token economy

Turns are kept small on purpose:
- The full canvas is sent only when the agent hasn't seen the current tab yet, or when a lot changed. Otherwise the turn carries just `changes` plus `canvas_omitted`, and the agent calls `get_canvas_snapshot` if it loses track.
- `recent_chat` is the last 3 messages after the first turn.
- Arrows bound at both ends drop their coordinates.
- Sketch images are only attached when freehand strokes changed.

## Known limitations

- **Voice input needs Chrome/Chromium** (Web Speech API `SpeechRecognition`). Other browsers get a notice and use text chat. Spoken replies (`speechSynthesis`) work in most browsers.
- **One live board per server process.** Two hosts can each run their own server (the second gets a random port). Resuming the *same* saved session in both at once means the last write wins.
- Saved sessions are never pruned; delete files in `~/.design-canvas/sessions/` by hand.
- PPTX holds each tab as a single image, not native editable shapes.
- Arrows can't cross tabs. Moving a frame through `update_shapes` doesn't move its children; dragging it on the canvas does.
- Arrow endpoints are computed from bounding boxes, so on ellipses and diamonds the tips can sit slightly off the outline. Once bound, Excalidraw keeps arrows attached when you move shapes.
- Excalidraw's hand-drawn fonts load from its CDN. Offline, it falls back to system fonts.
- Pasted images are not synced to the server.
