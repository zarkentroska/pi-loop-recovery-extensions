/**
 * loop-detector — Detecta bucles de razonamiento del LLM en tiempo real.
 *
 * Detección intra-mensaje (enfoque “buscar en Word”):
 *   - Frases de N palabras idénticas palabra por palabra que aparecen ≥ K veces en
 *     todo el mensaje (K alto para evitar falsos positivos).
 *   - Párrafos completos idénticos repetidos ≥ K veces.
 * Tool loop: misma herramienta + mismos args con error, consecutiva.
 * Cross-turn: el mismo mensaje de asistente (normalizado en espacios) aparece
 *   ≥ K veces en una ventana reciente — sin Jaccard laxo.
 *
 * Recovery: compacta → resumen pendiente → nueva sesión. Pi enlaza `pi.sendUserMessage` a
 * `AgentSession.sendUserMessage`, que fuerza `expandPromptTemplates: false`; por eso esta
 * extensión parchea el **prototipo** para que `/newram` y `/new-session` pasen por `prompt` con
 * expansión (misma ruta que el Enter del usuario). Si el parche no aplica (binario aislado),
 * quedan el hook `__piPromptInteractive`, `pi.prompt` si existiera, y el pegado en editor.
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { setPendingCompactionSummary, startNewSessionAndUnload } from "./session-utils.js";

/* ═══════════════ Configuración ═══════════════ */

const CFG = {
  streamingMinChars: 400,
  /** Repeticiones mínimas del mismo texto exacto (estilo Ctrl+F en Word). */
  minExactRepeats: 6,
  minPhraseWords: 8,
  maxPhraseWords: 72,
  minPhraseChars: 48,
  paragraphMinChars: 40,
  /** Cola de palabras analizada (menos = menos CPU en streams largos). */
  maxWordsScan: 5_500,
  /** No ejecutar detección intra-mensaje en cada token: evita congelar la TUI. */
  streamDetectMinIntervalMs: 280,
  streamDetectMinCharDelta: 700,
  /** Paso en longitud de n-grama; con rolling O(n) por wlen suele bastar 1. */
  phraseWlenStep: 1,
  /** Máx. párrafos considerados en repetición retardada (coste O(n²)). */
  delayedMaxBlocks: 72,
  toolCallWindow: 6,
  toolLoopThreshold: 4,
  crossTurnLookback: 24,
  crossTurnMinChars: 180,
  cooldownMs: 3_000,
} as const;

/* ═══════════════ Estado interno ═══════════════ */

let recentNormalized = "";
/** Último texto del asistente visto en streaming (puede no estar aún persistido en la sesión). */
let lastAssistantStreamingText = "";
/** Último `ctx.ui` visto (para pegar /newram si Pi no expone `prompt` con expansión). */
let lastUi: ExtensionUIContext | undefined;
/**
 * `ctx` del recovery (message_update, etc.): si en runtime incluye `newSession`, podemos
 * ejecutar la misma lógica que `/newram` sin pasar por texto ni `sendUserMessage`.
 */
let recoverySessionCtx: ExtensionCommandContext | null = null;
/** Throttle: último escaneo costoso de bucle intra-mensaje (no bloquear la TUI). */
let lastLoopScanAt = 0;
let lastLoopScanTextLen = 0;
let lastDetectedAt = 0;
let isRecovering = false;
let skipIntraMsgAfterCompact = false; // evitar falso positivo en recovery message
let enabled = true;

/* ═══════════════ Helpers de texto ═══════════════ */

function normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("\n");
    }
    return String(content ?? "");
}

const HANDOFF_MAX_TOTAL = 80_000;
const HANDOFF_MAX_BLOCK = 12_000;
const HANDOFF_MAX_MESSAGES = 120;
/** Límite del bloque “turno actual” dentro del prompt de compact (suele quedar fuera del batch). */
const CURRENT_TURN_INSTRUCT_MAX = 52_000;

/**
 * Texto del último turno (desde el último mensaje de usuario hasta el final de la rama)
 * + snapshot del stream del asistente. Pi no incluye esa cola en `messagesToSummarize`,
 * así que se pasa por `customInstructions` para que el resumen lo integre.
 */
