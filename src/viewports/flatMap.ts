import { LinearSRGBColorSpace, Mesh, OrthographicCamera, PlaneGeometry, Scene, WebGLRenderer } from 'three';
import { loadMonth } from '../data/cmip6';
import { createFieldLayer } from './fieldLayer';
import { createOverlay } from './overlay';
import type { Viewport } from './types';

// Flat equirectangular map of one month: a 2:1 plane under an orthographic camera.
export const flatMap: Viewport = {
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';

    const layer = createFieldLayer(renderer, initial.colormap);
    const geometry = new PlaneGeometry(2, 1);
    const mesh = new Mesh(geometry, layer.material);
    mesh.visible = false; // until the field arrives
    const scene = new Scene().add(mesh);
    const camera = new OrthographicCamera(-1, 1, 0.5, -0.5, 0, 1);

    const render = () => renderer.render(scene, camera);

    const resize = () => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (!w || !h) return;
      renderer.setSize(w, h, false); // the canvas is sized by CSS
      const aspect = w / h;
      const halfW = Math.max(1, aspect / 2); // fit the 2 x 1 plane, letterboxed
      const halfH = halfW / aspect;
      Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    let alive = true;
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
