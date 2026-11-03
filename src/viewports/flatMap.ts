import { LinearSRGBColorSpace, Mesh, OrthographicCamera, PlaneGeometry, Scene, WebGLRenderer } from 'three';
import { loadField, type Source } from '../data/cmip6';
import { DIVERGING } from './colormaps';
import { createCoastlines, disposeCoastlines } from './coastlines';
import { createFieldLayer } from './fieldLayer';
import { createColorbar, createOverlay } from './overlay';
import type { SharedState } from '../state/shared.svelte';
import type { Viewport } from './types';

// Flat equirectangular map of a field: a 2:1 plane under an orthographic camera. A field whose
// colour scale goes below zero is drawn with the diverging palette, whatever the sidebar colormap.
export const flatMap = (source: Source = 'month'): Viewport => ({
  name: 'Flat map',
  engine: 'three.js',
  mount(el, initial) {
    const renderer = new WebGLRenderer({ alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = LinearSRGBColorSpace; // the colormap already holds display colours
    el.append(renderer.domElement);
    const overlay = createOverlay(el);
    overlay.textContent = 'Loading…';
    const colorbar = createColorbar(el, initial.colormap);

    const layer = createFieldLayer(renderer, initial.colormap);
    const geometry = new PlaneGeometry(2, 1);
    const mesh = new Mesh(geometry, layer.material);
    mesh.visible = false; // until the field arrives
    const scene = new Scene().add(mesh);
    const camera = new OrthographicCamera(-1, 1, 0.5, -0.5, 0, 2);
    camera.position.z = 1; // the plane is at z = 0, the coastlines just in front of it

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
    let coast: Awaited<ReturnType<typeof createCoastlines>> | undefined;
    let diverging = false;
    const palette = (c: SharedState['colormap']) => (diverging ? DIVERGING : c);
    // White coastlines vanish in the light middle of the diverging palette.
    const tint = () => coast?.material.color.set(diverging ? 0x333333 : 0xffffff);
    createCoastlines((lon, lat) => [lon / 180, lat / 180, 0.01]).then((lines) => {
      if (!alive) return disposeCoastlines(lines);
      coast = lines;
      tint();
      scene.add(lines);
      render();
    });
    loadField(source).then(
      (f) => {
        if (!alive) return;
        const [vmin, vmax] = layer.setField(f);
        diverging = vmin < 0;
        tint();
        layer.setColormap(palette(initial.colormap));
        colorbar.setColormap(palette(initial.colormap));
        overlay.textContent = f.label;
        colorbar.setRange(vmin, vmax, f.units);
        mesh.visible = true;
        render();
      },
      (e) => alive && (overlay.textContent = `Could not load data: ${e instanceof Error ? e.message : e}`),
    );

    return {
      update(state) {
        layer.setColormap(palette(state.colormap));
        colorbar.setColormap(palette(state.colormap));
        render();
      },
      destroy() {
        alive = false;
        observer.disconnect();
        if (coast) disposeCoastlines(coast);
        layer.dispose();
        geometry.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        overlay.remove();
        colorbar.remove();
      },
    };
  },
});