function buildCurrentTurnForCompactionInstructions(ctx: ExtensionContext, streamingAssistantSnapshot: string): string {
    const sm = ctx.sessionManager;
    if (!sm?.getBranch) return "";

    const branch = sm.getBranch() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
    let lastUserIdx = -1;
    for (let i = 0; i < branch.length; i++) {
        const e = branch[i];
        if (e?.type === "message" && e.message?.role === "user") lastUserIdx = i;
    }
    if (lastUserIdx < 0) return "";

    const parts: string[] = [];
    let used = 0;
    const reserveForSnap = 36_000;

    for (let i = lastUserIdx; i < branch.length; i++) {
        const e = branch[i];
        if (e?.type !== "message" || !e.message) continue;

        const role = e.message.role ?? "unknown";
        let text = extractText(e.message.content).trim();
        if (!text) continue;

        if (text.length > HANDOFF_MAX_BLOCK) {
            text = `${text.slice(0, HANDOFF_MAX_BLOCK)}\n… [truncated ${text.length - HANDOFF_MAX_BLOCK} chars]`;
        }

        const header =
            role === "user"
                ? "User (last prompt)"
                : role === "assistant"
                  ? "Assistant (persisted in session)"
                  : role === "tool"
                    ? "Tool"
                    : String(role);
        const block = `### ${header}\n${text}`;
        if (used + block.length > CURRENT_TURN_INSTRUCT_MAX - reserveForSnap) break;
        parts.push(block);
        used += block.length + 4;
    }

    let body = parts.join("\n\n");

    const snap = streamingAssistantSnapshot.trim();
    if (snap.length > 200) {
        const cap = 35_000;
        const capped = snap.length > cap ? `${snap.slice(0, cap)}\n… [truncated ${snap.length - cap} chars]` : snap;
        const snapBlock = `\n\n### Assistant (streaming up to loop detection)\n${capped}`;
        if (body.length + snapBlock.length > CURRENT_TURN_INSTRUCT_MAX) {
            const room = Math.max(0, CURRENT_TURN_INSTRUCT_MAX - snapBlock.length - 100);
            body = body.slice(0, room) + (room < body.length ? "\n… [truncated]" : "");
        }
        body += snapBlock;
    }

    if (body.length > CURRENT_TURN_INSTRUCT_MAX) {
        body = body.slice(0, CURRENT_TURN_INSTRUCT_MAX) + "\n… [truncated]";
    }

    return body.trim();
}

/**
 * Pi solo resume en compact lo que cae *fuera* de keepRecentTokens; si toda la charla
 * es "reciente", messagesToSummarize queda vacío y el modelo devuelve la plantilla
 * genérica ("Awaiting initial user request…"). Este handoff toma el hilo real desde
 * la sesión persistida + un snapshot del stream actual.
 */
function captureSessionHandoff(ctx: ExtensionContext, streamingAssistantSnapshot: string): string {
    const sm = ctx.sessionManager;
    if (!sm?.getBranch) return "";

    const branch = sm.getBranch() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
    const chunks: string[] = [];
    let used = 0;

    for (let i = branch.length - 1; i >= 0 && chunks.length < HANDOFF_MAX_MESSAGES && used < HANDOFF_MAX_TOTAL; i--) {
        const entry = branch[i];
        if (entry?.type !== "message" || !entry.message) continue;

        const role = entry.message.role ?? "unknown";
        let text = extractText(entry.message.content).trim();
        if (!text) continue;

        if (text.length > HANDOFF_MAX_BLOCK) {
            text = `${text.slice(0, HANDOFF_MAX_BLOCK)}\n… [truncated ${text.length - HANDOFF_MAX_BLOCK} chars]`;
        }

        const header =
            role === "user"
                ? "User"
                : role === "assistant"
                  ? "Assistant"
                  : role === "tool"
                    ? "Tool"
                    : String(role);
        const block = `### ${header}\n${text}`;
        if (used + block.length > HANDOFF_MAX_TOTAL) break;

        chunks.push(block);
        used += block.length + 4;
    }

    chunks.reverse();

    let body = chunks.join("\n\n---\n\n");
    const snap = streamingAssistantSnapshot.trim();
    if (snap.length > 200) {
        const capped =
            snap.length > 40_000 ? `${snap.slice(0, 40_000)}\n… [truncated ${snap.length - 40_000} chars]` : snap;
        const snapBlock = `### Assistant (snapshot al detectar el bucle; puede no estar en la sesión aún)\n${capped}`;
        body = body ? `${body}\n\n---\n\n${snapBlock}` : snapBlock;
    }

    if (!body) return "";

    return (
        "## Conversation handoff (extractos; recuperación por bucle)\n\n" +
        body +
        "\n\n**Si el resumen estructurado de compact está vacío o genérico, usa esto como verdad de la conversación.**"
    );
}

/** Plantilla vacía típica cuando no hay nada que resumir en la ventana de compact. */
function isVacuousCompactionSummary(summary: string): boolean {
    const s = summary.toLowerCase();
    if (summary.trim().length < 350) return true;
    if (s.includes("awaiting initial user request")) return true;
    if (s.includes("no tasks defined yet")) return true;

    let emptyMarkers = 0;
    if (s.includes("(none)")) emptyMarkers++;
    if (s.includes("no completed tasks")) emptyMarkers++;
    if (s.includes("no current work in progress")) emptyMarkers++;
    if (s.includes("no issues preventing progress")) emptyMarkers++;
    if (emptyMarkers >= 3) return true;

    return false;
}

/* ═══════════════ Detección intra-message (streaming) ═══════════════ */

/** Palabras tal cual en el stream (misma capitalización / tokens). */
function splitWordsRaw(text: string): string[] {
    return text.trim().split(/\s+/).filter(Boolean);
}

/** Hash 32-bit por palabra (rolling sin allocar strings por ventana). */
function wordTok(w: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    return h === 0 ? 1 : h;
}

const ROLL_P = 0x9e3779b1 >>> 0;
const powRoll: number[] = (() => {
    const a: number[] = new Array(96);
    a[0] = 1 >>> 0;
    for (let i = 1; i < a.length; i++) a[i] = Math.imul(a[i - 1], ROLL_P) >>> 0;
    return a;
})();

