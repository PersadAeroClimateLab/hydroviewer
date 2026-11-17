import { MathUtils, Vector3 } from 'three';

// Grab-to-rotate. The globe turns by yaw (about its axis) then pitch (tilting a pole toward the
// camera), so north stays up. Given a point on the globe (local lon/lat, radians) and where it should
// be in view space (a unit vector, camera on +z), solve for that rotation: yaw puts the point at the
// target's x (pitch leaves x alone), pitch then turns it to the target's y and z. Of the two yaw
// solutions the one nearer `yaw` keeps the drag continuous. Near the poles there may be no exact
// solution; x is clamped and the globe turns as far as it can.
export function solveGrab(lon: number, lat: number, q: Vector3, yaw: number): [number, number] {
  const s = Math.asin(MathUtils.clamp(q.x / Math.max(Math.cos(lat), 1e-6), -1, 1));
  const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  const [a, b] = [wrap(s - lon - yaw), wrap(Math.PI - s - lon - yaw)];
  const turned = lon + yaw + (Math.abs(a) < Math.abs(b) ? a : b); // longitude after yaw
  const pitch = wrap(Math.atan2(q.z, q.y) - Math.atan2(Math.cos(lat) * Math.cos(turned), Math.sin(lat)));
  return [turned - lon, MathUtils.clamp(pitch, -Math.PI / 2, Math.PI / 2)];
}

// Near the visible edge a pixel of pointer travel covers a large angle of the globe (the surface turns away
// from the camera), so pinning the grabbed point to the pointer there spins the globe erratically. This eases
// the target by its distance from the globe's centre on screen, as a fraction of the globe's on-screen radius
// (camera on +z at `distance` from the centre): unchanged up to START, then slower and slower, levelling off
// before LIMIT. Combined with the stretch near the edge, a pointer step there turns the globe less and less,
// and past the edge (the caller passes the outline point) not at all.
const START = 0.3;
const LIMIT = 0.6;
export function softLimit(p: Vector3, distance: number): Vector3 {
  const rim = Math.sqrt(1 - 1 / distance ** 2); // sine of the angle from the centre to the visible edge
  const across = Math.hypot(p.x, p.y);
  const r = Math.min(across / rim, 1);
  if (r <= START || p.z < 0) return p.clone();
  const eased = START + (LIMIT - START) * Math.tanh((r - START) / (LIMIT - START));
  const s = (eased * rim) / across;
  return new Vector3(p.x * s, p.y * s, Math.sqrt(1 - (eased * rim) ** 2));
}
