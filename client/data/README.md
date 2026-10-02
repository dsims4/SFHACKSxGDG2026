# Globe geography

Country and land boundaries come from `world-atlas@2.0.2` (`countries-110m.json`),
which distributes Natural Earth 1:110m data as TopoJSON. D3 draws these features
into a canvas texture; Three.js wraps that texture around the globe.

`demo-cities.json` contains only name, country, coordinates, and location level for
22 places extracted from Natural Earth's `ne_110m_populated_places.geojson`:
https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_populated_places.geojson

Natural Earth data is public domain:
https://www.naturalearthdata.com/about/terms-of-use/

The sample counts and topic assignments are illustrative, generated deterministically
in `client/globe-data.mjs`. They are not news observations. The demo is labeled in
the interface and used only when selected or when the latest-story API is unavailable.
A successful response with no stories displays an empty state, not sample data.

Live coordinates and topics come from the application's `entries` table. Its RSS
ingestion infers locations from place names mentioned in article text, so they may
not identify the event site. Country-level coordinates remain country-level labels.

All geography and browser dependencies are included in `public/js/globe.bundle.js`.
The browser makes only the local `/api/globe` request; there are no Google Maps,
Google Earth, tile, geocoding, or CDN requests. No connections are drawn between
locations because the story data does not establish relationships between them.