function ngramsWordsEqual(words: string[], a: number, b: number, wlen: number): boolean {
    for (let k = 0; k < wlen; k++) if (words[a + k] !== words[b + k]) return false;
    return true;
}

/** Cuenta ventanas i con el mismo contenido que words[start..] (igual que el Map original). */
function countNgramOccurrencesWords(words: string[], wlen: number, start: number): number {
    const n = words.length;
    let occ = 0;
    for (let i = 0; i <= n - wlen; i++) {
        if (ngramsWordsEqual(words, i, start, wlen)) occ++;
    }
    return occ;
}

function phraseCharLen(words: string[], start: number, wlen: number): number {
    let c = 0;
    for (let j = 0; j < wlen; j++) {
        c += words[start + j].length;
        if (j + 1 < wlen) c += 1;
    }
    return c;
}

/**
 * N-gramas exactos con rolling hash O(n) por wlen + verificación O(n·wlen) solo si hay candidato.
 */
function detectExactPhraseLoop(text: string): boolean {
    let words = splitWordsRaw(text);
    if (words.length > CFG.maxWordsScan) {
        words = words.slice(-CFG.maxWordsScan);
    }
    const n = words.length;
    const minNeed = CFG.minExactRepeats * CFG.minPhraseWords;
    if (n < minNeed) return false;

    const maxW = Math.min(CFG.maxPhraseWords, Math.floor(n / CFG.minExactRepeats));
    if (maxW < CFG.minPhraseWords) return false;

    for (let wlen = maxW; wlen >= CFG.minPhraseWords; wlen -= CFG.phraseWlenStep) {
        if (n < wlen * CFG.minExactRepeats) continue;
        if (wlen > powRoll.length - 1) continue;

        const powHigh = powRoll[wlen - 1] >>> 0;
        let H = 0 >>> 0;
        for (let j = 0; j < wlen; j++) H = (Math.imul(H, ROLL_P) + wordTok(words[j])) >>> 0;

        const counts = new Map<number, { count: number; firstStart: number }>();

        const bump = (i: number, hash: number): boolean => {
            if (phraseCharLen(words, i, wlen) < CFG.minPhraseChars) return false;
            const prev = counts.get(hash);
            if (!prev) {
                counts.set(hash, { count: 1, firstStart: i });
                return false;
            }
            prev.count++;
            if (prev.count < CFG.minExactRepeats) return false;
            const occ = countNgramOccurrencesWords(words, wlen, prev.firstStart);
            if (occ >= CFG.minExactRepeats) return true;
            counts.delete(hash);
            return false;
        };

        if (bump(0, H)) return true;

        for (let i = 1; i <= n - wlen; i++) {
            const outTok = wordTok(words[i - 1]) >>> 0;
            const inTok = wordTok(words[i + wlen - 1]) >>> 0;
            const sub = Math.imul(outTok, powHigh) >>> 0;
            H = (Math.imul((H - sub) >>> 0, ROLL_P) + inTok) >>> 0;
            if (bump(i, H)) return true;
        }
    }
    return false;
}

/** Párrafos (doble salto) idénticos tras colapsar espacios. */
function detectRepeatedExactParagraphs(text: string): boolean {
    const paras = text
        .split(/\n{2,}/)
        .map((p) => normalize(p))
        .filter((p) => p.length >= CFG.paragraphMinChars);
    if (paras.length < CFG.minExactRepeats) return false;
    const counts = new Map<string, number>();
    for (const p of paras) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const c of counts.values()) {
        if (c >= CFG.minExactRepeats) return true;
    }
    return false;
}

/**
 * Detecta repeticiones retardadas: un bloque que reaparece después de N bloques
 * intermedios distintos. Ejemplo del loop narrativo:
 *
 *   [A] The flow becomes...
 *   [B] The tricky part is...
 *   [C] The flow becomes...  ← repite A después de 1 bloque intermedio
 *   [D] The key insight is...
 *   [E] But there's still...
 *   [F] I need a different...
 *   [G] The flow becomes...  ← repite A otra vez después de 3 bloques
 *
 * Los patrones A-B-A y A-B-C-D-A NO se detectan con modulo exacto ni
 * con comparación adyacente. Esta función compara cada bloque contra TODOS
 * los recientes en una ventana deslizante usando Jaccard.
 */
function tokenize(text: string): Set<string> {
    const words = text.toLowerCase()
        .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
    return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
}

function detectDelayedRepetition(text: string): boolean {
    let blocks = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length >= CFG.paragraphMinChars);
    if (blocks.length > CFG.delayedMaxBlocks) {
        blocks = blocks.slice(-CFG.delayedMaxBlocks);
    }
    if (blocks.length < CFG.minExactRepeats * 2) return false;

    // Umbral alto para evitar FP con texto natural diferente
    const simThreshold = 0.85;
    // Necesitamos al menos minExactRepeats apariciones del mismo contenido
    for (let i = 0; i < blocks.length; i++) {
        let matchCount = 1; // el propio bloque cuenta como 1
        for (let j = 0; j < i; j++) {
            const aTokens = tokenize(blocks[i]);
            const bTokens = tokenize(blocks[j]);
            if (aTokens.size === 0 || bTokens.size === 0) continue;
            const sim = jaccardSimilarity(aTokens, bTokens);
            if (sim >= simThreshold) {
                matchCount++;
            }
        }
        if (matchCount >= CFG.minExactRepeats) return true;
    }
    return false;
}

