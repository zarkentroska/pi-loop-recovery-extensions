# 🔄 Pi Loop Recovery Extensions

🛡️ Extensions for [**Pi**](https://github.com/earendil-works/pi) (the `pi` coding agent) that **detect repetitive reasoning loops** in the assistant stream and **recover automatically**: compact context, carry a summary forward, start a fresh session, optionally unload the LM Studio model, and reinject the compacted context.

## ✨ What you get

- 🕵️ **Loop detector** (`loop-detector.ts`): watches streaming assistant output and tool patterns; on sustained identical phrases, paragraphs, delayed repeats, tool loops, or cross-turn duplicates, it triggers **compaction** with handoff-aware instructions, stores a summary in shared state, then runs **`/newram`**-style recovery (new session + LM Studio unload + injection of compacted context via `session-utils`).
- 🔧 **Session helpers** (`session-utils.ts`): LM Studio unload via local HTTP API, `globalThis`-backed pending compaction summary so injection survives extension bundling quirks, and safe injection on the **replaced** session context.

## ⚡ Automatic slash-command fix (reasoning-loop patch)

Pi wires `pi.sendUserMessage` to `AgentSession.sendUserMessage`, which always calls `prompt` with **`expandPromptTemplates: false`**, so extension-originated **`/newram`** would otherwise appear as plain text (not executed). This repo's detector applies a **small runtime patch** to `AgentSession.prototype.sendUserMessage` so that **`/newram`** and **`/new-session`** are routed through **`prompt` with expansion**, matching interactive Enter behavior—**without** requiring you to press Enter after paste.

✅ Only those two commands are special-cased; everything else keeps Pi's default semantics.

## 🧪 Tested configuration

Manual testing was done with **Qwen 3.6 35B A3B** in both:

- 🍎 **MLX** (Apple Silicon), and  
- 📡 **GGUF** (via **LM Studio**),

as the local model behind Pi, while deliberately triggering long identical-reasoning streams to validate detection, compaction, session restart, and context reinjection.

> ⚠️ Models and sampling settings vary; treat this as **field-tested on the setup above**, not a formal CI guarantee.

## 📋 Requirements

- 🧩 Pi with the extension loader and `@earendil-works/pi-coding-agent` available to extensions (standard Pi install).
- 💡 Optional: **LM Studio** on `localhost:1234` if you want automatic model unload during `/newram`.

## 📦 Install (incorporate these extensions)

1. 📂 **Copy the two files** next to each other (imports use `./session-utils.js`; Pi's loader resolves `.ts`):

   **🌍 Global (recommended)**  
   Copy into your agent extensions directory:

   ```bash
   mkdir -p ~/.pi/agent/extensions
   cp loop-detector.ts session-utils.ts ~/.pi/agent/extensions/
   ```

   **📁 Project-local**  
   If you prefer per-project extensions:

   ```bash
   mkdir -p .pi/extensions
   cp loop-detector.ts session-utils.ts .pi/extensions/
   ```

   (Pi discovers `extensions/*.ts` under the configured agent paths; see Pi docs for your version.)

2. 🔄 **Reload extensions** in Pi (e.g. `/reload` or restart the agent) so the new modules load.

3. ✅ **Verify** with `/loop-status` — you should see whether the **`sendUserMessage` slash patch** is active.

### 🎛️ Commands registered

| Command        | Purpose |
|----------------|---------|
| `/loop-status` | 🔍 Show detector thresholds and patch status |
| `/loop-toggle` | 🔄 Enable/disable the detector |
| `/newram`      | 🆕 New session + LM Studio unload + optional compaction injection |
| `/new-session` | 📋 Alias of `/newram` |

## 🚀 Publish to GitHub

This checkout is already a **git** repo on branch `main`. Prefer **`gh auth login`** (browser/device flow) once on your machine — no token in chat or in the repo.

### Option A — interactive (recommended)

```bash
cd /path/to/pi-loop-recovery-extensions
gh auth login
./scripts/gh-push.sh
```

### Option B — PAT from a local file (run only in your own Terminal; revoke the token after)

```bash
cd /path/to/pi-loop-recovery-extensions
export GH_TOKEN="$(cat /path/to/token.txt)"
./scripts/gh-push.sh
```

The script creates `YOUR_LOGIN/pi-loop-recovery-extensions` (or the name you pass) as a **public** repo and pushes `main`.

### Option C — manual remote

```bash
git remote add origin git@github.com:YOUR_USER/pi-loop-recovery-extensions.git
git push -u origin main
```

## 🛡️ Safety & scope

- ⚠️ The prototype patch is **narrow** (`/newram`, `/new-session` only) but **relies on sharing the same `AgentSession` class** as the running Pi process. Unusual packagings (duplicate class copies) could make the patch ineffective; the extension falls back to documented UI paths when needed.
- 🎛️ Tuning thresholds is in `loop-detector.ts` (`CFG`); raise repeats if you see false positives on chatty models.

## 📜 License

The Pi project has its own license. These snippets are provided *as-is* for use with Pi; add a `LICENSE` file of your choice if you publish a standalone repo.
