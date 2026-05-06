export type TransparentChoice = "none" | "white" | "black" | "peach";

export type LoopChoice = "forever" | "once";

export interface GifSettings {
  delayMs: number;
  transparent: TransparentChoice;
  loop: LoopChoice;
  quality: number;
  scale: number;
}

export interface ExportedFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  delayMs: number;
  png: Uint8Array;
}

export type UiToPlugin =
  | { type: "ready" }
  | { type: "request-selection" }
  | { type: "generate"; settings: GifSettings }
  | { type: "close" };

export type PluginToUi =
  | { type: "theme"; theme: "light" | "dark" }
  | {
      type: "selection";
      count: number;
      names: string[];
    }
  | { type: "frames"; frames: ExportedFrame[] }
  | { type: "error"; message: string };
