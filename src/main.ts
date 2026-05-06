import "./style.css";
import { buildGif } from "./gif";
import type {
  GifSettings,
  LoopChoice,
  PluginToUi,
  TransparentChoice,
  UiToPlugin,
} from "./types";

const searchParams = new URLSearchParams(window.location.search);
document.body.dataset.theme = searchParams.get("theme") ?? "light";

interface UiState {
  selectionCount: number;
  generating: boolean;
  lastGifUrl: string | null;
  lastGifFile: File | null;
}

const state: UiState = {
  selectionCount: 0,
  generating: false,
  lastGifUrl: null,
  lastGifFile: null,
};

// Build a friendly filename from a layer name. Strips the optional
// `:1234ms` per-frame delay suffix and replaces filesystem-unsafe chars.
function filenameFromShape(name: string | undefined): string {
  const fallback = "animation.gif";
  if (!name) return fallback;
  const cleaned = name
    .replace(/:\s*\d+\s*(?:ms)?\s*$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.toLowerCase().endsWith(".gif") ? cleaned : `${cleaned}.gif`;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
};

const elements = {
  delayInput: $<HTMLInputElement>("#delay-input"),
  transparentSelect: $<HTMLSelectElement>("#transparent-select"),
  loopSelect: $<HTMLSelectElement>("#loop-select"),
  qualityInput: $<HTMLInputElement>("#quality-input"),
  scaleSelect: $<HTMLSelectElement>("#scale-select"),
  generateBtn: $<HTMLButtonElement>("[data-handler='generate']"),
  generateLabel: $<HTMLSpanElement>("[data-role='generate-label']"),
  progress: $<HTMLSpanElement>("[data-role='progress']"),
  progressBar: $<HTMLSpanElement>("[data-role='progress-bar']"),
  downloadBtn: $<HTMLButtonElement>("[data-handler='download']"),
  emptyNotice: $<HTMLDivElement>("[data-role='empty-message']"),
  singleNotice: $<HTMLDivElement>("[data-role='single-warning']"),
  errorNotice: $<HTMLDivElement>("[data-role='error']"),
  previewPlaceholder: $<HTMLDivElement>("[data-role='preview-placeholder']"),
  previewImg: $<HTMLImageElement>("[data-role='preview-img']"),
  previewMeta: $<HTMLDivElement>("[data-role='preview-meta']"),
  instructionsModal: $<HTMLDialogElement>("[data-role='instructions-modal']"),
  openInstructionsBtn: $<HTMLButtonElement>("[data-handler='open-instructions']"),
  closeInstructionsBtn: $<HTMLButtonElement>("[data-handler='close-instructions']"),
};

// Weights add up to 1. Export tends to dominate in Penpot, encode is next,
// decode is the cheapest. Tweak here if real-world ratios shift.
const PHASE_WEIGHTS = { exporting: 0.5, decoding: 0.2, encoding: 0.3 } as const;
type Phase = keyof typeof PHASE_WEIGHTS;

function setProgress(ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  elements.progressBar.style.inlineSize = `${clamped * 100}%`;
}

function showProgress(visible: boolean): void {
  elements.progress.hidden = !visible;
  setProgress(0);
}

function applyPhaseProgress(phase: Phase, current: number, total: number): void {
  if (total <= 0) return;
  const phaseRatio = current / total;
  let acc = 0;
  for (const key of Object.keys(PHASE_WEIGHTS) as Phase[]) {
    if (key === phase) {
      acc += PHASE_WEIGHTS[key] * phaseRatio;
      break;
    }
    acc += PHASE_WEIGHTS[key];
  }
  setProgress(acc);
}

function postToPlugin(message: UiToPlugin): void {
  parent.postMessage(message, "*");
}

function setError(message: string | null): void {
  if (!message) {
    elements.errorNotice.hidden = true;
    elements.errorNotice.textContent = "";
    return;
  }
  elements.errorNotice.textContent = message;
  elements.errorNotice.hidden = false;
}

function refreshSelectionState(): void {
  const count = state.selectionCount;
  elements.emptyNotice.hidden = count !== 0;
  elements.singleNotice.hidden = count !== 1;
  elements.generateBtn.disabled = state.generating || count === 0;
}

function readSettings(): GifSettings {
  const delayMs = Number.parseInt(elements.delayInput.value, 10);
  const quality = Number.parseInt(elements.qualityInput.value, 10);
  const scale = Number.parseFloat(elements.scaleSelect.value);
  return {
    delayMs: Number.isFinite(delayMs) ? delayMs : 100,
    transparent: elements.transparentSelect.value as TransparentChoice,
    loop: elements.loopSelect.value as LoopChoice,
    quality: Number.isFinite(quality) ? quality : 256,
    scale: Number.isFinite(scale) ? scale : 1,
  };
}

function setGenerating(value: boolean): void {
  state.generating = value;
  elements.generateBtn.disabled = value || state.selectionCount === 0;
  elements.generateLabel.textContent = value ? "Generating…" : "Generate GIF";
  showProgress(value);
}

// Wrapping the bytes in a `File` rather than a plain `Blob` makes Chrome use
// the File's `name` property as the suggested filename for both right-click
// "Save image as…" on the preview and the popup's native save dialog. This
// is the only filename hint that survives a sandboxed iframe without
// `allow-downloads`.
function showPreview(blob: Blob, frameCount: number, filename: string): void {
  if (state.lastGifUrl) URL.revokeObjectURL(state.lastGifUrl);
  const file = new File([blob], filename, { type: "image/gif" });
  const url = URL.createObjectURL(file);
  state.lastGifUrl = url;
  state.lastGifFile = file;
  elements.previewImg.src = url;
  elements.previewImg.hidden = false;
  elements.previewPlaceholder.hidden = true;
  const sizeKb = (blob.size / 1024).toFixed(1);
  elements.previewMeta.textContent = `${filename} · ${frameCount} frame${
    frameCount === 1 ? "" : "s"
  } · ${sizeKb} KB`;
  elements.previewMeta.hidden = false;
  elements.downloadBtn.disabled = false;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Penpot embeds plugins in a sandboxed iframe whose sandbox attribute does
// NOT include `allow-downloads`. Chrome silently blocks <a download> there,
// for both blob: and data: URLs. The two paths that still work from inside
// such a sandbox are:
//   1) Open the GIF in a new browser tab via window.open() — the user then
//      uses the browser's native save (Ctrl+S, right-click save). This
//      requires `allow-popups`, which Penpot's sandbox does grant.
//   2) Right-click the preview image and pick "Save image as…", which is
//      always available because it lives in the browser chrome, not in
//      sandbox-controlled JS.
async function downloadCurrent(): Promise<void> {
  const file = state.lastGifFile;
  const blobUrl = state.lastGifUrl;
  if (!file || !blobUrl) return;

  setError(null);

  const win = window.open(blobUrl, "_blank", "noopener");
  if (win) return;

  try {
    const dataUrl = await blobToDataUrl(file);
    const opened = window.open(dataUrl, "_blank", "noopener");
    if (opened) return;
  } catch {
    /* ignore */
  }

  setError(
    'Your browser blocked the download tab. Right-click the preview and choose "Save image as…" to save the GIF.',
  );
}

elements.generateBtn.addEventListener("click", () => {
  setError(null);
  if (state.selectionCount === 0) return;
  setGenerating(true);
  elements.downloadBtn.disabled = true;
  postToPlugin({ type: "generate", settings: readSettings() });
});

elements.downloadBtn.addEventListener("click", () => {
  void downloadCurrent();
});

elements.openInstructionsBtn.addEventListener("click", () => {
  elements.instructionsModal.showModal();
});

elements.closeInstructionsBtn.addEventListener("click", () => {
  elements.instructionsModal.close();
});

// Native <dialog> doesn't close on backdrop click out of the box. The click
// event still fires on the dialog element when the user clicks outside the
// inner card, so we use the click coordinates against the dialog rect to
// detect a backdrop hit.
elements.instructionsModal.addEventListener("click", (event) => {
  const dialog = elements.instructionsModal;
  const rect = dialog.getBoundingClientRect();
  const inside =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  if (!inside) dialog.close();
});

window.addEventListener("message", async (event) => {
  const data = event.data as PluginToUi | { source: string };
  if (!data || typeof data !== "object") return;

  if ("source" in data && data.source === "penpot") {
    return;
  }

  const message = data as PluginToUi;
  switch (message.type) {
    case "theme":
      document.body.dataset.theme = message.theme;
      break;
    case "selection":
      state.selectionCount = message.count;
      refreshSelectionState();
      break;
    case "progress":
      applyPhaseProgress(message.phase, message.current, message.total);
      break;
    case "frames": {
      try {
        const blob = await buildGif(message.frames, readSettings(), (phase, current, total) => {
          applyPhaseProgress(phase, current, total);
        });
        const filename = filenameFromShape(message.frames[0]?.name);
        showPreview(blob, message.frames.length, filename);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to build GIF.");
      } finally {
        setGenerating(false);
      }
      break;
    }
    case "error":
      setError(message.message);
      setGenerating(false);
      break;
  }
});

postToPlugin({ type: "ready" });
refreshSelectionState();
