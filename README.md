# CalGEM Well Explorer

A lightweight web GIS portfolio project built on the California Department of Conservation's public CalGEM WellSTAR ArcGIS REST well layer.

## Current scope — Version 2

The project intentionally focuses on making the core well map faster and easier to use before adding larger analytics features.

### Map behavior

- Interactive statewide well map
- Well-status symbols designed to be distinguishable by both shape and color
- Clustering at regional scales for smoother navigation
- Automatic switch to individual well symbols when zoomed in
- Click any well to view core well information

### Search

Search the live WellSTAR layer by:

- API number
- Well designation / well number
- Operator
- Field
- Lease

Selecting a result smoothly zooms to the well and opens its popup.

### Status filters

Toggle these groups on and off without reloading the page:

- Active
- Idle
- Permitted (`WellStatus = New`)
- Plugged (`Plugged` and `PluggedOnly`)
- Canceled
- Other / uncategorized

The filters change only the visualization. CalGEM's original `WellStatus` value remains visible in the popup.

## Popup fields

- API number
- Well status
- Well type
- Operator
- Field
- County
- Spud date
- Latitude / longitude

## Data source

CalGEM WellSTAR wells layer:

https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0

The application queries the public service directly. It does not scrape, copy, or alter CalGEM data.

## Run locally

From this repository folder:

```bash
python3 -m http.server 8000
```

Then open:

http://localhost:8000

## Project philosophy

Build a better core map first. Filters, dashboards, regulatory analysis, and additional WellSTAR layers should be added only after the search/zoom/filter experience is reliable.
