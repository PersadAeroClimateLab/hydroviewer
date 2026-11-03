"""trame server for the C and D viewports: the same month as the three.js flat map and globe.

One layout per view and colormap, chosen by the page URL: /index.html?ui=flat-viridis

The pages assume a fixed shape, which the front end provides by sizing the iframe: 2:1 for the flat
map and square for the globe.
"""

from data import load_month
from scene import COLORMAPS, STOPS, flat_map, globe
from trame.app import get_server
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame.widgets import vtk as vtk_widgets

# Chips mirror src/viewports/overlay.ts: label top left, relief note under it, colour bar bottom left.
CSS = """
  html, body { margin: 0; height: 100%; background: transparent; color-scheme: light dark; }
  .chip { position: absolute; left: 8px; top: 8px; padding: 2px 8px; border-radius: 4px;
          font: 14px system-ui, sans-serif; color: CanvasText; pointer-events: none;
          background: color-mix(in srgb, Canvas 80%, transparent); }
  .note { top: 34px; }
  .colorbar { top: auto; bottom: 8px; font-size: 12px; }
  .colorbar .bar { width: 160px; height: 10px; margin-top: 4px; }
  .colorbar .ticks { display: flex; justify-content: space-between; }
"""
FILL = "position:absolute; inset:0; width:100%; height:100%"

server = get_server(client_type="vue3")
field = load_month(0)
relief = bool(field.uncertainty.any())  # stores prepped before the relief have none

for colormap in COLORMAPS:
    for view, build in (("flat", flat_map), ("globe", globe)):
        with DivLayout(server, template_name=f"{view}-{colormap}"):
            client.Style(CSS)
            vtk_widgets.VtkLocalView(build(field, colormap), style=FILL)
            html.Div(f"pr · {field.label}", classes="chip")
            if relief:
                html.Div("Elevation = uncertainty (dummy data)", classes="chip note")
            with html.Div(classes="chip colorbar"):
                html.Div(classes="bar", style=f"background: linear-gradient(to right, {', '.join(STOPS[colormap])})")
                with html.Div(classes="ticks"):
                    html.Span("0")
                    html.Span(f"{field.vmax:.1f} {field.units}")

if __name__ == "__main__":
    # timeout=0: by default trame shuts itself down when no browser is connected for a while.
    server.start(timeout=0)