function detectIntraMessageLoop(text: string): { type: "phrase" | "paragraph" | "delayed"; count: number } | null {
    if (text.length < CFG.streamingMinChars) return null;
    if (detectExactPhraseLoop(text)) return { type: "phrase", count: CFG.minExactRepeats };
    if (detectRepeatedExactParagraphs(text)) return { type: "paragraph", count: CFG.minExactRepeats };
    // Delayed repetition: mismo contenido reaparece después de bloques intermedios distintos
    if (detectDelayedRepetition(text)) return { type: "delayed", count: CFG.minExactRepeats };
    return null;
}

/* ═══════════════ Detección tool call loop ═══════════════ */

interface ToolCallRecord {
    toolName: string;
    argsHash: string;
    isError: boolean;
}

function hashArgs(args: Record<string, unknown>): string {
    try { return JSON.stringify(args); } catch { return String(args); }
}

class SlidingWindow<T> {
    private buffer: T[] = [];
    constructor(private maxSize: number) {}
    push(item: T): void {
        this.buffer.push(item);
        if (this.buffer.length > this.maxSize) this.buffer.shift();
    }
    clear(): void {
        this.buffer = [];
    }
    get all(): readonly T[] { return this.buffer; }
}

const toolCallBuffer = new SlidingWindow<ToolCallRecord>(CFG.toolCallWindow);

function detectToolLoop(records: ToolCallRecord[]): boolean {
    if (records.length < CFG.toolLoopThreshold) return false;

    // Últimos N deben ser idénticos y con error
    const tail = records.slice(-CFG.toolLoopThreshold);
    const first = tail[0];
    return tail.every((r) => r.toolName === first.toolName && r.argsHash === first.argsHash && r.isError);
}

/* ═══════════════ Detección cross-turn ═══════════════ */

const assistantTexts: string[] = [];

function detectCrossTurnLoop(): boolean {
    if (assistantTexts.length < CFG.minExactRepeats) return false;

    const last = assistantTexts[assistantTexts.length - 1];
    if (last.length < CFG.crossTurnMinChars) return false;
    const lastNorm = normalize(last);

    let same = 0;
    const look = Math.min(assistantTexts.length, CFG.crossTurnLookback);
    const start = assistantTexts.length - look;
    for (let i = start; i < assistantTexts.length; i++) {
        const t = assistantTexts[i];
        if (t.length < CFG.crossTurnMinChars) continue;
        if (normalize(t) === lastNorm) same++;
    }
    return same >= CFG.minExactRepeats;
}

/**
 * Pi: `AgentSession.sendUserMessage` → `prompt(..., { expandPromptTemplates: false })`, así que
 * los `/comando` desde extensión no se ejecutan. Parcheamos solo `/newram` y `/new-session` en
 * el prototipo compartido (mismo módulo que carga Pi y las extensiones).
 *
 * Opcional: `globalThis.__piPromptInteractive(text, opts)` si un fork expone el prompt “como usuario”.
 */
type ExtensionSessionWithPrompt = {
    prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
};

function isNewramOrNewSessionExtensionMessage(content: unknown): content is string {
    if (typeof content !== "string") return false;
    const t = content.trim();
    return (
        t === "/newram" ||
        t.startsWith("/newram ") ||
        t === "/new-session" ||
        t.startsWith("/new-session ")
    );
}

let sendUserMessageSlashPatchPromise: Promise<boolean> | null = null;

/**
 * Parchea `AgentSession.prototype.sendUserMessage` para enrutar /newram y /new-session por
 * `prompt` con expansión. Devuelve true si el método parcheado está activo (o ya lo estaba).
 */
function ensureAgentSessionSendUserMessageSlashPatch(): Promise<boolean> {
    return (sendUserMessageSlashPatchPromise ??= (async (): Promise<boolean> => {
        try {
            const mod = (await import("@earendil-works/pi-coding-agent")) as {
                AgentSession?: { prototype?: { sendUserMessage?: unknown } };
            };
            const AgentSession = mod.AgentSession;
            const proto = AgentSession?.prototype as
                | { sendUserMessage?: (this: unknown, content: unknown, options?: unknown) => Promise<void> }
                | undefined;
            const current = proto?.sendUserMessage;
            if (typeof current !== "function") {
                console.warn("[loop-detector] AgentSession.prototype.sendUserMessage no disponible; sin parche.");
                return false;
            }
            if ((current as unknown as { __piLoopSlashPatch?: boolean }).__piLoopSlashPatch === true) {
                return true;
            }

            const orig = current;
            proto!.sendUserMessage = async function patchedSendUserMessage(
                this: unknown,
                content: unknown,
                options?: { deliverAs?: "steer" | "followUp" },
            ): Promise<void> {
                if (isNewramOrNewSessionExtensionMessage(content)) {
                    const session = this as unknown as ExtensionSessionWithPrompt;
                    await session.prompt(content, {
                        expandPromptTemplates: true,
                        streamingBehavior: options?.deliverAs,
                        source: "extension",
                    });
                    return;
                }
                return (orig as (this: unknown, c: unknown, o?: unknown) => Promise<void>).call(this, content, options);
            };

            (proto!.sendUserMessage as unknown as { __piLoopSlashPatch?: boolean }).__piLoopSlashPatch = true;
            console.log(
                "[loop-detector] Parche activo: sendUserMessage(/newram|/new-session) → prompt(expand) (recovery automático).",
            );
            return true;
        } catch (e) {
            console.warn("[loop-detector] No se pudo parchear AgentSession.sendUserMessage:", e);
            return false;
        }
    })());
}

