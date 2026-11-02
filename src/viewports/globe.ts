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
import { loadMonth } from '../data/cmip6';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { createFieldLayer } from './fieldLayer';
import { createOverlay } from './overlay';
import type { Viewport } from './types';

const DISTANCE = 3.6; // camera distance from the centre of the unit sphere
const FOV = 35; // vertical field of view, widened for portrait viewports so the sphere always fits

// The month on a unit sphere, drag to rotate and scroll to zoom. Redraws only when something changes.
export const globe: Viewport = {
  name: 'Globe',
  engine: 'three.js',
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';

    const layer = createFieldLayer(renderer, initial.colormap);
    const geometry = new SphereGeometry(1, 128, 64);
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
    // Same longitude/latitude mapping as SphereGeometry's UVs, just above the surface.
    createCoastlines((lon, lat) => {
      const phi = MathUtils.degToRad(lon + 180);
      const theta = MathUtils.degToRad(90 - lat);
      return [-1.003 * Math.cos(phi) * Math.sin(theta), 1.003 * Math.cos(theta), 1.003 * Math.sin(phi) * Math.sin(theta)];
    }).then((lines) => {
      if (!alive) return disposeCoastlines(lines);
      coast = lines;
      world.add(lines);
      render();
    });
    loadMonth(0).then(
      (f) => {
        if (!alive) return;
        const vmax = layer.setField(f);
        overlay.textContent = `pr · ${f.label} · 0–${vmax.toFixed(1)} ${f.units}`;
        mesh.visible = true;
        render();
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update(state) {
        layer.setColormap(state.colormap);
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
      },
    };
  },
};
