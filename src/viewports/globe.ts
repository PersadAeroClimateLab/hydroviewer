import {
  Group,
  LinearSRGBColorSpace,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadMonth, loadUncertainty } from '../data/cmip6';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { createFieldLayer, GLOBE_BACKGROUND, RELIEF_SCALE } from './fieldLayer';
import { createColorbar, createOverlay, createReliefNote } from './overlay';
import { reliefAt } from './relief';
import type { Viewport } from './types';

const FOV = 35; // vertical field of view, widened for portrait viewports so the sphere always fits
// Camera distance from the centre: the highest possible peak just fits the frame.
const DISTANCE = (1 + RELIEF_SCALE) / Math.sin(MathUtils.degToRad(FOV / 2));

// The month on a sphere that rises with (dummy) uncertainty, drag to rotate and scroll to zoom.
// Redraws only when something changes.
export const globe: Viewport = {
  name: 'Globe',
  engine: 'three.js',
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.style.background = GLOBE_BACKGROUND; // the canvas is transparent
    el.append(renderer.domElement);
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';
    const colorbar = createColorbar(el, initial.colormap);

    const layer = createFieldLayer(renderer, initial.colormap, true);
    const geometry = new SphereGeometry(1, 288, 180); // one segment per cell of the 180 x 288 grid
    const mesh = new Mesh(geometry, layer.material);
    mesh.visible = false; // until the field arrives
    const world = new Group().add(mesh);
    world.rotation.y = -Math.PI / 2; // longitude 0 faces the camera (it starts at +x)
    const scene = new Scene().add(world);

    const camera = new PerspectiveCamera(FOV, 1, 0.1, 20);
    camera.position.set(0, 0, DISTANCE);

    const render = () => renderer.render(scene, camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 8;
    controls.rotateSpeed = 0.6;
    controls.addEventListener('change', render);

    const resize = () => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      const aspect = w / h;
      camera.aspect = aspect;
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(FOV / 2)) / Math.min(1, aspect)));
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    let alive = true;
    let coast: Awaited<ReturnType<typeof createCoastlines>> | undefined;
    let note: HTMLDivElement | undefined;
    // The globe still draws, flat and without the note, if the uncertainty array is missing.
    loadUncertainty()
      .then(
        (grid) => {
          layer.setRelief(grid);
          if (alive) note = createReliefNote(el);
          render();
          return reliefAt(grid);
        },
        () => () => 0,
      )
      // Same longitude/latitude mapping as SphereGeometry's UVs, just above the displaced surface.
      .then((height) =>
        createCoastlines((lon, lat) => {
          const r = 1.003 + RELIEF_SCALE * height(lon, lat);
          const phi = MathUtils.degToRad(lon + 180);
          const theta = MathUtils.degToRad(90 - lat);
          return [-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta)];
        }),
      )
      .then((lines) => {
        if (!alive) return disposeCoastlines(lines);
        coast = lines;
        world.add(lines);
        render();
      });
    loadMonth(0).then(
      (f) => {
        if (!alive) return;
        const vmax = layer.setField(f);
        overlay.textContent = `pr · ${f.label}`;
        colorbar.setRange(vmax, f.units);
        mesh.visible = true;
        render();
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update(state) {
        layer.setColormap(state.colormap);
        colorbar.setColormap(state.colormap);
        render();
      },
      destroy() {
        alive = false;
        observer.disconnect();
        controls.dispose();
        if (coast) disposeCoastlines(coast);
        layer.dispose();
        geometry.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        overlay.remove();
        colorbar.remove();
        note?.remove();
      },
    };
  },
};
