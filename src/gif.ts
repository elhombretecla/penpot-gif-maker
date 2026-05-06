import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { ExportedFrame, GifSettings, TransparentChoice } from "./types";

interface DecodedFrame {
  name: string;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  delayMs: number;
}

const TRANSPARENT_COLORS: Record<
  Exclude<TransparentChoice, "none">,
  [number, number, number]
> = {
  white: [0xff, 0xff, 0xff],
  black: [0x00, 0x00, 0x00],
  peach: [0xfb, 0x99, 0x99],
};

async function decodePngToImageData(
  png: Uint8Array,
): Promise<{ data: ImageData; width: number; height: number }> {
  // Use a fresh ArrayBuffer so we don't get a SharedArrayBuffer typing mismatch.
  const buffer = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create 2D context for frame decoding.");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

// Strategy: use the maximum width and height across all frames as the GIF
// canvas, then center each smaller frame inside it. This keeps every frame
// fully visible regardless of its size.
function composeFrame(
  source: ImageData,
  canvasWidth: number,
  canvasHeight: number,
  bgFill: [number, number, number] | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  if (bgFill) {
    for (let i = 0; i < out.length; i += 4) {
      out[i] = bgFill[0];
      out[i + 1] = bgFill[1];
      out[i + 2] = bgFill[2];
      out[i + 3] = 255;
    }
  }
  // else: leave fully transparent (alpha 0)

  const offsetX = Math.floor((canvasWidth - source.width) / 2);
  const offsetY = Math.floor((canvasHeight - source.height) / 2);

  for (let y = 0; y < source.height; y++) {
    const dstY = y + offsetY;
    if (dstY < 0 || dstY >= canvasHeight) continue;
    for (let x = 0; x < source.width; x++) {
      const dstX = x + offsetX;
      if (dstX < 0 || dstX >= canvasWidth) continue;
      const srcIdx = (y * source.width + x) * 4;
      const dstIdx = (dstY * canvasWidth + dstX) * 4;
      const srcA = source.data[srcIdx + 3];
      if (srcA === 0 && !bgFill) {
        // already transparent
        continue;
      }
      out[dstIdx] = source.data[srcIdx];
      out[dstIdx + 1] = source.data[srcIdx + 1];
      out[dstIdx + 2] = source.data[srcIdx + 2];
      out[dstIdx + 3] = source.data[srcIdx + 3];
    }
  }
  return out;
}

// Replace target-color pixels with rgba(0,0,0,0) so they map to the
// transparent palette entry produced by gifenc when `clearAlpha` is on
// (the default). A small per-channel tolerance handles compression noise
// from the PNG export.
//
// We must also clear RGB — not just alpha — because gifenc's applyPalette
// uses euclidean distance in RGBA space. Leaving RGB=255,255,255 with
// alpha=0 would still map to an opaque white palette entry (alpha distance
// 65025 < rgb distance 195075), so the GIF would render as solid white
// even though the palette contains a transparent slot. Snapping to
// (0,0,0,0) makes the input pixel coincide exactly with the transparent
// palette entry, which guarantees the right index.
function knockoutColor(
  rgba: Uint8ClampedArray,
  target: [number, number, number],
  tolerance = 6,
): void {
  const [tr, tg, tb] = target;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs(rgba[i] - tr) <= tolerance &&
      Math.abs(rgba[i + 1] - tg) <= tolerance &&
      Math.abs(rgba[i + 2] - tb) <= tolerance
    ) {
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 0;
    }
  }
}

function loopValue(loop: GifSettings["loop"]): number {
  // gifenc: 0 = forever, -1 = play once, >0 = N additional repeats.
  return loop === "once" ? -1 : 0;
}

export type GifProgressPhase = "decoding" | "encoding";
export type GifProgressCallback = (
  phase: GifProgressPhase,
  current: number,
  total: number,
) => void;

// Yield to the browser so progress UI can repaint between heavy frames.
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildGif(
  exported: ExportedFrame[],
  settings: GifSettings,
  onProgress?: GifProgressCallback,
): Promise<Blob> {
  if (exported.length === 0) {
    throw new Error("No frames to encode.");
  }

  const decoded: DecodedFrame[] = [];
  for (let i = 0; i < exported.length; i++) {
    const f = exported[i];
    const { data } = await decodePngToImageData(f.png);
    decoded.push({
      name: f.name,
      rgba: data.data,
      width: data.width,
      height: data.height,
      delayMs: f.delayMs,
    });
    onProgress?.("decoding", i + 1, exported.length);
  }

  // Snapshot the wrapped frame for later access by index.
  const frameImages = decoded.map(
    (f) =>
      ({
        data: f.rgba,
        width: f.width,
        height: f.height,
        colorSpace: "srgb",
      }) as unknown as ImageData,
  );

  const canvasWidth = Math.max(...decoded.map((f) => f.width));
  const canvasHeight = Math.max(...decoded.map((f) => f.height));

  const transparentChoice = settings.transparent;
  const targetColor =
    transparentChoice === "none"
      ? null
      : TRANSPARENT_COLORS[transparentChoice];

  // When transparency is enabled we must NOT pre-fill the canvas with the
  // target color. Composing to an alpha=0 canvas is the cleanest way to
  // produce real transparent regions in the output GIF.
  const bgFill: [number, number, number] | null = targetColor
    ? null
    : [255, 255, 255];

  const gif = GIFEncoder();
  const repeat = loopValue(settings.loop);
  const colors = Math.max(2, Math.min(256, Math.round(settings.quality) || 256));

  for (let i = 0; i < frameImages.length; i++) {
    const composed = composeFrame(
      frameImages[i],
      canvasWidth,
      canvasHeight,
      bgFill,
    );

    if (targetColor) {
      knockoutColor(composed, targetColor);
    }

    const format = targetColor ? "rgba4444" : "rgb444";
    const palette = quantize(composed, colors, {
      format,
      // Binary alpha: any palette entry below the threshold collapses to
      // alpha=0 (transparent), the rest to alpha=255 (opaque). This avoids
      // intermediate alpha values which GIF cannot represent anyway.
      oneBitAlpha: targetColor ? true : false,
      // Snap any near-transparent entry to alpha=0 with RGB=0, matching
      // the (0,0,0,0) sentinel produced by knockoutColor so applyPalette
      // maps knocked-out pixels to the transparent slot.
      clearAlpha: true,
      clearAlphaThreshold: targetColor ? 64 : 0,
    });
    const indexed = applyPalette(composed, palette, format);

    let transparentIndex = -1;
    if (targetColor) {
      for (let p = 0; p < palette.length; p++) {
        const entry = palette[p];
        if (entry.length === 4 && entry[3] === 0) {
          transparentIndex = p;
          break;
        }
      }
    }

    gif.writeFrame(indexed, canvasWidth, canvasHeight, {
      palette,
      delay: decoded[i].delayMs,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      repeat: i === 0 ? repeat : 0,
      dispose: targetColor ? 2 : -1,
    });

    onProgress?.("encoding", i + 1, frameImages.length);
    // Yield to the event loop so the progress bar can repaint between frames.
    await nextTick();
  }

  gif.finish();
  const bytes = gif.bytes();
  // Wrap in a fresh ArrayBuffer so Blob's strict typing accepts it.
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return new Blob([out], { type: "image/gif" });
}