type ExtensionAPIWithPrompt = ExtensionAPI & {
    prompt?: (
        text: string,
        options?: {
            expandPromptTemplates?: boolean;
            streamingBehavior?: "steer" | "followUp";
            source?: string;
        },
    ) => Promise<void>;
};

function tryCaptureRecoverySessionCtx(ctx: ExtensionContext): void {
    // En Pi stock, los handlers de eventos reciben `ExtensionContext` (runner.createContext):
    // no incluye `newSession` — eso solo lo añade `createCommandContext()` al ejecutar /comando.
    // Si algún fork inyecta `newSession` aquí, el recovery puede evitar el pegado manual.
    const n = (ctx as unknown as { newSession?: unknown }).newSession;
    if (typeof n === "function") {
        recoverySessionCtx = ctx as unknown as ExtensionCommandContext;
    } else {
        recoverySessionCtx = null;
    }
}

async function runNewramAsRealSlash(pi: ExtensionAPI): Promise<boolean> {
    const hook = (globalThis as unknown as { __piPromptInteractive?: (t: string, o?: object) => Promise<void> })
        .__piPromptInteractive;
    if (typeof hook === "function") {
        await hook("/newram", { expandPromptTemplates: true, streamingBehavior: "steer", source: "interactive" });
        return true;
    }

    const p = pi as ExtensionAPIWithPrompt;
    if (typeof p.prompt === "function") {
        await p.prompt("/newram", {
            expandPromptTemplates: true,
            streamingBehavior: "steer",
            source: "interactive",
        });
        return true;
    }

    return false;
}

/**
 * Pi no documenta “pulsar Enter” ni enviar el buffer del editor desde extensiones.
 * `pasteToEditor` solo escribe; el envío lo hace el bucle interactivo del usuario.
 * Si una build expone un método extra (p. ej. submitPrompt), lo probamos sin romper tipos.
 */
async function trySubmitEditorAfterPaste(ui: ExtensionUIContext | undefined): Promise<boolean> {
    if (!ui) return false;
    const dict = ui as unknown as Record<string, unknown>;
    const names = ["submitPrompt", "submitInput", "sendEditor", "flushPrompt"] as const;
    for (const name of names) {
        const fn = dict[name as string];
        if (typeof fn !== "function") continue;
        try {
            const out = (fn as () => unknown).call(ui);
            if (out !== undefined && out !== null && typeof (out as PromiseLike<unknown>).then === "function") {
                await (out as PromiseLike<unknown>);
            }
            console.log(`[loop-detector] ✅ Buffer del editor enviado vía ui.${name}()`);
            return true;
        } catch (e) {
            console.warn(`[loop-detector] ui.${name}() falló:`, e);
        }
    }
    return false;
}

/**
 * Recovery: resumen pendiente en session-utils → `startNewSessionAndUnload(ctx)` si el `ctx`
 * del bucle expone `newSession`; si no, `sendUserMessage` con parche de prototipo, u otros fallbacks.
 */
async function scheduleNewramAfterRecovery(pi: ExtensionAPI): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(() => {
            void (async () => {
                try {
                    const patched = await ensureAgentSessionSendUserMessageSlashPatch();

                    const direct = recoverySessionCtx;
                    if (direct) {
                        recoverySessionCtx = null;
                        try {
                            console.log(
                                `[loop-detector] 🔧 recovery: ctx.newSession disponible → startNewSessionAndUnload directo`,
                            );
                            await startNewSessionAndUnload(direct);
                            console.log(`[loop-detector] ✅ Nueva sesión + unload vía ctx.newSession`);
                            return;
                        } catch (e) {
                            console.warn(
                                `[loop-detector] newSession directo falló, probando /newram vía prompt:`,
                                e,
                            );
                        }
                    }

                    if (patched) {
                        try {
                            console.log(`[loop-detector] 🔧 /newram vía pi.sendUserMessage (AgentSession parcheado)…`);
                            pi.sendUserMessage("/newram", { deliverAs: "steer" });
                            console.log(`[loop-detector] ✅ /newram encolado/ejecutado vía sendUserMessage+parche`);
                            return;
                        } catch (e) {
                            console.warn(`[loop-detector] sendUserMessage(/newram) falló con parche activo:`, e);
                        }
                    }

                    console.log(`[loop-detector] 🔧 Intentando /newram (hook / pi.prompt / pegado)…`);
                    const ok = await runNewramAsRealSlash(pi);
                    if (!ok) {
                        lastUi?.pasteToEditor("/newram");
                        const submitted = await trySubmitEditorAfterPaste(lastUi);
                        if (!submitted) {
                            lastUi?.notify(
                                "Recuperación de bucle: no se pudo parchear AgentSession ni enviar /newram. Se pegó `/newram` en el editor; pulsa Enter. (Si usas un binario que duplica clases, abre issue / recompila Pi con el mismo árbol de módulos que las extensiones.)",
                                "warning",
                            );
                        }
                    } else {
                        console.log(`[loop-detector] ✅ /newram disparado vía prompt/hook`);
                    }
                } catch (e) {
                    console.error("[loop-detector] Fallo al ejecutar /newram:", e);
                    lastUi?.pasteToEditor("/newram");
                    const submitted = await trySubmitEditorAfterPaste(lastUi);
                    if (!submitted) {
                        lastUi?.notify(
                            `Error al ejecutar /newram: ${e instanceof Error ? e.message : String(e)}. Se pegó /newram en el editor; pulsa Enter si hace falta.`,
                            "error",
                        );
                    }
                } finally {
                    resolve();
                }
            })();
        }, 0);
    });
}

