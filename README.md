# Penpot Gif Maker — Penpot Plugin

A Penpot plugin that turns the current selection (frames, boards, groups, or
shapes) into an animated GIF. Each selected item becomes one animation frame.

## Requirements

- Node.js (LTS) and npm
- A running Penpot workspace (cloud or self-hosted) where you can install
  custom plugins via the Plugin Manager (`Ctrl + Alt + P`).

## Install and run

```bash
npm install
npm run dev
```

This starts a local server at `http://localhost:4400`. To load the plugin in
Penpot:

1. Open any Penpot file.
2. Press `Ctrl + Alt + P` to open the Plugin Manager.
3. Paste `http://localhost:4400/manifest.json` and install.
4. Run **Penpot Gif Maker** from the plugins list.

For a production build:

```bash
npm run build
```

The output goes to `dist/` and can be served from any static host. Point
Penpot at `<host>/manifest.json` to install.

## How to use it

1. Lay out the animation as a row of Penpot frames, boards, groups or shapes.
2. Optionally encode a per-frame delay in the layer name, for example
   `Frame 9:1000ms`.
3. Select all of the items (in the order you want them to animate).
4. Open the plugin and configure:
   - **Frame Delay (ms):** default delay between frames (minimum 20ms).
   - **Transparent Background?** turn one of `#FFFFFF`, `#000000`, or
     `#FB9999` into transparent pixels in the GIF.
   - **Loop?** Forever or play once.
   - **Quality** (advanced): palette size, 2–256 colors. Lower = smaller file.
   - **Scale** (advanced): export resolution multiplier.
5. Click **Generate GIF**, preview the result, then **Download Gif**.

## Architecture

```
src/
├─ plugin.ts   # Runs in the Penpot context. Reads the selection, exports
│              # each shape as PNG bytes, and forwards them + settings to
│              # the UI iframe.
├─ main.ts     # Iframe entry. Wires up the form, handles messages, drives
│              # gif.ts, renders the preview and download link.
├─ gif.ts      # Pure UI-side encoding. Decodes PNG → ImageData → quantized
│              # palette frames → GIF blob via gifenc.
├─ types.ts    # Shared message and settings types between plugin and UI.
└─ style.css   # Plugin-specific styles built on top of @penpot/plugin-styles.

public/
├─ manifest.json  # Penpot plugin manifest.
└─ snail.svg      # Plugin icon.
```

### Why the encoding lives in the UI

Penpot exposes `shape.export({ type: "png" })` in the plugin context, but it
does not expose canvas APIs there. The UI iframe is a normal browser context,
so PNG decoding (`createImageBitmap`, `<canvas>`) and GIF encoding both
happen there. The plugin process only orchestrates Penpot reads.

### Encoder

[`gifenc`](https://github.com/mattdesl/gifenc) was chosen for two reasons:

1. It is small, fast, and runs without web workers — workers are awkward to
   ship inside a sandboxed plugin iframe.
2. It exposes per-frame palette, delay, transparent index, and the Netscape
   loop extension, all of which the UI's settings need.

Each frame gets its own quantized palette (up to 256 colors) so frames with
different content do not bleed colors into each other.

## Design choices

- **Canvas size:** the maximum width and height across all selected items
  becomes the GIF canvas. Smaller frames are centered inside it. This was
  picked over "use the first frame's size" because it keeps every frame
  fully visible regardless of selection order.
- **Selection order:** the plugin uses the order returned by
  `penpot.selection`. Penpot does not currently expose the user's click
  order, so this is effectively the document/z-order of the selection.
  Lay out frames left-to-right (or top-to-bottom) and select them in a
  single rubber-band drag for predictable results.
- **Per-frame delay override:** the regex `/:\s*(\d+)\s*ms?\s*$/i` parses
  trailing tokens like `:1000ms` or `:200` from a layer name. Values below
  20ms fall back to the global default.
- **Transparency strategy:** when a transparent color is selected, the UI
  knocks out matching pixels (with a small RGB tolerance to absorb PNG
  compression noise), then quantizes with `rgba4444` so gifenc allocates a
  transparent palette index. The composed canvas is left fully transparent
  outside each frame — i.e. transparent regions are real, not flat color.

## Known limitations

- **Selection order is not click order.** Penpot's plugin API exposes
  `penpot.selection` as a snapshot of the current selection in document
  order, not the order in which items were clicked. If your animation
  frames are not laid out in their intended order on the canvas, reorder
  them in the layers panel first.
- **GIF transparency is binary.** GIF only supports 1-bit alpha, so any
  semi-transparent pixel in the source becomes either fully opaque (its
  RGB color) or fully transparent. The transparent-color picker matches
  on RGB with a ±6 tolerance per channel; antialiased edges against that
  color may show fringing.
- **Per-frame palettes mean larger files.** Each frame ships its own color
  table to keep colors faithful when frames differ. If file size matters
  more than fidelity, lower the **Quality** value to reduce palette size.
- **Frame rendering uses Penpot's PNG export.** Effects, blends, and any
  other rasterization choice Penpot makes flow through to the GIF. Vector
  detail below pixel size will be smoothed by the rasterizer.
- **`shape.export({ type: "png" })` rasterizes only the shape itself.** It
  does not include surrounding context (other layers, board background)
  unless those are part of the same shape/group.
- **Download in iframe.** Penpot's plugin iframe is sandboxed without the
  `allow-downloads` flag, so Chrome silently blocks `<a download>` clicks
  for both `blob:` and `data:` URLs (this is the behaviour described at
  <https://www.chromestatus.com/feature/5706745674465280>). The plugin
  works around this by opening the generated GIF in a new browser tab via
  `window.open(blobUrl, "_blank")` — Penpot's sandbox does grant
  `allow-popups`, so the new tab loads, and the user can save the GIF
  using the browser's native shortcuts (Ctrl/Cmd+S, or right-click → Save
  Image As). As an extra safety net the preview image inside the plugin
  itself is also right-clickable: pick "Save image as…" to save without
  opening a new tab. If popups are also blocked at the browser level the
  plugin surfaces an error message asking the user to use the right-click
  fallback.

## Penpot API observations

- `Shape.export(config)` is the only way to rasterize a shape from the
  plugin side, and it always returns PNG (or JPEG/SVG/PDF) bytes — there
  is no `getImageData`-style API.
- `penpot.ui.sendMessage` round-trips `Uint8Array` payloads correctly via
  `structuredClone`, so PNG bytes can be passed straight to the UI without
  base64 encoding.
- Selection ordering is document-order; click-order is not currently
  exposed (`penpot.selection` is just a `Shape[]`).
- The plugin runs only with `content:read`. No write permission is needed
  because the plugin never mutates the document.

## Scripts

- `npm run dev` — watch build + serve at `http://localhost:4400`.
- `npm run build` — type-check and produce a static bundle in `dist/`.
