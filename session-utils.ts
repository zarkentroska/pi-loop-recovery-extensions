/**
 * session-utils — Funciones reutilizables para gestión de sesiones.
 * Compartida con loop-detector (comandos `/newram` y `/new-session` registrados allí).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";

/* ═══════════════ Estado compartido entre extensiones ═══════════════ */

/**
 * Pi puede cargar cada extensión como entrada distinta; entonces dos imports de
 * este módulo no comparten el mismo closure. `globalThis` sí es único por runtime.
 */
const PENDING_KEY = "__piPendingCompactionSummary" as const;

export function setPendingCompactionSummary(summary: string): void {
    console.log(`[session-utils] ⬆️ setPendingCompactionSummary (len=${summary.length})`);
    (globalThis as unknown as Record<string, string | null>)[PENDING_KEY] = summary;
}

function consumePendingCompactionSummary(): string | null {
    const g = globalThis as unknown as Record<string, string | null | undefined>;
    const summary = g[PENDING_KEY] ?? null;
    g[PENDING_KEY] = null;
    console.log(`[session-utils] ⬇️ consumePendingCompactionSummary (len=${summary?.length ?? 0})`);
    return summary;
}

/* ═══════════════ Helpers LM Studio ═══════════════ */

async function unloadLmStudio(): Promise<string> {
  let unloadedModelName = "";
  try {
    const listRes = await fetch("http://localhost:1234/api/v0/models");
    if (!listRes.ok) {
      throw new Error(`LM Studio not reachable (status ${listRes.status})`);
    }
    const listData = (await listRes.json()) as { data?: Array<{ id: string; name?: string }> };
    const models = listData.data ?? [];

    if (models.length > 0) {
      const activeModel = models[0];
      unloadedModelName = activeModel.name ?? activeModel.id;

      const unloadRes = await fetch("http://localhost:1234/api/v1/models/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: activeModel.id }),
      });

      if (!unloadRes.ok) {
        const errText = await unloadRes.text();
        unloadedModelName = ""; // reset — unload failed
      }
    }
  } catch {
    // LM Studio not running — proceed anyway
    unloadedModelName = "";
  }
  return unloadedModelName;
}

/* ═══════════════ Nueva sesión + unload (para /newram) ═══════════════ */

/**
 * Unload LM Studio model + start a fresh session.
 * If loop-detector has stored a pending compaction summary, it is automatically
 * injected as a user message inside this fresh context — the ONLY safe place
 * for sendUserMessage after session replacement.
 */
export async function startNewSessionAndUnload(
  ctx: ExtensionCommandContext,
  onDone?: (freshCtx: ReplacedSessionContext) => Promise<void>
): Promise<string> {
  const unloadedModelName = await unloadLmStudio();

  // Check for pending compaction summary from loop-detector.
  let finalOnDone = onDone;
  const compactionSummary = consumePendingCompactionSummary();
  if (compactionSummary) {
    const injectionText = buildCompactedContextText(compactionSummary);
    console.log(`[session-utils] 📝 Will inject compaction text (${injectionText.length} chars)`);

    const injectInFreshCtx = async (freshCtx: ReplacedSessionContext) => {
      console.log(`[session-utils] 📤 Calling freshCtx.sendUserMessage()`);
      try {
        try {
          await freshCtx.sendUserMessage(injectionText);
        } catch (first) {
          console.warn(`[session-utils] sendUserMessage (idle) failed, retry steer:`, first);
          await freshCtx.sendUserMessage(injectionText, { deliverAs: "steer" });
        }
        console.log(`[session-utils] ✅ sendUserMessage completed`);
        freshCtx.ui.notify(
          `Contexto compactado inyectado (${injectionText.length} caracteres).`,
          "success"
        );
      } catch (e) {
        console.error(`[session-utils] ❌ sendUserMessage failed:`, e);
        freshCtx.ui.notify(
          `No se pudo inyectar el contexto compactado: ${e instanceof Error ? e.message : String(e)}`,
          "error"
        );
      }
    };

    if (onDone) {
      finalOnDone = async (freshCtx) => {
        await injectInFreshCtx(freshCtx);
        await onDone(freshCtx);
      };
    } else {
      finalOnDone = injectInFreshCtx;
    }
  } else {
    console.log(`[session-utils] ⚠️ No pending compaction summary — skipping injection`);
  }

  await ctx.newSession({
    withSession: async (freshCtx) => {
      if (unloadedModelName) {
        freshCtx.ui.notify(`✅ ${unloadedModelName} unloaded. New session started.`, "success");
      } else {
        freshCtx.ui.notify("✅ New session started.", "success");
      }
      // Run any additional callback in the fresh context
      if (finalOnDone) {
        await finalOnDone(freshCtx);
      }
    },
  });

  return unloadedModelName;
}

/* ═══════════════ Helpers de texto ═══════════════ */

/**
 * Construye el texto del contexto compactado.
 */
export function buildCompactedContextText(summary: string): string {
  return `[COMPACTED CONTEXT]\n${summary}\n\n[END COMPACTED CONTEXT]\n\nRead the compacted context above. Continue working on the task described there. Focus on making forward progress — do not repeat previous reasoning steps or regenerate already-completed work.`;
}

/* ═══════════════ No-op factory (para que el loader de pi no falle) ═══════════════ */
export default function (_pi: ExtensionAPI) {
  // Este archivo solo exporta utilidades; no registra nada como extensión.
}
