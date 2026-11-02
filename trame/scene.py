"""VTK scenes matching the three.js viewports (src/viewports/flatMap.ts and globe.ts).

Nothing is rendered on the server: the scenes are serialized to the browser, where vtk.js draws them.
"""

import json
from pathlib import Path

import numpy as np
from data import Field
from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray
from vtkmodules.vtkCommonCore import vtkLookupTable, vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData, vtkStructuredGrid
from vtkmodules.vtkFiltersGeometry import vtkGeometryFilter
from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper, vtkRenderer
from vtkmodules.vtkRenderingOpenGL2 import vtkGenericOpenGLRenderWindow  # no X11, unlike vtkRenderWindow

ASSETS = Path("/assets")  # ./src/assets, mounted read-only
STOPS: dict[str, list[str]] = json.loads((ASSETS / "colormaps.json").read_text())
COLORMAPS = list(STOPS)
COASTLINES: list[list[float]] = json.loads((ASSETS / "coastlines.json").read_text())

LUT_SIZE = 256

# How far a full-uncertainty point rises above the unit sphere, and the headlight shading that
# makes it readable. Mirrors RELIEF_SCALE and AMBIENT in src/viewports/fieldLayer.ts.
GLOBE_BACKGROUND = (0xC9 / 255, 0xCE / 255, 0xD4 / 255)  # GLOBE_BACKGROUND in fieldLayer.ts: the page is opaque
RELIEF_SCALE = 0.2
FLAT_RELIEF = RELIEF_SCALE * 90  # height of the flat map at full uncertainty, in degrees (half the map height)
AMBIENT = 0.45


def lookup_table(colormap: str, vmax: float) -> vtkLookupTable:
    stops = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for h in STOPS[colormap]], dtype=float)
    t = np.linspace(0, 1, LUT_SIZE) * (len(stops) - 1)
    lo = np.minimum(t.astype(int), len(stops) - 2)
    colors = stops[lo] + (stops[lo + 1] - stops[lo]) * (t - lo)[:, None]
    lut = vtkLookupTable()
    lut.SetNumberOfTableValues(LUT_SIZE)
    for i, (r, g, b) in enumerate(colors / 255):
        lut.SetTableValue(i, r, g, b, 1.0)
    lut.SetRange(0, vmax)
    return lut