async function triggerRecoveryWithNewram(pi: ExtensionAPI, summary: string): Promise<void> {
    console.log(`[loop-detector] 🔧 triggerRecoveryWithNewram called (summary len=${summary.length})`);
    setPendingCompactionSummary(summary);
    await scheduleNewramAfterRecovery(pi);
}

/* ═══════════════ Recovery ═══════════════ */

async function triggerRecovery(ctx: ExtensionContext, loopType: string) {
    if (isRecovering) return;
    isRecovering = true;
    skipIntraMsgAfterCompact = true;
    tryCaptureRecoverySessionCtx(ctx);

    ctx.ui.notify(`🔁 ${loopType.toUpperCase()} LOOP DETECTED — compacting...`, "warning");
    ctx.ui.setStatus("loop-detector", `🔁 ${loopType} — compacting`);

    // Capturar hilo ANTES de abort: compact por defecto puede no tener "viejo" que resumir
    // y además abort puede dejar el mensaje parcial fuera de la sesión.
    const sessionHandoff = captureSessionHandoff(ctx, lastAssistantStreamingText);
    const currentTurnForCompaction = buildCurrentTurnForCompactionInstructions(ctx, lastAssistantStreamingText);

    // Abort stream inmediatamente si está activo
    ctx.abort();

    // Instrucciones específicas para que el resumen capture TODO lo relevante,
    // no solo un template genérico vacío.
    const compactInstructions = `
CRITICAL: Generate a DETAILED, ACTIONABLE summary of this conversation. Do NOT produce a generic template.
Include:
1. USER'S ORIGINAL REQUEST — the exact task/goal stated by the user
2. COMPLETED WORK — what has been finished (file paths, functions, changes)
3. CURRENT STATE — where things stand right now, what's in progress
4. TECHNICAL DECISIONS — key architecture/implementation choices made and WHY
5. FILE PATHS & CODE SNIPPETS — relevant file locations and important code fragments
6. ERRORS ENCOUNTERED — bugs found and how they were resolved
7. NEXT STEPS — what needs to be done next to complete the task
8. CONTEXT PRESERVATION — any environment setup, dependencies, or configuration needed

DISCARD: repetitive reasoning loops, redundant analysis, circular thinking patterns.
KEEP: all factual information, code, file paths, decisions, and progress markers.

---
## CRITICAL — "RECENT TAIL" NOT IN THE SUMMARIZATION BATCH

Default compaction only serializes older messages into the summarization request. The **most recent user prompt** and **assistant/tool work on that prompt** often live in the "kept" tail and are **NOT** in the batch you see as conversation text.

You MUST still fold the following block into your structured summary (Goal, Progress, Critical Context, Next Steps). Treat it as authoritative for the latest user intent and work-in-progress. Never answer as if no user request exists.

${currentTurnForCompaction || "(No current-turn capture; use the serialized batch only.)"}
`.trim();

    ctx.compact({
        customInstructions: compactInstructions,
        onComplete: async (result) => {
            console.log(`[loop-detector] Compacted ${result.tokensBefore} tokens → summary length: ${result.summary.length}`);
            // NOTE: ctx is stale after compact() completes — use piRef.ui instead
            if (piRef?.ui) piRef.ui.setStatus("loop-detector", "Compacted → new session");

            let summaryForInjection = result.summary.trim();
            if (isVacuousCompactionSummary(summaryForInjection)) {
                if (sessionHandoff) {
                    console.warn(
                        `[loop-detector] Compaction summary vacío/genérico (tokensBefore=${result.tokensBefore}) — usando handoff de sesión (${sessionHandoff.length} chars)`
                    );
                    summaryForInjection = sessionHandoff;
                } else {
                    summaryForInjection =
                        `${summaryForInjection}\n\n[loop-detector] Aviso: no hubo extractos de sesión capturables; si falta contexto, resume el objetivo en un mensaje.`;
                }
            }

            // Si el compact es útil, no adjuntamos el handoff completo (evita inyecciones enormes duplicadas).
            // La API (piRef) persiste post-compact — solo el ctx se invalida.
            try {
                const currentPi = piRef;
                if (!currentPi) throw new Error("piRef not available");
                await triggerRecoveryWithNewram(currentPi, summaryForInjection);
            } catch (err) {
                console.error(`[loop-detector] recovery failed:`, err);
                // NOTE: ctx is stale after compact() — use piRef.ui
                if (piRef?.ui) piRef.ui.notify(`Recovery error: ${err instanceof Error ? err.message : String(err)}`, "error");
            }

            // Reset flags después de un grace period
            setTimeout(() => { skipIntraMsgAfterCompact = false; }, 3_000);
        },
        onError: (error) => {
            console.error(`[loop-detector] Compaction failed:`, error);
            // NOTE: ctx is stale after compact() — use piRef.ui
            if (piRef?.ui) {
                piRef.ui.notify("Compaction failed — starting fresh session", "error");
                piRef.ui.setStatus("loop-detector", "Failed ✗");
            }

            // Fallback: nueva sesión con handoff capturado (compact no llegó a devolver resumen)
            if (piRef) {
                if (sessionHandoff) {
                    setPendingCompactionSummary(
                        `## Compaction falló\n\n${error instanceof Error ? error.message : String(error)}\n\n---\n\n${sessionHandoff}`
                    );
                } else {
                    setPendingCompactionSummary(
                        `## Compaction falló\n\n${error instanceof Error ? error.message : String(error)}\n\nNo se pudo capturar handoff de sesión.`,
                    );
                }
                setTimeout(() => {
                    if (piRef) void scheduleNewramAfterRecovery(piRef);
                }, 0);
            }
        },
    });

    // Reset cooldown después de recovery completo
    setTimeout(() => {
        isRecovering = false;
        lastDetectedAt = 0;
    }, CFG.cooldownMs * 3);
}

