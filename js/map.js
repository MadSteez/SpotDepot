/* global L */

// Covers Antwerp, Brussels, and Limburg comfortably — the default view
// before any spots (or a filtered view) narrow it down further.
const DEFAULT_BOUNDS = [
  [50.62, 3.85],
  [51.42, 6.05],
];

export function createMapController(mapElId) {
  const mapEl = document.getElementById(mapElId);
  const map = L.map(mapElId, { zoomControl: false });

  L.control.zoom({ position: "bottomleft" }).addTo(map);

  const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
  });
  streetLayer.addTo(map);
  let mapType = "street";

  function toggleMapType() {
    if (mapType === "street") {
      map.removeLayer(streetLayer);
      satelliteLayer.addTo(map);
      mapType = "satellite";
    } else {
      map.removeLayer(satelliteLayer);
      streetLayer.addTo(map);
      mapType = "street";
    }
    return mapType;
  }

  function showDefaultView() {
    map.fitBounds(DEFAULT_BOUNDS, { animate: false });
  }
  // Apply immediately (correct on desktop, where the container has real
  // size right away) and again shortly after invalidating size, in case
  // the container started at zero size (e.g. a hidden mobile pane).
  showDefaultView();
  setTimeout(() => {
    map.invalidateSize();
    showDefaultView();
  }, 100);

  const markers = new Map(); // spotId -> L.Marker
  let pickCallback = null;
  let tempMarker = null;

  function pinIcon(temp = false) {
    return L.divIcon({
      className: "",
      html: `<div class="spot-pin${temp ? " is-temp" : ""}"><div class="spot-pin__mark"></div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 31],
    });
  }

  // ---- custom marker preview (below the marker, anchored at its tip) ----
  // Leaflet's built-in Popup always grows upward from its anchor point, so
  // to place a preview below the marker instead, we manage a plain
  // positioned element ourselves and keep it in sync with the map.
  //
  // Two layers of state: a "pinned" preview (from clicking a marker or a
  // list item — persists until an empty-map click) and a temporary "hover"
  // preview (from hovering a list item). Starting a hover dismisses
  // whatever was pinned for good — ending the hover just hides the preview
  // rather than bringing the old one back.
  const PREVIEW_GAP = 10; // px reserved above the box for the connecting triangle
  const spotsById = new Map();
  let renderPreviewHtmlFn = null;
  let previewEl = null;
  let pinnedId = null;
  let hoverId = null;

  function ensurePreviewEl() {
    if (previewEl) return previewEl;
    previewEl = document.createElement("div");
    previewEl.className = "marker-preview hidden";
    previewEl.setAttribute("data-open-detail", "");
    previewEl.innerHTML = `<div class="marker-preview__content"></div>`;
    mapEl.appendChild(previewEl);
    return previewEl;
  }

  function activePreviewId() {
    return hoverId !== null ? hoverId : pinnedId;
  }

  function positionPreview() {
    const id = activePreviewId();
    if (!previewEl || id === null) return;
    const marker = markers.get(id);
    if (!marker) return;
    const point = map.latLngToContainerPoint(marker.getLatLng());
    previewEl.style.left = `${point.x}px`;
    previewEl.style.top = `${point.y + PREVIEW_GAP}px`;
  }

  function refreshPreviewDisplay() {
    const id = activePreviewId();
    const el = ensurePreviewEl();
    const spot = id !== null ? spotsById.get(id) : null;
    if (!spot || !markers.has(id)) {
      el.classList.add("hidden");
      return;
    }
    el.querySelector(".marker-preview__content").innerHTML = renderPreviewHtmlFn(spot);
    el.dataset.spotId = id;
    el.classList.remove("hidden");
    positionPreview();
  }

  function showPreview(id) {
    pinnedId = id;
    hoverId = null; // clicking always takes precedence over any lingering hover
    refreshPreviewDisplay();
  }

  function hoverPreviewStart(id) {
    pinnedId = null; // hovering dismisses whatever was open, for good — not just while hovering
    hoverId = id;
    refreshPreviewDisplay();
  }

  function hoverPreviewEnd(id) {
    if (hoverId === id) hoverId = null; // ignore a stale leave from a fast hover switch
    refreshPreviewDisplay(); // nothing pinned anymore, so this simply hides
  }

  function hidePreview() {
    pinnedId = null;
    hoverId = null;
    refreshPreviewDisplay();
  }

  map.on("move zoom", positionPreview);

  function setSpots(spots, renderPreviewHtml) {
    renderPreviewHtmlFn = renderPreviewHtml;
    markers.forEach((m) => map.removeLayer(m));
    markers.clear();
    spotsById.clear();
    spots.forEach((spot) => {
      if (typeof spot.lat !== "number" || typeof spot.lng !== "number") return;
      spotsById.set(spot.id, spot);
      const marker = L.marker([spot.lat, spot.lng], { icon: pinIcon() });
      marker.on("click", () => showPreview(spot.id));
      marker.addTo(map);
      markers.set(spot.id, marker);
    });
    // Markers get fully recreated above (e.g. after a filter change) — keep
    // whatever was pinned open in its new position if it still exists.
    refreshPreviewDisplay();
  }

  function focusSpot(id) {
    const m = markers.get(id);
    if (!m) return;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 17), { animate: true });
  }

  function revealSpot(id) {
    const m = markers.get(id);
    if (!m) return;
    if (!map.getBounds().contains(m.getLatLng())) focusSpot(id);
  }

  function enablePickMode(onPick) {
    mapEl.style.cursor = "crosshair";
    pickCallback = onPick;
  }
  function disablePickMode() {
    mapEl.style.cursor = "";
    pickCallback = null;
  }
  function clearTempMarker() {
    if (tempMarker) {
      map.removeLayer(tempMarker);
      tempMarker = null;
    }
  }
  function placeTempMarker(lat, lng) {
    clearTempMarker();
    tempMarker = L.marker([lat, lng], { icon: pinIcon(true) }).addTo(map);
  }

  map.on("click", (e) => {
    if (pickCallback) {
      const { lat, lng } = e.latlng;
      placeTempMarker(lat, lng);
      pickCallback(lat, lng);
      return;
    }
    if (e.originalEvent.target.closest(".marker-preview")) return;
    hidePreview();
  });

  const placeLayers = new Map(); // label -> L.Layer

  function showPlaceBoundary(label, place) {
    let layer;
    if (place.geojson) {
      layer = L.geoJSON(place.geojson, {
        interactive: false,
        style: { color: "#FFC83D", weight: 2, fillColor: "#FFC83D", fillOpacity: 0.15 },
      });
    } else if (place.bbox) {
      const [south, north, west, east] = place.bbox.map(Number);
      layer = L.rectangle([[south, west], [north, east]], {
        interactive: false,
        color: "#FFC83D", weight: 2, fillColor: "#FFC83D", fillOpacity: 0.15,
      });
    } else {
      return;
    }
    layer.addTo(map);
    placeLayers.set(label, layer);
  }

  function hidePlaceBoundary(label) {
    const layer = placeLayers.get(label);
    if (layer) {
      map.removeLayer(layer);
      placeLayers.delete(label);
    }
  }

  function clearPlaceBoundaries() {
    placeLayers.forEach((layer) => map.removeLayer(layer));
    placeLayers.clear();
  }

  let hoverBoundaryLayer = null;

  function showHoverBoundary(place) {
    clearHoverBoundary();
    const style = { color: "#2F5D9C", weight: 2, dashArray: "5 4", fillColor: "#2F5D9C", fillOpacity: 0.1, interactive: false };
    if (place.geojson) {
      hoverBoundaryLayer = L.geoJSON(place.geojson, { style });
    } else if (place.bbox) {
      const [south, north, west, east] = place.bbox.map(Number);
      hoverBoundaryLayer = L.rectangle([[south, west], [north, east]], style);
    } else {
      return;
    }
    hoverBoundaryLayer.addTo(map);
  }

  function clearHoverBoundary() {
    if (hoverBoundaryLayer) {
      map.removeLayer(hoverBoundaryLayer);
      hoverBoundaryLayer = null;
    }
  }

  function fitToPlaceBoundary(place) {
    let bounds;
    if (place.geojson) {
      bounds = L.geoJSON(place.geojson).getBounds();
    } else if (place.bbox) {
      const [south, north, west, east] = place.bbox.map(Number);
      bounds = L.latLngBounds([south, west], [north, east]);
    }
    if (bounds && bounds.isValid() && !map.getBounds().intersects(bounds)) {
      map.fitBounds(bounds.pad(0.1));
    }
  }

  let userLocationMarker = null;

  function showUserLocation(lat, lng) {
    const latlng = [lat, lng];
    if (userLocationMarker) {
      userLocationMarker.setLatLng(latlng);
      return;
    }
    userLocationMarker = L.marker(latlng, {
      icon: L.divIcon({ className: "", html: `<div class="user-location-dot"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
      zIndexOffset: -1000, // keep it below spot pins if they overlap
    }).addTo(map);
  }

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14, { animate: true });
        showUserLocation(pos.coords.latitude, pos.coords.longitude);
      },
      () => {},
      { timeout: 8000 }
    );
  }

  function invalidateSize() {
    setTimeout(() => map.invalidateSize(), 60);
  }

  return {
    map,
    setSpots,
    focusSpot,
    revealSpot,
    showPreview,
    hidePreview,
    hoverPreviewStart,
    hoverPreviewEnd,
    enablePickMode,
    disablePickMode,
    clearTempMarker,
    placeTempMarker,
    locate,
    showUserLocation,
    showPlaceBoundary,
    hidePlaceBoundary,
    clearPlaceBoundaries,
    fitToPlaceBoundary,
    showHoverBoundary,
    clearHoverBoundary,
    invalidateSize,
    toggleMapType,
  };
}
