import type {
  ExportedFrame,
  GifSettings,
  PluginToUi,
  UiToPlugin,
} from "./types";

const PLUGIN_TITLE = "Animated Gif Maker";

penpot.ui.open(PLUGIN_TITLE, `?theme=${penpot.theme}`, {
  width: 640,
  height: 460,
});

function send(message: PluginToUi): void {
  penpot.ui.sendMessage(message);
}

function sendSelectionInfo(): void {
  const selection = penpot.selection ?? [];
  send({
    type: "selection",
    count: selection.length,
    names: selection.map((s) => s.name),
  });
}

// Per-frame delay can be encoded in the shape name as a trailing
// `:1234ms` (the `ms` is optional). Returns null if no override is found.
function parseDelayFromName(name: string): number | null {
  const match = name.match(/:\s*(\d+)\s*ms?\s*$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function clampDelay(delay: number, fallback: number): number {
  if (!Number.isFinite(delay) || delay < 20) return fallback;
  return Math.round(delay);
}

async function exportFrames(settings: GifSettings): Promise<void> {
  const selection = penpot.selection ?? [];
  if (selection.length === 0) {
    send({
      type: "error",
      message: "Select at least one frame, group, or layer to generate a GIF.",
    });
    return;
  }

  const fallbackDelay = clampDelay(settings.delayMs, 100);
  const scale = Math.max(0.1, Math.min(4, settings.scale || 1));

  try {
    const frames: ExportedFrame[] = [];
    for (const shape of selection) {
      const png = await shape.export({ type: "png", scale });
      const overrideDelay = parseDelayFromName(shape.name);
      const delayMs =
        overrideDelay !== null
          ? clampDelay(overrideDelay, fallbackDelay)
          : fallbackDelay;
      frames.push({
        id: shape.id,
        name: shape.name,
        width: Math.round(shape.width * scale),
        height: Math.round(shape.height * scale),
        delayMs,
        png,
      });
    }
    send({ type: "frames", frames });
  } catch (err) {
    send({
      type: "error",
      message:
        err instanceof Error
          ? err.message
          : "Failed to export the selected shapes.",
    });
  }
}

penpot.ui.onMessage<UiToPlugin>((message) => {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "ready":
      sendSelectionInfo();
      send({ type: "theme", theme: penpot.theme });
      break;
    case "request-selection":
      sendSelectionInfo();
      break;
    case "generate":
      void exportFrames(message.settings);
      break;
    case "close":
      penpot.closePlugin();
      break;
  }
});

penpot.on("themechange", (theme) => {
  send({ type: "theme", theme });
});

penpot.on("selectionchange", () => {
  sendSelectionInfo();
});
