import { LinearSRGBColorSpace, MathUtils, Object3D, PerspectiveCamera, Ray, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Metric } from '../data/cmip6';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { createGlobe, globeKit, LIGHT, toXyz } from './globe';
import { softLimit, solveGrab } from './grab';
import type { Viewport } from './types';

const FOV = 30;
export const FILL = 0.78; // share of a cell's shorter side the globe spans at the start
const START = { lon: 15, lat: 12 }; // what faces the camera first
const SPIN = (2 * Math.PI) / 90_000; // radians per millisecond when it spins on its own: a turn in 90 s
const CLICK = 4; // px a press may move and still be a click (which selects the globe) rather than a drag
const MIN_DISTANCE = 1.25; // closest zoom, raised while columns can be higher (update)

// A globe's place on the stage, in CSS px from the stage's top left.
export interface Cell {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Stage 1 of docs/llm/MULTI_GLOBE_PLAN.md: the globes in one row across the area. Stage 2 fits a grid to the count.
const row = (ids: number[], area: Omit<Cell, 'id'>): Cell[] =>
  ids.map((id, i) => ({ id, x: area.x + (i * area.width) / ids.length, y: area.y, width: area.width / ids.length, height: area.height }));

// The globes side by side, one per entry of `globes` in the shared state, each in its cell of one canvas: one
// WebGL context for all of them (a page keeps at most 16), drawn cell by cell with a scissor. The globes turn and
// zoom together (decision D3): drag any of them to rotate (the point grabbed stays under the pointer, a flick
// coasts to a stop), scroll or pinch to zoom; a click without a drag picks the globe (`onPick`, additive with
// Shift, Ctrl or Cmd). The cells fill the area right of `insetLeft` (a side pane) and below `insetTop` (the data
// tree), easing when they change; `onCells` reports them, for labels drawn over the stage. `metrics(node)` gives a
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
    let inset = [initial.insetLeft, initial.insetTop]; // target, in px
    let shown = [...inset]; // current, eased toward the target
    let cells: Cell[] = [];
    const frameCells = () => {
      const [w, h] = [Math.max(width - shown[0], width * 0.4), Math.max(height - shown[1], height * 0.4)];
      cells = row(order, { x: width - w, y: height - h, width: w, height: h });
      onCells(cells);
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
      if (shown[0] !== inset[0] || shown[1] !== inset[1]) {
        shown = shown.map((s, i) => (Math.abs(inset[i] - s) < 0.5 ? inset[i] : s + (inset[i] - s) * 0.25));
        frameCells();
        redraw();
      }
      last = now;
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

    const observer = new ResizeObserver(() => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      [width, height] = [w, h];
      frameCells();
      redraw();
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
          frameCells();
          redraw();
        }
        for (const g of state.globes) globes.get(g.id)!.update(g, state);
        if (state.insetLeft !== inset[0] || state.insetTop !== inset[1]) {
          inset = [state.insetLeft, state.insetTop];
          redraw(); // eases toward it frame by frame
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
