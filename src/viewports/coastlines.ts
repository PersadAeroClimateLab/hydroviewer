import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three';
import { loadCoastlines } from '../data/coastlines';

// Coastline overlay as line segments. `project` places a longitude/latitude (degrees) in the
// viewport's own space.
export async function createCoastlines(
  project: (lon: number, lat: number) => [number, number, number],
): Promise<LineSegments<BufferGeometry, LineBasicMaterial>> {
  const positions: number[] = [];
  for (const line of await loadCoastlines()) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      positions.push(...project(line[i], line[i + 1]), ...project(line[i + 2], line[i + 3]));
    }
  }
  const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
  return new LineSegments(geometry, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
}

export function disposeCoastlines(lines: LineSegments<BufferGeometry, LineBasicMaterial>) {
  lines.geometry.dispose();
  lines.material.dispose();
}
