# GpxSuite

A browser-based GPX editor for creating, importing, editing, and printing GPS tracks. Runs entirely as a static web application with no build step required.

## Features

**Track editing**
- Import GPX files (parsed in a background Web Worker for large files)
- Create tracks and segments by clicking on the map
- Snap-to-road routing via BRouter and OSRM (foot, bike, motorcycle, car profiles)
- Cut segments at any point
- Delete points within a user-defined rectangular area
- Undo history for all destructive operations
- Export tracks to GPX (with iterative Douglas-Peucker simplification)

**Waypoints**
- Add, name, describe, and reposition waypoints per track
- Toggle visibility at track or individual level
- Drag-and-drop repositioning on the map

**Map and visualization**
- 2D raster map and 3D terrain mode (MapLibre GL JS + Nextzen Terrarium DEM)
- Multiple base map styles
- Elevation profile and track statistics (distance, ascent, descent, speed) via Chart.js
- Waymarked Trails hiking overlay
- Mapillary street-level imagery integration (requires personal API token)
- Place search via Nominatim

**Off-road analysis**
- Compares track points against OSM road network via Overpass API
- Extracts off-road segments into a new track

**Print planning**
- Draggable A4 grid overlay on the map
- Configurable rows, columns, scale, and orientation (portrait/landscape)
- High-resolution canvas capture and multi-page print output via CSS print rules

**Device dashboard**
- Overlays live GPS data (compass, altitude, speed, accuracy, coordinates) on the map
- Per-widget position, size, and visual style (essential, contrast, glass)

**Local storage**
- Tracks persisted in IndexedDB; session state in localStorage
- Local library for saving and restoring named tracks

**Authentication (optional)**
- Supabase-based login with password, magic link, and password reset
- Device registration and approval workflow
- Admin dashboard for managing users and devices

## Requirements

- A modern web browser (Chrome, Firefox, Safari, or Edge)
- Python 3 (or any static file server) for local development
- A Supabase project if authentication is enabled

No package manager, bundler, or build tool is needed to run the application.

## Running locally

```bash
git clone https://github.com/OneScore98/GpxSuite.git
cd GpxSuite
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

On macOS you can also double-click `avvia.command`, which starts the server and opens the browser automatically.

## Authentication setup

Authentication is disabled by default. To enable it, open `src/js/auth-config.js` and set your Supabase project credentials:

```js
export const AUTH_REQUIRED = true;
export const SUPABASE_URL = "https://your-project.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "your-anon-key";
export const ADMIN_USERS_FUNCTION_URL = "https://your-project.supabase.co/functions/v1/gpxsuite-admin-users";
```

The database schema and migrations are in the `supabase/` directory. Deploy the Edge Function with the Supabase CLI:

```bash
supabase functions deploy gpxsuite-admin-users
```

Never put the Supabase service role key in the frontend.

## Project structure

```
GpxSuite/
  index.html                  Main HTML entry point
  avvia.command               macOS convenience launcher
  favicon.svg
  src/
    css/
      style.css               Custom styles, responsive rules, print CSS
    js/
      state.js                Global state and setters
      main.js                 Application bootstrap and MapLibre initialization
      map.js                  Map layers, LOD cache, 3D terrain, Mapillary
      tracks.js               Track editing, snap-to-road, undo, cut, box delete
      waypoints.js            Waypoint layers and editor
      gpx.js                  GPX import and export
      stats.js                Elevation profile and statistics (Chart.js)
      print.js                Print planning and A4 canvas capture
      ui.js                   GIS tree, panels, events, off-road analysis
      storage.js              IndexedDB and localStorage persistence
      auth.js                 Supabase authentication and admin dashboard
      auth-config.js          Public Supabase configuration
      utils.js                Shared utilities
      workers/
        gpx-parser.worker.js  Background GPX parsing
  supabase/
    schema.sql                Database schema, RPCs, and RLS policies
    migrations/               SQL migration files
    functions/
      gpxsuite-admin-users/   Edge Function for user creation
```

## Technology stack

| Component | Library / Service |
|---|---|
| Map rendering | MapLibre GL JS 3.6.2 |
| Terrain and elevation | Nextzen Terrarium DEM |
| Elevation profile | Chart.js |
| GIS calculations | Turf.js |
| UI utilities | Tailwind CSS (CDN), Lucide Icons |
| Routing | BRouter, OSRM |
| Place search | Nominatim / OpenStreetMap |
| Off-road analysis | Overpass API |
| Street imagery | Mapillary JS 4.1.2 |
| Authentication | Supabase JS 2 |

All frontend dependencies are loaded via CDN. There are no local `node_modules` and no build pipeline.

## License

No license has been declared for this project. All rights reserved by the author unless otherwise stated.
