import { MathUtils, type Vector3 } from 'three';

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
