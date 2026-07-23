# 3D Highway — Free-Camera Bridge

> 🇬🇧 English · 🇪🇸 Español más abajo

## What this modification does (EN)

This change adds a small, **opt-in** hook inside `camUpdate()` in
[`screen.js`](./screen.js) that lets an external plugin drive the 3D Highway
camera (orbit, height, zoom, tilt, pan) **without forking the renderer**.

The renderer resolves one bridge object per renderer frame:

```js
window.__h3dCamCtl = {
  enabled,     // master switch — when false the renderer auto-frames as usual
  heightMul,   // camera height multiplier
  distMul,     // dolly / zoom multiplier
  yaw,         // orbit around the look target (radians)
  pitch,       // tilt offset (highway K-units)
  panX, panY,  // look-target pan (highway K-units)
  projectionZoom,
  viewOffsetX, viewOffsetY,
  boardAnchor,
  boardAnchorReadout
};
```

**Safety / backward compatibility**
- The bridge object is read **once** (`_freeCam`) and reused for both the
  position and the look-at transforms.
- Each original pose field is validated with `Number.isFinite` and falls back to a safe default
  (`heightMul`/`distMul → 1`, everything else → `0`) before use, so a malformed
  bridge object can **never** feed `NaN` into `cam.position.set` / `cam.lookAt`.
- When the resolved bridge is absent or its `enabled` value is falsy, bridge
  controls are inactive and stock framing remains in control.

The shared `-FOCUS_D * 0.35` look-at Z is computed once (`_lookAtZ`) and reused.

### Optional projection fields

`projectionZoom` is a positive `PerspectiveCamera.zoom` value (`1` is
neutral). `viewOffsetX/Y` are normalized canvas fractions (`0` is neutral);
positive X moves content left and positive Y moves it up.

`boardAnchor` has `enabled`, a finite `requestId`, desired CSS viewport
`clientX/Y`, and a `capture` object containing its own `clientX/Y`,
`projectionZoom`, and `viewOffsetX/Y`. It retains that point on the highway
board plane until the request ID, canvas size, or bridge object changes. Invalid
or unavailable captures fail inactive.

`boardAnchorReadout` is optional caller-owned storage with `active`,
`requestId`, and normalized `viewOffsetDeltaX/Y`. Add active deltas to the
base offsets before releasing the anchor to avoid a snap. The renderer clears
the retained owner's readout when the anchor becomes inactive or ownership
changes.

A valid per-panel `window.__h3dCamCtlPanels[panelIndex]` entry takes precedence
over the global bridge. Do not share anchor or readout objects between panels.

## The plugin that uses this bridge

**Camera Director** — a floating, bilingual (EN/ES) control panel to author,
save and share highway camera views:

➡️ **https://github.com/nimuart/cameradirector_feedback**

Camera Director creates and writes `window.__h3dCamCtl`. The renderer reads that
bridge or a panel-specific `window.__h3dCamCtlPanels[panelIndex]` entry, and
writes only to an optional caller-provided `boardAnchorReadout`. Those bridge
objects are the entire integration surface; the renderer's internals are not
patched.

---

## Qué hace esta modificación (ES)

Este cambio agrega un hook pequeño y **opcional** dentro de `camUpdate()` en
[`screen.js`](./screen.js) que permite que un plugin externo maneje la cámara del
3D Highway (órbita, altura, zoom, inclinación, paneo) **sin tener que forkear el
renderer**.

El renderer resuelve un objeto del puente por cada frame:

```js
window.__h3dCamCtl = {
  enabled,     // interruptor maestro — si es false, el renderer encuadra solo
  heightMul,   // multiplicador de altura
  distMul,     // multiplicador de dolly / zoom
  yaw,         // órbita alrededor del objetivo (radianes)
  pitch,       // inclinación (unidades K del highway)
  panX, panY,  // paneo del objetivo (unidades K del highway)
  projectionZoom,
  viewOffsetX, viewOffsetY,
  boardAnchor,
  boardAnchorReadout
};
```

**Seguridad / compatibilidad**
- El objeto se lee **una sola vez** (`_freeCam`) y se reutiliza para la posición
  y para el look-at.
- Cada campo original de pose se valida con `Number.isFinite` y cae a un default
  seguro (`heightMul`/`distMul → 1`, el resto → `0`), así un objeto mal formado
  **nunca** mete `NaN` en `cam.position.set` / `cam.lookAt`.
- Si el puente resuelto no existe o su valor `enabled` es falsy, los controles
  del puente quedan inactivos y el encuadre original mantiene el control.

### Campos opcionales de proyección

`projectionZoom` es un valor positivo de `PerspectiveCamera.zoom` (`1` es
neutro). `viewOffsetX/Y` son fracciones normalizadas del canvas (`0` es
neutro); X positivo mueve el contenido a la izquierda e Y positivo hacia arriba.

`boardAnchor` contiene `enabled`, un `requestId` finito, `clientX/Y`
deseados en coordenadas CSS del viewport y un objeto `capture` con sus propios
`clientX/Y`, `projectionZoom` y `viewOffsetX/Y`. Retiene ese punto del plano
del tablero hasta que cambia la solicitud, el tamaño del canvas o el objeto del
puente. Las capturas inválidas o no disponibles quedan inactivas.

`boardAnchorReadout` es almacenamiento opcional del caller con `active`,
`requestId` y `viewOffsetDeltaX/Y` normalizados. Suma los deltas activos a
los offsets base antes de soltar el ancla para evitar un salto. El renderer
limpia el readout del dueño retenido cuando el ancla queda inactiva o cambia el
dueño.

Una entrada válida en `window.__h3dCamCtlPanels[panelIndex]` tiene prioridad
sobre el puente global. No compartas objetos de ancla o readout entre paneles.

## El plugin que usa este puente

**Camera Director** — panel flotante y bilingüe (EN/ES) para crear, guardar y
compartir vistas de cámara del highway:

➡️ **https://github.com/nimuart/cameradirector_feedback**

Camera Director crea y escribe `window.__h3dCamCtl`. El renderer lee ese puente
o una entrada específica de panel en `window.__h3dCamCtlPanels[panelIndex]`, y
solo escribe en un `boardAnchorReadout` opcional proporcionado por el caller.
Esos objetos del puente son toda la superficie de integración.