def pad(field: Field, v: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Extend a cell-centred (lat, lon) grid to exactly -180..180 and -90..90, as the browser's texture does.

    Longitude is periodic, so the edge columns interpolate between the last and the first column;
    latitude repeats the edge rows.
    """
    lon, lat = field.lon, field.lat
    w = (180 - lon[-1]) / (lon[0] + 360 - lon[-1])
    seam = v[:, -1] + (v[:, 0] - v[:, -1]) * w
    v = np.column_stack([seam, v, seam])
    v = np.vstack([v[:1], v, v[-1:]])
    return np.r_[-180.0, lon, 180.0], np.r_[-90.0, lat, 90.0], v


def sample(v: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear value of a cell-centred global grid at lon/lat; longitude wraps, latitude clamps.

    The same interpolation the browser's GPU applies to the relief texture.
    """
    h, w = v.shape
    x = (lon + 180) / 360 * w - 0.5
    y = np.clip((lat + 90) / 180 * h - 0.5, 0, h - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    y1 = np.minimum(y0 + 1, h - 1)
    x0, x1 = x0 % w, (x0 + 1) % w
    return (
        v[y0, x0] * (1 - fx) * (1 - fy) + v[y0, x1] * fx * (1 - fy) + v[y1, x0] * (1 - fx) * fy + v[y1, x1] * fx * fy
    )


def surface(xyz: np.ndarray, values: np.ndarray) -> vtkPolyData:
    """A coloured surface from an (nlat, nlon, 3) grid of points and (nlat, nlon) values."""
    nlat, nlon = values.shape
    points = vtkPoints()
    points.SetData(numpy_to_vtk(xyz.reshape(-1, 3).astype(np.float32), deep=True))
    grid = vtkStructuredGrid()
    grid.SetDimensions(nlon, nlat, 1)
    grid.SetPoints(points)
    scalars = numpy_to_vtk(values.ravel().astype(np.float32), deep=True)
    scalars.SetName("pr")
    grid.GetPointData().SetScalars(scalars)
    geometry = vtkGeometryFilter()
    geometry.SetInputData(grid)
    geometry.Update()
    return geometry.GetOutput()


def coastlines(project) -> vtkPolyData:
    """Polylines from the app's coastline asset; `project(lon, lat)` returns an (n, 3) array."""
    lonlat = np.concatenate([np.array(line).reshape(-1, 2) for line in COASTLINES])
    offsets = np.cumsum([0] + [len(line) // 2 for line in COASTLINES])
    cells = vtkCellArray()
    cells.SetData(
        numpy_to_vtkIdTypeArray(offsets.astype(np.int64), deep=True),
        numpy_to_vtkIdTypeArray(np.arange(len(lonlat), dtype=np.int64), deep=True),
    )
    points = vtkPoints()
    points.SetData(numpy_to_vtk(project(lonlat[:, 0], lonlat[:, 1]).astype(np.float32), deep=True))
    out = vtkPolyData()
    out.SetPoints(points)
    out.SetLines(cells)
    return out


def actor(data: vtkPolyData, lut: vtkLookupTable | None = None, lit: bool = False) -> vtkActor:
    mapper = vtkPolyDataMapper()
    mapper.SetInputData(data)
    if lut:
        mapper.SetLookupTable(lut)
        mapper.SetScalarRange(*lut.GetRange())
        mapper.SelectColorArray("pr")
        mapper.InterpolateScalarsBeforeMappingOn()  # colour per pixel from the value, like the shader
    else:
        mapper.ScalarVisibilityOff()
    a = vtkActor()
    a.SetMapper(mapper)
    prop = a.GetProperty()
    if lit:  # headlight shading: the browser derives normals from the surface
        prop.SetAmbient(AMBIENT)
        prop.SetDiffuse(1 - AMBIENT)
        prop.SetSpecular(0.0)
    else:
        prop.SetLighting(False)
        prop.SetAmbient(1.0)
        prop.SetDiffuse(0.0)
    if not lut:  # coastlines
        prop.SetColor(1.0, 1.0, 1.0)
        prop.SetOpacity(0.75)
        prop.SetLineWidth(1.0)
    return a


def window(*actors: vtkActor, background=None) -> tuple[vtkGenericOpenGLRenderWindow, vtkRenderer]:
    renderer = vtkRenderer()
    renderer.SetBackground(*(background or (1.0, 1.0, 1.0)))
    renderer.SetBackgroundAlpha(1.0 if background else 0.0)
    for a in actors:
        renderer.AddActor(a)
    win = vtkGenericOpenGLRenderWindow()
    win.AddRenderer(renderer)
    return win, renderer


def flat_map(field: Field, colormap: str) -> vtkGenericOpenGLRenderWindow:
    lon, lat, v = pad(field, field.values)
    _, _, height = pad(field, field.uncertainty)
    lon_g, lat_g = np.meshgrid(lon, lat)
    xyz = np.dstack([lon_g, lat_g, FLAT_RELIEF * height])
    # Coastlines sit just above the relief.
    lines = coastlines(lambda lo, la: np.column_stack([lo, la, FLAT_RELIEF * sample(field.uncertainty, lo, la) + 1.0]))
    win, renderer = window(actor(surface(xyz, v), lookup_table(colormap, field.vmax), lit=True), actor(lines))
    # The page is shown at 2:1 (the front end sizes the iframe), and the browser-side renderer
    # ignores parallel projection. A flat plane facing a perspective camera is just a uniform
    # scale, so fit the 180 degree height at the default 30 degree view angle.
    camera = renderer.GetActiveCamera()
    camera.SetViewAngle(30)
    camera.SetPosition(0, 0, 90 / np.tan(np.radians(15)))
    camera.SetFocalPoint(0, 0, 0)
    camera.SetViewUp(0, 1, 0)
    return win


def unit_sphere(lon, lat, radius=1.0) -> np.ndarray:
    phi, theta = np.radians(lon), np.radians(lat)
    return np.asarray(radius)[..., None] * np.stack([np.cos(theta) * np.cos(phi), np.cos(theta) * np.sin(phi), np.sin(theta)], axis=-1)


def globe(field: Field, colormap: str) -> vtkGenericOpenGLRenderWindow:
    lon, lat, v = pad(field, field.values)
    _, _, height = pad(field, field.uncertainty)
    lon_g, lat_g = np.meshgrid(lon, lat)
    # The surface rises with uncertainty; coastlines sit just above it.
    lines = coastlines(lambda lo, la: unit_sphere(lo, la, 1.003 + RELIEF_SCALE * sample(field.uncertainty, lo, la)))
    relief = surface(unit_sphere(lon_g, lat_g, 1 + RELIEF_SCALE * height), v)
    win, renderer = window(
        actor(relief, lookup_table(colormap, field.vmax), lit=True), actor(lines), background=GLOBE_BACKGROUND
    )
    camera = renderer.GetActiveCamera()
    # Shown in a square. The browser-side renderer keeps its default 30 degree view angle, so the
    # distance sets the fit: the highest possible peak just fits the frame, like the three.js globe.
    camera.SetViewAngle(30)
    camera.SetPosition((1 + RELIEF_SCALE) / np.sin(np.radians(15)), 0, 0)  # longitude 0 faces the camera
    camera.SetFocalPoint(0, 0, 0)
    camera.SetViewUp(0, 0, 1)  # north up
    return win