/* ═══════════════ Handler principal message_update ═══════════════ */

let piRef: ExtensionAPI | null = null;

function handleUpdate(message: { role?: string; content?: unknown }, ctx: ExtensionContext) {
    lastUi = ctx.ui;
    if (!enabled || message.role !== "assistant" || isRecovering) return;

    const text = extractText(message.content);
    const normalized = normalize(text);

    if (normalized.length >= CFG.streamingMinChars && !skipIntraMsgAfterCompact) {
        lastAssistantStreamingText = text;
    }

    // Mínimo de texto antes de detectar
    if (normalized.length < CFG.streamingMinChars) {
        recentNormalized = normalized;
        return;
    }

    // Cooldown anti-falso-positivo
    const now = Date.now();
    if (now - lastDetectedAt < CFG.cooldownMs) {
        recentNormalized = normalized;
        return;
    }

    // Skip después de compactar para no detectar el recovery message como loop
    if (skipIntraMsgAfterCompact) {
        recentNormalized = normalized;
        return;
    }

    recentNormalized = normalized;

    const charDelta = text.length - lastLoopScanTextLen;
    const timeOk = now - lastLoopScanAt >= CFG.streamDetectMinIntervalMs;
    const charOk = charDelta >= CFG.streamDetectMinCharDelta;
    if (!timeOk && !charOk) return;

    lastLoopScanAt = now;
    lastLoopScanTextLen = text.length;

    // Si el texto no creció, probablemente es un frame repetido — detectar igual
    // (los loops se detectan por repetición, no por crecimiento)

    const result = detectIntraMessageLoop(text);
    if (result) {
        lastDetectedAt = now;
        console.log(`[loop-detector] ⚠️ LOOP DETECTED: ${result.type} ×${result.count}`);
        const label = result.type === "delayed" ? "DELAYED REPETITION" : result.type.toUpperCase();
        ctx.ui.setStatus("loop-detector", `🔁 ${label} LOOP`);
        triggerRecovery(ctx, result.type);
    }
}

/* ═══════════════ Handler tool_execution_end ═══════════════ */

function handleToolEnd(event: { toolName: string; args?: Record<string, unknown>; isError: boolean }, ctx: ExtensionContext) {
    lastUi = ctx.ui;
    if (!enabled || isRecovering) return;

    const record: ToolCallRecord = {
        toolName: event.toolName,
        argsHash: hashArgs(event.args ?? {}),
        isError: event.isError,
    };
    toolCallBuffer.push(record);

    if (toolCallBuffer.all.length >= CFG.toolLoopThreshold) {
        const now = Date.now();
        if (now - lastDetectedAt < CFG.cooldownMs) return;

        if (detectToolLoop(toolCallBuffer.all)) {
            lastDetectedAt = now;
            console.log(`[loop-detector] ⚠️ TOOL LOOP: ${record.toolName} ×${CFG.toolLoopThreshold}`);
            ctx.ui.setStatus("loop-detector", "🔁 TOOL LOOP");
            triggerRecovery(ctx, "tool_loop");
        }
    }
}

/* ═══════════════ Handler message_end (cross-turn) ═══════════════ */

