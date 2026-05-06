/// <reference types="vite/client" />

declare module "gifenc" {
  type RgbColor = [number, number, number];
  type RgbaColor = [number, number, number, number];
  export type Palette = RgbColor[] | RgbaColor[];

  export type Format = "rgb444" | "rgb565" | "rgba4444";

  export interface QuantizeOptions {
    format?: Format;
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette;

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: Palette,
    format?: Format,
  ): Uint8Array;

  export interface WriteFrameOptions {
    palette?: Palette;
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface Encoder {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void;
    readonly buffer: ArrayBuffer;
  }

  export function GIFEncoder(opts?: {
    initialCapacity?: number;
    auto?: boolean;
  }): Encoder;
}
