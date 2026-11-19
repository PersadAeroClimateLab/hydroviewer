import { LinearSRGBColorSpace, MathUtils, Object3D, PerspectiveCamera, Ray, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Metric } from '../data/cmip6';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { createGlobe, globeKit, LIGHT, toXyz } from './globe';
import { softLimit, solveGrab } from './grab';
import { layout, type Cell } from './grid';
import type { Viewport } from './types';

export type { Cell };

const FOV = 30;
export const FILL = 0.78; // share of a cell's shorter side the globe spans at the start
const START = { lon: 15, lat: 12 }; // what faces the camera first
const SPIN = (2 * Math.PI) / 90_000; // radians per millisecond when it spins on its own: a turn in 90 s
const CLICK = 4; // px a press may move and still be a click (which selects the globe) rather than a drag
const MIN_DISTANCE = 1.25; // closest zoom, raised while columns can be higher (update)
const GAP = 16; // px between cells: each globe is clipped to its cell, so zoomed in they stay apart
const MOVE = 300; // ms for the cells to move to a new layout, at any frame rate

// The globes side by side, one per entry of `globes` in the shared state, each in its cell of one canvas: one
// WebGL context for all of them (a page keeps at most 16), drawn cell by cell with a scissor. The globes turn and
// zoom together (decision D3): drag any of them to rotate (the point grabbed stays under the pointer, a flick
// coasts to a stop), scroll or pinch to zoom; a click without a drag picks the globe (`onPick`, additive with
// Shift, Ctrl or Cmd). The cells are a grid fitted to their number (`layout()` in grid.ts) in the area the panels
// leave: right of `insetLeft` (the metric pane), below `insetTop` (the tree's chip or open pane), above `insetBottom`
// (the timeline). When the area or the number of globes changes they ease to their new places; `onCells` reports
// them as they move, for labels drawn over the stage. `metrics(node)` gives a
// loaded node's metrics. Draws only while something changes: a frame per input event, frames while a flick or a zoom
// damps out, and every frame while the globes spin on their own (`spin`: eastward, paused while grabbed, after a
// flick has coasted out).
export const globeStage = (
  metrics: (node: string) => Metric[] | undefined,
  onPick: (id: number, additive: boolean) => void,
  onCells: (cells: Cell[]) => void,
): Viewport => ({
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);
    const kit = globeKit(renderer, initial.stippleSize);
    const globes = new Map<number, ReturnType<typeof createGlobe>>();
    let order: number[] = []; // the globes' ids, in the shared state's order

    // One orientation for every globe; the camera stays on +z and the globes turn (see solveGrab).
    const orientation = new Object3D();
    let [yaw, pitch] = [MathUtils.degToRad(-START.lon), MathUtils.degToRad(START.lat)];
    const turn = () => {
      orientation.rotation.set(pitch, yaw, 0, 'XYZ'); // Rx(pitch) * Ry(yaw)
      for (const g of globes.values()) g.earth.quaternion.copy(orientation.quaternion);
    };

    // One camera, aimed at each cell in turn. OrbitControls only zooms (wheel, pinch), so it stays on its axis.
    const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
    camera.position.set(0, 0, 1 / Math.sin(MathUtils.degToRad(FOV / 2)) / FILL);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = 10;
    // The globe fills FILL of the cell's shorter side at the start distance, in portrait cells too.
    const aim = (c: Cell) => {
      camera.aspect = c.width / c.height;
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(FOV / 2)) / Math.min(1, c.width / c.height)));
      camera.updateProjectionMatrix();
    };

    let [width, height] = [1, 1];
    let inset = [initial.insetLeft, initial.insetTop, initial.insetBottom]; // px the panels cover
    let target: Cell[] = []; // where the cells go
    let cells: Cell[] = []; // where they are drawn
    let move: { from: Map<number, Cell>; at: number } | undefined; // a move to `target` under way
    // The grid for the area the panels leave (at least 40% of each side). `snap`: straight there (a resize), else
    // moved over MOVE ms (an inset, or a globe added or removed; new cells appear in place).
    const frameCells = (snap: boolean) => {
      const [w, h] = [Math.max(width - inset[0], width * 0.4), Math.max(height - inset[1] - inset[2], height * 0.4)];
      target = layout(order, { x: width - w, y: Math.max(0, Math.min(inset[1], height - h)), width: w, height: h }, GAP);
      move = snap ? undefined : { from: new Map(cells.map((c) => [c.id, c])), at: performance.now() };
      if (snap) {
        cells = target;
        onCells(cells);
      }
      redraw();
    };
    const ease = (now: number) => {
      if (!move) return;
      const t = Math.min(1, Math.max(0, (now - move.at) / MOVE));
      const k = t * t * (3 - 2 * t); // smoothstep
      const { from } = move;
      const mix = (a: number, b: number) => a + (b - a) * k;
      cells = target.map((c) => {
        const f = from.get(c.id);
        return f ? { id: c.id, x: mix(f.x, c.x), y: mix(f.y, c.y), width: mix(f.width, c.width), height: mix(f.height, c.height) } : c;
      });
      onCells(cells);
      if (t < 1) redraw();
      else move = undefined;
    };

    let frame = 0;
    let last = 0; // time of the previous frame, for the flick and the spin
    let spin = [0, 0]; // yaw and pitch per millisecond after a flick
    let spinning = initial.spin; // turning on their own
    const draw = (now: number) => {
      frame = 0;
      controls.update(); // fires 'change' (and so another frame) while the zoom damps
      const dt = Math.min(now - last, 50);
      if (!grab && (spin[0] || spin[1])) {
        [yaw, pitch] = [yaw + spin[0] * dt, MathUtils.clamp(pitch + spin[1] * dt, -Math.PI / 2, Math.PI / 2)];
        turn();
        const decay = Math.exp(-dt / 250);
        spin = spin.map((v) => (Math.abs(v * decay) < 1e-6 ? 0 : v * decay));
        redraw();
      } else if (!grab && spinning) {
        yaw += SPIN * dt; // the surface moves eastward, as the Earth turns
        turn();
        redraw();
      }
      ease(now);
      last = now;
      render();
    };
    const render = () => {
      kit.uniforms.light.value.copy(LIGHT).applyQuaternion(orientation.quaternion.clone().invert()); // fixed to the view
      renderer.setScissorTest(false);
      renderer.clear(); // also where a cell was before the layout changed
      renderer.setScissorTest(true);
      for (const c of cells) {
        const g = globes.get(c.id);
        if (!g) continue;
        g.prepare();
        const bottom = height - c.y - c.height; // WebGL counts from the bottom
        renderer.setViewport(c.x, bottom, c.width, c.height);
        renderer.setScissor(c.x, bottom, c.width, c.height);
        aim(c);
        renderer.render(g.scene, camera);
      }
    };
    const redraw = () => (frame ||= requestAnimationFrame(draw));
    controls.addEventListener('change', redraw);
    // A picture of the globes for a screenshot: a `capture` event on the canvas, whose detail is called with a PNG
    // data URL. The drawing buffer is only readable in the task that drew it (no preserveDrawingBuffer, which
    // would cost every frame), so it is drawn again here first.
    const capture = (e: Event) => {
      render();
      (e as CustomEvent<(png: string) => void>).detail(renderer.domElement.toDataURL('image/png'));
    };

    // The cell under the pointer, and where the pointer's ray meets the unit sphere there, in view space.
    const canvas = renderer.domElement;
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const cellAt = (e: PointerEvent) => {
      const [x, y] = local(e);
      return cells.find((c) => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height);
    };
    const ray = new Ray();
    const pointerOnSphere = (e: PointerEvent, c: Cell) => {
      const [x, y] = local(e);
      const ndc = new Vector2(((x - c.x) / c.width) * 2 - 1, -((y - c.y) / c.height) * 2 + 1);
      aim(c);
      camera.updateMatrixWorld();
      ray.origin.copy(camera.position);
      ray.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
      const along = -ray.origin.dot(ray.direction); // to the point of the ray nearest the centre
      const near = ray.at(along, new Vector3());
      const hit = near.lengthSq() <= 1;
      if (hit) return { hit, point: ray.at(along - Math.sqrt(1 - near.lengthSq()), near) };
      // Off the globe: the outline point in the pointer's direction, which stays put as the pointer moves out.
      const d = camera.position.length();
      const rim = Math.sqrt(1 - 1 / d ** 2);
      const across = Math.hypot(near.x, near.y) || 1;
      return { hit, point: new Vector3((near.x / across) * rim, (near.y / across) * rim, 1 / d) };
    };

    let grab: { lon: number; lat: number; id: number; t: number; cell: Cell } | undefined;
    let press: { x: number; y: number; id: number; pointer: number } | undefined; // a click, until it moves
    const pointers = new Set<number>();
    const onDown = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      if (pointers.size > 1 || e.button !== 0) return void (grab = press = undefined); // pinch: zoom only
      const cell = cellAt(e);
      if (!cell) return;
      press = { x: e.clientX, y: e.clientY, id: cell.id, pointer: e.pointerId };
      const { hit, point } = pointerOnSphere(e, cell);
      if (!hit) return;
      // Grab the eased point, so a grab near the edge does not jump on the first move.
      const local = softLimit(point, camera.position.length()).applyQuaternion(orientation.quaternion.clone().invert());
      grab = { lon: Math.atan2(local.x, local.z), lat: Math.asin(MathUtils.clamp(local.y, -1, 1)), id: e.pointerId, t: e.timeStamp, cell };
      spin = [0, 0];
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK) press = undefined;
      if (!grab || e.pointerId !== grab.id) {
        const cell = !grab && cellAt(e);
        if (!grab) canvas.style.cursor = cell && pointerOnSphere(e, cell).hit ? 'grab' : '';
        return;
      }
      const target = softLimit(pointerOnSphere(e, grab.cell).point, camera.position.length());
      const [y, p] = solveGrab(grab.lon, grab.lat, target, yaw);
      const dt = Math.max(e.timeStamp - grab.t, 1);
      spin = [(y - yaw) / dt, (p - pitch) / dt];
      [yaw, pitch, grab.t] = [y, p, e.timeStamp];
      turn();
      redraw();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (press?.pointer === e.pointerId) onPick(press.id, e.shiftKey || e.ctrlKey || e.metaKey);
      press = undefined;
      if (!grab || e.pointerId !== grab.id) return;
      if (e.timeStamp - grab.t > 80) spin = [0, 0]; // held still before letting go: no flick
      grab = undefined;
      canvas.style.cursor = 'grab';
      last = performance.now();
      redraw();
    };
    const listening = new AbortController();
    const { signal } = listening;
    canvas.addEventListener('pointerdown', onDown, { signal });
    canvas.addEventListener('pointermove', onMove, { signal });
    canvas.addEventListener('pointerup', onUp, { signal });
    canvas.addEventListener('pointercancel', (e) => ((press = undefined), onUp(e)), { signal });
    canvas.addEventListener('capture', capture, { signal });

    const observer = new ResizeObserver(() => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      [width, height] = [w, h];
      frameCells(true);
    });
    observer.observe(el);

    let alive = true;
    createCoastlines((lon, lat) => toXyz(lon, lat, 1)).then((lines) => {
      if (!alive) return disposeCoastlines(lines);
      lines.material.dispose();
      kit.coast = lines.geometry;
      redraw();
    });

    let scale = -1; // column height, as a fraction of the radius
    const handle = {
      update(state: typeof initial) {
        if (kit.setColormaps(state.colormap, state.columnColormap)) redraw();
        // The globes: new ones made, removed ones dropped.
        const ids = state.globes.map((g) => g.id);
        if (ids.join() !== order.join()) {
          for (const [id, g] of globes) if (!ids.includes(id)) (g.dispose(), globes.delete(id));
          for (const id of ids) if (!globes.has(id)) globes.set(id, createGlobe(kit, metrics, redraw));
          order = ids;
          turn();
          frameCells(false);
        }
        for (const g of state.globes) globes.get(g.id)!.update(g, state);
        if (state.insetLeft !== inset[0] || state.insetTop !== inset[1] || state.insetBottom !== inset[2]) {
          inset = [state.insetLeft, state.insetTop, state.insetBottom];
          frameCells(false);
        }
        if (state.spin !== spinning) {
          spinning = state.spin;
          last = performance.now(); // no jump from the time it stood still
          redraw();
        }
        if (kit.setSpacing(state.stippleSize)) redraw();
        // Column height: a fraction of the radius times an integer multiplier; the closest zoom stays outside the
        // tallest columns (the next frame's controls.update() clamps the camera).
        if (state.columnScale * state.columnMultiplier !== scale) {
          scale = state.columnScale * state.columnMultiplier;
          kit.uniforms.columnScale.value = scale;
          redraw();
        }
        controls.minDistance = Math.max(MIN_DISTANCE, 1.05 + (state.stipple ? scale : 0));
      },
      destroy() {
        alive = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        listening.abort();
        for (const g of globes.values()) g.dispose();
        kit.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    handle.update(initial);
    return handle;
  },
});