function handleMessageEnd(message: { role?: string; content?: unknown }, ctx: ExtensionContext) {
    lastUi = ctx.ui;
    if (!enabled || message.role !== "assistant" || isRecovering) return;

    const text = extractText(message.content);
    if (text.trim().length < 50) return; // ignorar mensajes cortos

    // Un escaneo completo al cerrar el mensaje (sin throttle): evita perder un bucle
    // si el último chunk del stream era pequeño y no disparó el escaneo incremental.
    if (text.length >= CFG.streamingMinChars) {
        const now = Date.now();
        if (now - lastDetectedAt >= CFG.cooldownMs) {
            const intra = detectIntraMessageLoop(text);
            if (intra) {
                lastDetectedAt = now;
                console.log(`[loop-detector] ⚠️ LOOP DETECTED (message_end): ${intra.type} ×${intra.count}`);
                const label = intra.type === "delayed" ? "DELAYED REPETITION" : intra.type.toUpperCase();
                ctx.ui.setStatus("loop-detector", `🔁 ${label} LOOP`);
                triggerRecovery(ctx, intra.type);
                return;
            }
        }
    }

    assistantTexts.push(text);
    while (assistantTexts.length > CFG.crossTurnLookback * 2) {
        assistantTexts.shift();
    }

    if (detectCrossTurnLoop()) {
        const now = Date.now();
        if (now - lastDetectedAt >= CFG.cooldownMs) {
            lastDetectedAt = now;
            console.log(`[loop-detector] ⚠️ CROSS-TURN LOOP detected`);
            triggerRecovery(ctx, "cross_turn");
        }
    }
}

/* ═══════════════ Factory de extensión ═══════════════ */

export default async function (pi: ExtensionAPI) {
    piRef = pi;
    void ensureAgentSessionSendUserMessageSlashPatch();

    // message_update — streaming detection (PRIMARY)
    pi.on("message_update", async (event, ctx) => {
        lastUi = ctx.ui;
        const msg = event.message as { role?: string; content?: unknown } | undefined;
        if (msg) handleUpdate(msg, ctx);
    });

    // tool_execution_end — tool loop detection
    pi.on("tool_execution_end", async (event, ctx) => {
        lastUi = ctx.ui;
        handleToolEnd(event, ctx);
    });

    // message_end — cross-turn detection (SECONDARY)
    pi.on("message_end", async (_event, ctx) => {
        lastUi = ctx.ui;
        handleMessageEnd(_event.message as { role?: string; content?: unknown } | undefined, ctx);
    });

    // Reset en nueva sesión + actualizar piRef al nuevo API
    pi.on("session_start", async (_event, ctx) => {
        lastUi = ctx.ui;
        recentNormalized = "";
        lastAssistantStreamingText = "";
        lastLoopScanAt = 0;
        lastLoopScanTextLen = 0;
        lastDetectedAt = 0;
        isRecovering = false;
        skipIntraMsgAfterCompact = false;
        assistantTexts.length = 0;
        toolCallBuffer.clear();
    });

    // Reset en nuevo turno (limpiar buffer de tool calls)
    pi.on("turn_start", async () => {
        toolCallBuffer.clear();
        lastLoopScanAt = 0;
        lastLoopScanTextLen = 0;
    });

    // Comando para ver estado
    pi.registerCommand("loop-status", {
        description: "Show loop detector status",
        handler: async (_args, ctx) => {
            const patched = await ensureAgentSessionSendUserMessageSlashPatch().catch(() => false);
            ctx.ui.notify(
                `Loop Detector:\n` +
                `  sendUserMessage+slash patch: ${patched ? "activo ✓" : "no aplicado ✗"}\n` +
                `  Streaming min: ${CFG.streamingMinChars} chars\n` +
                `  Exact repeats: ${CFG.minExactRepeats} | phrase ${CFG.minPhraseWords}-${CFG.maxPhraseWords} words (≥${CFG.minPhraseChars} chars)\n` +
                `  Paragraph min: ${CFG.paragraphMinChars} chars | scan max ${CFG.maxWordsScan} words (tail)\n` +
                `  Stream scan: ≥${CFG.streamDetectMinCharDelta} chars or ≥${CFG.streamDetectMinIntervalMs}ms | delayed max ${CFG.delayedMaxBlocks} blocks\n` +
                `  Tool window: ${CFG.toolCallWindow} | Loop threshold: ${CFG.toolLoopThreshold}\n` +
                `  Cross-turn: ${CFG.crossTurnLookback} lookback | min ${CFG.crossTurnMinChars} chars | exact match ×${CFG.minExactRepeats}\n` +
                `  Cooldown: ${CFG.cooldownMs}ms\n` +
                `  Recovering: ${isRecovering}`,
                "info"
            );
        },
    });

    // Toggle on/off
    pi.registerCommand("loop-toggle", {
        description: "Toggle loop detector on/off",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            ctx.ui.notify(`Loop detector ${enabled ? "enabled ✓" : "disabled ✗"}`, "info");
        },
    });

    pi.registerCommand("newram", {
        description: "Start new session and unload LM Studio model (free RAM + KV cache)",
        handler: async (_args, ctx) => {
            await startNewSessionAndUnload(ctx);
        },
    });

    pi.registerCommand("new-session", {
        description: "Start a new session (programmatic alias for /newram)",
        handler: async (_args, ctx) => {
            await startNewSessionAndUnload(ctx);
        },
    });

    return pi;
}
