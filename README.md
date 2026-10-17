# wifi-speed-customlayer

A [MapLibre GL JS](https://maplibre.org/) custom layer that shows crowd-sourced Wi-Fi speed spots from [wifi.pancake-trail.site](https://wifi.pancake-trail.site/).

- **One `addLayer` call.** It implements `CustomLayerInterface`; the layers, sources, popup and controls are managed internally and cleaned up in `onRemove`.
- **No API key.** Registering and deleting spots is handed off to wifi.pancake-trail.site (a link is opened in a new tab). Nothing is ever posted from your page.
- **MapLibre-style UI.** Register / Delete buttons look like MapLibre's own control group and can be placed in any corner.
- **English / Japanese UI.**
- **Defensive by design.** Remote data is validated and rebuilt, popups use `textContent` only, requests are size-capped, concurrency-limited and abortable, and the hand-off link goes to a fixed origin with validated numeric parameters only.

Zoom levels below 11 show clusters (spot counts); from zoom 11 individual spots are shown, colored by speed. The switch point is fixed.

## Example

- [Live demo](https://pantredeveloper.github.io/wifi-speed-customlayer/script/wifi-speed-customlayer-example.html) (GitHub Pages) – zoom in to level 11 or higher, click the map to place a pin, and try the language and button-position switches.
- [Source of the demo](https://github.com/pantredeveloper/wifi-speed-customlayer/blob/main/script/wifi-speed-customlayer-example.html)

## Install

### CDN (unpkg)

```html
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css">
<script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/wifi-speed-customlayer@1.0.2/dist/wifi-speed-customlayer.min.js"></script>
```

Pin an exact version in production (`@1.0.2`). `https://unpkg.com/wifi-speed-customlayer` always resolves to the latest minified build.

### npm

```sh
npm install wifi-speed-customlayer maplibre-gl
```

```js
import maplibregl from 'maplibre-gl';
import WifiSpeedLayer from 'wifi-speed-customlayer';

map.on('load', () => {
  map.addLayer(new WifiSpeedLayer({ maplibregl }));
});
```

The package is a UMD build (script tag, CommonJS, AMD, and bundlers). Native `import` straight from a URL in the browser is not supported; use the script tag for that. Pass `maplibregl` in the options when it is not available as a global.

## Usage

```js
const map = new maplibregl.Map({ container: 'map', style: 'https://example.com/style.json' });

map.on('load', () => {
  map.addLayer(new WifiSpeedLayer({
    language: 'auto',            // 'auto' | 'en' | 'ja'
    controlPosition: 'top-right' // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  }));
});
```

Add the layer **after the map's `load` event**. A working demo is linked in [Example](#example).

Cluster counts use the `glyphs` of your style. The font stack of an existing symbol layer in the style is reused; if the style has no `glyphs`, only the cluster circles are drawn.

## Options

| Option | Default | Description |
|---|---|---|
| `id` | `'wifi-speed'` | Layer id: starts with a letter, then letters, digits, `_`, `-` (max 64 chars); anything else falls back to the default. Internal layers/sources are prefixed with it. |
| `controlPosition` | `'top-right'` | Where the Register / Delete buttons go. |
| `language` | `'auto'` | `'auto'` follows `navigator.languages`. Also sent to the website as `ptw_lang`. |
| `showRegister` | `true` | `false` hides the Register button **and** stops placing the green pin when the map is clicked. |
| `showDelete` | `true` | Show the Delete button when a spot is selected. |
| `clusterRadius` | `60` | Cluster radius in px (10–200). |
| `speedRange` | `[0, 50]` | Mbps range of the color ramp. |
| `colors` | `['#0000FF', '#FF0000']` | `[slow, fast]` colors. |
| `refreshInterval` | `0` | Auto-refresh in ms (`0` = off; any other value is raised to at least `30000`). |
| `refreshOnFocus` | `true` | Reload when the tab becomes visible again (e.g. after registering). |
| `beforeId` | – | Insert the internal layers below this layer. The layer must already exist when this layer is added; otherwise the internal layers go on top. |
| `maplibregl` | global | The MapLibre namespace, if not global. |
| `meshBaseUrl`, `clusterUrl` | official data | Data sources. `https:` only (`http:` allowed for localhost). |

Methods: `refresh()`, `setLanguage(lang)`, `clearSelection()`. Remove with `map.removeLayer(id)`.

## How registering and deleting work

1. **Register:** click the map at zoom 11 or higher to drop a green pin, then press the Register button.
2. **Delete:** click an existing spot to open its popup, then press the Delete button.

The button opens `https://wifi.pancake-trail.site/` in a new tab (`noopener,noreferrer`). Speed measurement, naming and confirmation happen there. The query parameters are:

| Action | Parameters |
|---|---|
| Register | `ptw_action=register`, `ptw_lat`, `ptw_lng`, `ptw_zoom`, `ptw_lang` |
| Delete | `ptw_action=delete`, `ptw_id`, `ptw_lat`, `ptw_lng`, `ptw_zoom`, `ptw_lang` |

No free text (such as a place name) is ever put in the URL.

## Data and privacy

The layer reads static JSON from `wifi.pancake-trail.site` (CORS-enabled, requested without credentials or referrer). Your page does not send any user data to the site until the user follows the hand-off link.

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) – public domain dedication.
