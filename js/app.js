import { createMapController } from "./map.js?v=65";
import * as store from "./store.js?v=65";
import { escapeHtml, showToast, setLoading, uid, foldAccents } from "./utils.js?v=65";

const COMMON_TAGS = [
  "stairs", "gap", "ledge", "outledge", "downledge", "flatrail", "outrail",
  "handrail", "manual pad", "bank", "pyramid", "quarterpipe", "other",
];

// ---------------- state ----------------
let allSpots = [];
let activeTagFilters = new Set();
let textFilters = []; // [{ label, key }] — label is shown as-typed, key is accent/case-folded for matching
let mobileView = "map"; // 'map' | 'list'

let previewItems = []; // { type:'existing', url } | { type:'pending', file, previewUrl }
let editingSpotId = null;
let currentDetailId = null;

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const layoutEl = document.querySelector(".layout");
const spotListEl = $("spotList");
const emptyStateEl = $("emptyState");
const tagChipsEl = $("tagChips");
const clearFiltersBtn = $("clearFiltersBtn");
const resultCountEl = $("resultCount");

const detailModal = $("detailModal");
const formModal = $("formModal");
const settingsModal = $("settingsModal");

const mapCtrl = createMapController("map");

// ============================================================
// Rendering
// ============================================================
function allTags() {
  const set = new Set();
  allSpots.forEach((s) => (s.tags || []).forEach((t) => set.add(t)));
  const known = COMMON_TAGS.filter((t) => set.has(t));
  const unknown = [...set].filter((t) => !COMMON_TAGS.includes(t)).sort();
  return [...known, ...unknown];
}

function matchesTextFilters(s) {
  if (textFilters.length === 0) return true;
  return textFilters.some(
    ({ key }) =>
      foldAccents(s.name.toLowerCase()).includes(key) ||
      foldAccents((s.description || "").toLowerCase()).includes(key) ||
      (s.tags || []).some((t) => foldAccents(t.toLowerCase()).includes(key))
  );
}

function filteredSpots() {
  return allSpots.filter((s) => {
    const matchesTags = activeTagFilters.size === 0 || (s.tags || []).some((t) => activeTagFilters.has(t));
    return matchesTextFilters(s) && matchesTags && spotInPlaceFilter(s);
  });
}

let sortMode = "distance"; // preferred default — falls back to "name" if geolocation isn't available
let sortDirection = 1; // 1 = ascending (nearest/A-Z/oldest first), -1 = reversed
let userLocation = null; // { lat, lng } once geolocation succeeds

function distanceKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function requestUserLocation(onDone) {
  if (!navigator.geolocation) return onDone(false);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      mapCtrl.showUserLocation(userLocation.lat, userLocation.lng);
      onDone(true);
    },
    () => onDone(false),
    { timeout: 8000 }
  );
}

// ---- place-boundary search ("Wilrijk" -> filter to spots inside it) ----
let placeFilters = []; // [{ label, geojson, bbox }, ...]

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInGeoJson(lon, lat, geojson) {
  if (!geojson) return false;
  if (geojson.type === "Polygon") return pointInPolygonRings(lon, lat, geojson.coordinates);
  if (geojson.type === "MultiPolygon") return geojson.coordinates.some((poly) => pointInPolygonRings(lon, lat, poly));
  return false;
}

function pointInBoundingBox(lat, lng, bbox) {
  const [south, north, west, east] = bbox.map(Number);
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

function spotInPlaceFilter(spot) {
  if (placeFilters.length === 0) return true;
  return placeFilters.some((p) => (p.geojson ? pointInGeoJson(spot.lng, spot.lat, p.geojson) : pointInBoundingBox(spot.lat, spot.lng, p.bbox)));
}

const PLACE_LAYERS = ["city", "district", "locality", "county", "state", "country"];
const PLACE_OSM_VALUES = new Set([
  "city", "town", "village", "municipality",
  "suburb", "borough", "quarter", "neighbourhood",
  "county", "state", "region", "province",
  "country", "island",
]);

function isBoundaryPlace(props) {
  if (props.osm_type === "N") return false; // a node is just a point — it can never have a real boundary
  if (props.osm_key === "place" && PLACE_OSM_VALUES.has(props.osm_value)) return true;
  if (props.osm_key === "boundary" && props.osm_value === "administrative") return true;
  return false;
}

const PLACE_TYPE_LABELS = {
  city: "city", town: "town", village: "village", municipality: "municipality",
  suburb: "district", borough: "district", quarter: "district", neighbourhood: "neighbourhood",
  county: "county", state: "state", region: "region", province: "province",
  country: "country", island: "island",
};

function placeTypeLabel(props) {
  if (props.osm_key === "place") return PLACE_TYPE_LABELS[props.osm_value] || props.osm_value;
  if (props.osm_key === "boundary" && props.osm_value === "administrative") return "region";
  return "";
}

function parsePhotonFeatures(data) {
  return (data.features || [])
    .filter((f) => isBoundaryPlace(f.properties || {}))
    .map((f) => {
      const p = f.properties || {};
      const label = [p.name, p.city, p.state, p.country].filter((v, i, arr) => v && arr.indexOf(v) === i).join(", ");
      const [lng, lat] = f.geometry?.coordinates || [];
      return { label, placeType: placeTypeLabel(p), osmType: p.osm_type, osmId: p.osm_id, lat, lng };
    })
    .filter((s) => s.label && s.osmType && s.osmId);
}

async function runPhotonQuery(url) {
  const res = await fetch(url);
  if (!res.ok) return [];
  return parsePhotonFeatures(await res.json());
}

async function fetchPlaceSuggestions(query) {
  const layerParams = PLACE_LAYERS.map((l) => `&layer=${l}`).join("");
  const suggestions = await runPhotonQuery(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10${layerParams}`);
  if (userLocation) {
    // Surface the closest match first rather than trusting raw search relevance.
    suggestions.sort((a, b) => distanceKm(userLocation, a) - distanceKm(userLocation, b));
  }
  return suggestions;
}

const placeGeometryCache = new Map(); // "osmType+osmId" -> place, avoids re-fetching on repeated hover/click

async function fetchPlaceGeometry(osmType, osmId) {
  const key = `${osmType}${osmId}`;
  if (placeGeometryCache.has(key)) return placeGeometryCache.get(key);
  const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=${osmType}${osmId}&format=jsonv2&polygon_geojson=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const results = await res.json();
  if (!results.length) return null;
  const r = results[0];
  const place = { label: r.display_name.split(",")[0], geojson: r.geojson || null, bbox: r.boundingbox };
  placeGeometryCache.set(key, place);
  return place;
}

function renderPlaceChips() {
  $("placeFilterChips").innerHTML = placeFilters
    .map(
      (p) => `
      <button class="chip chip--place" data-place="${escapeHtml(p.label)}">
        <svg class="icon" width="12" height="12"><use href="#icon-pin"/></svg>
        ${escapeHtml(p.label)} ×
      </button>`
    )
    .join("");
  updateActiveFiltersRow();
}

function addPlaceFilter(place) {
  if (placeFilters.some((p) => p.label === place.label)) return false;
  placeFilters.push(place);
  mapCtrl.showPlaceBoundary(place.label, place);
  mapCtrl.fitToPlaceBoundary(place);
  renderPlaceChips();
  render();
  return true;
}

function removePlaceFilter(label) {
  placeFilters = placeFilters.filter((p) => p.label !== label);
  mapCtrl.hidePlaceBoundary(label);
  renderPlaceChips();
  render();
}

function clearPlaceFilters() {
  placeFilters = [];
  mapCtrl.clearPlaceBoundaries();
  renderPlaceChips();
}

function sortSpots(spots) {
  let sorted;
  if (sortMode === "distance" && userLocation) {
    sorted = [...spots].sort((a, b) => distanceKm(userLocation, a) - distanceKm(userLocation, b));
  } else if (sortMode === "name") {
    sorted = [...spots].sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortMode === "created") {
    sorted = [...spots].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  } else if (sortMode === "updated") {
    sorted = [...spots].sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
  } else {
    sorted = [...spots];
  }
  if (sortDirection === -1) sorted.reverse();
  return sorted;
}

function renderTagChips() {
  const tags = allTags();
  tagChipsEl.innerHTML = tags
    .map(
      (t) =>
        `<button class="chip${activeTagFilters.has(t) ? " is-active" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join("");
  updateActiveFiltersRow();
}

function updateActiveFiltersRow() {
  const hasActive = activeTagFilters.size > 0 || textFilters.length > 0 || placeFilters.length > 0;
  clearFiltersBtn.classList.toggle("hidden", !hasActive);
  $("activeFiltersRow").classList.toggle("hidden", !hasActive);
}

function renderTagPills(tags = []) {
  return tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("");
}

function renderList(spots) {
  if (spots.length === 0) {
    spotListEl.innerHTML = "";
    emptyStateEl.classList.remove("hidden");
    emptyStateEl.querySelector("p:last-child").textContent =
      allSpots.length === 0
        ? "Be the first — drop a pin and tell your crew where to roll up."
        : "Nothing matches your search or filters.";
    return;
  }
  emptyStateEl.classList.add("hidden");
  const showDistance = !!userLocation;
  spotListEl.innerHTML = spots
    .map((spot) => {
      const thumb = spot.images && spot.images[0]
        ? `<img class="spot-card__thumb" src="${spot.images[0]}" alt="${escapeHtml(spot.name)}" loading="lazy">`
        : `<div class="spot-card__thumb spot-card__thumb--empty"><svg class="icon" width="28" height="28"><use href="#icon-image"/></svg></div>`;
      const distance = showDistance
        ? `<span class="spot-card__distance">${distanceKm(userLocation, spot).toFixed(1)} km</span>`
        : "";
      return `
        <article class="spot-card" data-id="${spot.id}">
          ${thumb}
          <div class="spot-card__body">
            <h3 class="spot-card__name">${escapeHtml(spot.name)}${distance}</h3>
            <p class="spot-card__desc">${escapeHtml(spot.description || "No description yet.")}</p>
            <div class="spot-card__tags">${renderTagPills(spot.tags)}</div>
          </div>
        </article>`;
    })
    .join("");
}

function renderMarkerPreview(spot) {
  const thumb = spot.images && spot.images[0]
    ? `<img class="marker-preview__thumb" src="${spot.images[0]}" alt="">`
    : `<div class="marker-preview__thumb marker-preview__thumb--empty"><svg class="icon" width="20" height="20"><use href="#icon-image"/></svg></div>`;
  return `${thumb}<div class="marker-preview__name">${escapeHtml(spot.name)}</div>`;
}

function render() {
  const spots = sortSpots(filteredSpots());
  renderTagChips();
  renderList(spots);
  mapCtrl.setSpots(spots, renderMarkerPreview);
  resultCountEl.textContent = `${spots.length} spot${spots.length === 1 ? "" : "s"}`;
}

async function refreshAll({ silent = false } = {}) {
  try {
    if (!silent) setLoading(true, "Loading spots…");
    const { spots, needsSetup } = await store.loadSpots();
    allSpots = spots;
    render();
    if (!silent) setLoading(false);
    if (needsSetup) {
      showToast("This page hasn't been pointed at a repo yet — see js/site-config.js.", { error: true, duration: 4500 });
    }
  } catch (err) {
    console.error(err);
    if (!silent) setLoading(false);
    showToast(err.message || "Couldn't load spots.", { error: true, duration: 5000 });
  }
}

// ============================================================
// Detail modal
// ============================================================
let galleryImages = [];
let galleryIndex = 0;

function renderGalleryFrame(images, index) {
  const multi = images.length > 1;
  return `
    <div class="gallery-frame">
      <img src="${images[index]}" alt="">
      ${multi ? `
        <button type="button" class="gallery-nav gallery-nav--prev" data-nav="prev" aria-label="Previous photo"><svg class="icon" width="18" height="18"><use href="#icon-chevron-left"/></svg></button>
        <button type="button" class="gallery-nav gallery-nav--next" data-nav="next" aria-label="Next photo"><svg class="icon" width="18" height="18"><use href="#icon-chevron-right"/></svg></button>
        <div class="gallery-counter">${index + 1} / ${images.length}</div>
      ` : ""}
      <button type="button" class="gallery-expand" data-open-tab aria-label="Open photo in a new tab"><svg class="icon" width="16" height="16"><use href="#icon-external"/></svg></button>
    </div>`;
}

function renderDetailGallery() {
  const el = $("detailGallery");
  el.innerHTML = galleryImages.length
    ? renderGalleryFrame(galleryImages, galleryIndex)
    : `<div class="detail__gallery--empty">No photos yet</div>`;
}

function stepGallery(dir) {
  if (galleryImages.length < 2) return;
  galleryIndex = (galleryIndex + dir + galleryImages.length) % galleryImages.length;
  renderDetailGallery();
}

function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function openDetailModal(id) {
  const spot = allSpots.find((s) => s.id === id);
  if (!spot) return;
  currentDetailId = id;
  galleryImages = spot.images || [];
  galleryIndex = 0;
  renderDetailGallery();

  const showDistance = !!userLocation;
  const distanceBadge = showDistance
    ? `<span class="spot-card__distance">${distanceKm(userLocation, spot).toFixed(1)} km</span>`
    : "";
  $("detailName").innerHTML = `${escapeHtml(spot.name)}${distanceBadge}`;
  $("detailTags").innerHTML = renderTagPills(spot.tags);
  $("detailDesc").textContent = spot.description || "No description yet.";
  $("detailCoords").textContent = `${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}`;
  const added = formatDate(spot.createdAt);
  const edited = formatDate(spot.updatedAt);
  $("detailDates").textContent = [
    added ? `Added ${added}` : null,
    edited && edited !== added ? `Edited ${edited}` : null,
  ].filter(Boolean).join(" · ");

  detailModal.classList.remove("hidden");
  mapCtrl.map.keyboard.disable();
  history.replaceState(null, "", `${location.pathname}${location.search}#spot=${encodeURIComponent(id)}`);
}

// Clicking a marker's preview popup opens the full detail modal; the popup
// itself stays open underneath (Leaflet doesn't touch it), and clicking
// empty map area closes the popup automatically (Leaflet's default).
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-open-detail]");
  if (el) openDetailModal(el.dataset.spotId);
});

$("detailGallery").addEventListener("click", (e) => {
  const navBtn = e.target.closest("[data-nav]");
  if (navBtn) {
    stepGallery(navBtn.dataset.nav === "prev" ? -1 : 1);
    return;
  }
  if (e.target.closest("[data-open-tab]")) {
    window.open(galleryImages[galleryIndex], "_blank", "noopener");
  }
});

function spotShareUrl(spot) {
  return `${location.origin}${location.pathname}#spot=${encodeURIComponent(spot.id)}`;
}

$("detailShareBtn").addEventListener("click", async () => {
  const spot = allSpots.find((s) => s.id === currentDetailId);
  if (!spot) return;
  const url = spotShareUrl(spot);
  if (navigator.share) {
    try {
      await navigator.share({ title: spot.name, url });
    } catch (_) {
      /* user cancelled the share sheet — nothing to do */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied to clipboard.");
  } catch (_) {
    showToast("Couldn't copy the link — copy it from the address bar instead.", { error: true });
  }
});

$("detailDirectionsBtn").addEventListener("click", () => {
  const spot = allSpots.find((s) => s.id === currentDetailId);
  if (!spot) return;
  // No origin param — Google Maps defaults that to the user's current location.
  const url = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
  window.open(url, "_blank", "noopener");
});

function requireWriteAccess() {
  if (store.canWrite()) return true;
  showToast("Add a token to make changes.", { error: true, duration: 5500 });
  openSettingsModal();
  return false;
}

$("detailEditBtn").addEventListener("click", () => {
  if (!requireWriteAccess()) return;
  const spot = allSpots.find((s) => s.id === currentDetailId);
  closeModal(detailModal);
  if (spot) openFormModal(spot);
});

$("detailDeleteBtn").addEventListener("click", async () => {
  if (!requireWriteAccess()) return;
  const spot = allSpots.find((s) => s.id === currentDetailId);
  if (!spot) return;
  if (!confirm(`Delete "${spot.name}"? This can't be undone.`)) return;
  try {
    setLoading(true, "Deleting…");
    await store.deleteSpot(spot.id);
    setLoading(false);
    closeModal(detailModal);
    await refreshAll({ silent: true });
    showToast("Spot deleted.");
  } catch (err) {
    setLoading(false);
    showToast(err.message || "Couldn't delete spot.", { error: true, duration: 5000 });
  }
});

// ============================================================
// Form modal (add / edit)
// ============================================================
function resetForm() {
  $("spotForm").reset();
  previewItems = [];
  editingSpotId = null;
  $("pickHint").textContent = "";
  renderImagePreviews();
}

function openFormModal(spot = null) {
  resetForm();
  if (spot) {
    editingSpotId = spot.id;
    $("formTitle").textContent = "Edit spot";
    $("fieldName").value = spot.name;
    $("fieldDescription").value = spot.description || "";
    $("fieldLat").value = spot.lat;
    $("fieldLng").value = spot.lng;
    $("fieldTags").value = (spot.tags || []).join(", ");
    previewItems = (spot.images || []).map((url) => ({ type: "existing", url }));
  } else {
    $("formTitle").textContent = "New spot";
  }
  renderTagSuggestions();
  renderImagePreviews();
  formModal.classList.remove("hidden");
}

function renderTagSuggestions() {
  $("tagSuggestions").innerHTML = COMMON_TAGS.map((t) => `<button type="button" class="chip" data-add-tag="${t}">+ ${t}</button>`).join("");
}

$("tagSuggestions").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-add-tag]");
  if (!btn) return;
  const tagField = $("fieldTags");
  const current = tagField.value.split(",").map((t) => t.trim()).filter(Boolean);
  const toAdd = btn.dataset.addTag;
  if (!current.includes(toAdd)) current.push(toAdd);
  tagField.value = current.join(", ");
});

function renderImagePreviews() {
  const el = $("imagePreviews");
  el.innerHTML = previewItems
    .map((item, i) => {
      const src = item.type === "existing" ? item.url : item.previewUrl;
      return `<div class="image-preview" data-idx="${i}">
        <img src="${src}" alt="" draggable="false">
        <button type="button" class="image-preview__remove" data-remove-idx="${i}" aria-label="Remove photo">×</button>
      </div>`;
    })
    .join("");
}

$("imagePreviews").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-idx]");
  if (!btn) return;
  const idx = Number(btn.dataset.removeIdx);
  const [removed] = previewItems.splice(idx, 1);
  if (removed?.type === "pending") URL.revokeObjectURL(removed.previewUrl);
  renderImagePreviews();
});

// Drag to reorder photos — uses Pointer Events (not native HTML5 drag/drop,
// which touch browsers don't support) so this works on phones too.
let dragEl = null;
const imagePreviewsEl = $("imagePreviews");

imagePreviewsEl.addEventListener("pointerdown", (e) => {
  if (e.target.closest("[data-remove-idx]")) return; // don't start a drag from the remove button
  const item = e.target.closest(".image-preview");
  if (!item) return;
  dragEl = item;
  item.setPointerCapture(e.pointerId);
  item.classList.add("is-dragging");
});

imagePreviewsEl.addEventListener("pointermove", (e) => {
  if (!dragEl) return;
  e.preventDefault();
  const overEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".image-preview");
  if (!overEl || overEl === dragEl || overEl.parentElement !== dragEl.parentElement) return;
  const items = [...imagePreviewsEl.children];
  if (items.indexOf(dragEl) < items.indexOf(overEl)) {
    imagePreviewsEl.insertBefore(dragEl, overEl.nextSibling);
  } else {
    imagePreviewsEl.insertBefore(dragEl, overEl);
  }
});

imagePreviewsEl.addEventListener("pointerup", (e) => {
  if (!dragEl) return;
  dragEl.classList.remove("is-dragging");
  dragEl.releasePointerCapture(e.pointerId);
  const newOrder = [...imagePreviewsEl.children].map((el) => Number(el.dataset.idx));
  previewItems = newOrder.map((originalIdx) => previewItems[originalIdx]);
  dragEl = null;
  renderImagePreviews();
});

$("chooseImagesBtn").addEventListener("click", () => $("fieldImages").click());

$("fieldImages").addEventListener("change", (e) => {
  const files = [...e.target.files];
  const remainingSlots = 10 - previewItems.length;
  if (remainingSlots <= 0) {
    showToast("You've already got 10 photos on this spot — remove one first.", { error: true });
    e.target.value = "";
    return;
  }
  files.slice(0, remainingSlots).forEach((file) => {
    previewItems.push({ type: "pending", file, previewUrl: URL.createObjectURL(file) });
  });
  if (files.length > remainingSlots) {
    showToast(`Only added ${remainingSlots} — 10 photos max per spot.`, { error: true });
  }
  e.target.value = "";
  renderImagePreviews();
});

function isMobileLayout() {
  return window.matchMedia("(max-width: 860px)").matches;
}

$("pickOnMapBtn").addEventListener("click", () => {
  const wasMobileView = mobileView;
  formModal.classList.add("hidden");
  if (isMobileLayout()) switchMobileView("map");
  showToast("Tap the map to set this spot's location.");
  mapCtrl.enablePickMode((lat, lng) => {
    $("fieldLat").value = lat.toFixed(6);
    $("fieldLng").value = lng.toFixed(6);
    $("pickHint").textContent = "Location set from the map.";
    mapCtrl.disablePickMode();
    formModal.classList.remove("hidden");
    if (isMobileLayout()) switchMobileView(wasMobileView);
  });
});

$("spotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("fieldName").value.trim();
  const description = $("fieldDescription").value.trim();
  const lat = parseFloat($("fieldLat").value);
  const lng = parseFloat($("fieldLng").value);
  const tags = [...new Set($("fieldTags").value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

  if (!name) return showToast("Give the spot a name.", { error: true });
  if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return showToast("Set a valid location (pick on the map or enter coordinates).", { error: true });
  }
  if (previewItems.length > 10) return showToast("Max 10 photos per spot.", { error: true });

  const keepImageUrls = previewItems.filter((p) => p.type === "existing").map((p) => p.url);
  const newFiles = previewItems.filter((p) => p.type === "pending").map((p) => p.file);
  const spotData = { id: editingSpotId || uid(), name, description, lat, lng, tags };

  const saveBtn = $("saveSpotBtn");
  saveBtn.disabled = true;
  try {
    setLoading(true, newFiles.length ? `Uploading photos (0/${newFiles.length})…` : "Saving…");
    await store.saveSpot(spotData, newFiles, keepImageUrls, (done, total) => {
      setLoading(true, `Uploading photos (${done}/${total})…`);
    });
    setLoading(false);
    closeModal(formModal);
    await refreshAll({ silent: true });
    showToast(editingSpotId ? "Spot updated." : "Spot added.");
  } catch (err) {
    console.error(err);
    setLoading(false);
    showToast(err.message || "Couldn't save spot.", { error: true, duration: 5500 });
  } finally {
    saveBtn.disabled = false;
  }
});

// ============================================================
// Settings modal
// ============================================================
function openSettingsModal() {
  const cfg = store.getConfig();
  const configured = cfg.mode === "github";
  $("repoInfoNote").classList.toggle("hidden", !configured);
  $("notConfiguredNote").classList.toggle("hidden", configured);
  if (configured) {
    $("repoInfoText").textContent = `${cfg.owner}/${cfg.repo}${cfg.branch ? " @ " + cfg.branch : ""}`;
  }
  $("cfgToken").value = cfg.token || "";
  settingsModal.classList.remove("hidden");
}

$("saveSettingsBtn").addEventListener("click", async () => {
  store.saveToken($("cfgToken").value);
  closeModal(settingsModal);
  await refreshAll();
  showToast("Token saved.");
});

// ============================================================
// Generic modal handling
// ============================================================
function closeModal(modalEl) {
  modalEl.classList.add("hidden");
  mapCtrl.disablePickMode();
  mapCtrl.clearTempMarker();
  if (modalEl === detailModal) {
    mapCtrl.map.keyboard.enable();
    if (location.hash.startsWith("#spot=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
}
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", (e) => closeModal(e.target.closest(".modal-overlay")));
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  let mousedownWasOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => {
    mousedownWasOnOverlay = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (mousedownWasOnOverlay && e.target === overlay) closeModal(overlay);
    mousedownWasOnOverlay = false;
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(closeModal);
  }
  if (!detailModal.classList.contains("hidden")) {
    if (e.key === "ArrowLeft") stepGallery(-1);
    if (e.key === "ArrowRight") stepGallery(1);
  }
});

// ============================================================
// Mobile view switching
// ============================================================
function switchMobileView(view) {
  mobileView = view;
  layoutEl.classList.toggle("view-map", view === "map");
  layoutEl.classList.toggle("view-list", view === "list");
  document.querySelectorAll(".mobile-tabs__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  if (view === "map") mapCtrl.invalidateSize();
}
document.querySelectorAll(".mobile-tabs__btn").forEach((btn) => {
  btn.addEventListener("click", () => switchMobileView(btn.dataset.view));
});

// ============================================================
// Top-level wiring
// ============================================================
$("addSpotBtn").addEventListener("click", () => {
  if (requireWriteAccess()) openFormModal();
});
$("locateBtn").addEventListener("click", () => mapCtrl.locate());
$("layersBtn").addEventListener("click", () => {
  const type = mapCtrl.toggleMapType();
  $("layersBtn").classList.toggle("is-active", type === "satellite");
});

let currentSuggestions = [];
let suggestionTimer = null;

function hideSuggestions() {
  $("placeSuggestions").classList.add("hidden");
  $("placeSuggestions").innerHTML = "";
  currentSuggestions = [];
  clearTimeout(hoverPreviewTimer);
  clearTimeout(touchHoldTimer);
  mapCtrl.clearHoverBoundary();
}

function renderSuggestions(query, placeSuggestions) {
  const items = [];
  if (query) items.push({ type: "text", query, label: `Search spot cards for "${query}"` });
  placeSuggestions.forEach((p) => items.push({ type: "place", ...p }));
  currentSuggestions = items;

  const el = $("placeSuggestions");
  if (!items.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML = items
    .map((item, i) => {
      const icon = item.type === "text" ? "icon-search" : "icon-pin";
      const suffix = item.placeType ? ` <span class="place-suggestion__type">(${escapeHtml(item.placeType)})</span>` : "";
      return `<button type="button" class="place-suggestion${item.type === "text" ? " place-suggestion--text" : ""}" data-idx="${i}"><svg class="icon" width="13" height="13"><use href="#${icon}"/></svg> ${escapeHtml(item.label)}${suffix}</button>`;
    })
    .join("");
  el.classList.remove("hidden");
}

function renderTextFilterChips() {
  $("textFilterChips").innerHTML = textFilters
    .map(
      ({ label, key }) => `
      <button type="button" class="chip chip--text" data-text="${escapeHtml(key)}">
        <svg class="icon" width="12" height="12"><use href="#icon-search"/></svg>
        ${escapeHtml(label)} ×
      </button>`
    )
    .join("");
  updateActiveFiltersRow();
}

function addTextFilter(query) {
  const label = query.trim();
  const key = foldAccents(label.toLowerCase());
  if (!key) return;
  if (textFilters.some((f) => f.key === key)) {
    showToast(`"${label}" is already added.`);
    return;
  }
  textFilters.push({ label, key });
  renderTextFilterChips();
  render();
}

function removeTextFilter(key) {
  textFilters = textFilters.filter((f) => f.key !== key);
  renderTextFilterChips();
  render();
}

function selectTextSuggestion(query) {
  hideSuggestions();
  $("searchInput").value = "";
  addTextFilter(query);
}

async function selectPlaceSuggestion(suggestion) {
  hideSuggestions();
  setLoading(true, "Loading boundary…");
  try {
    const place = await fetchPlaceGeometry(suggestion.osmType, suggestion.osmId);
    if (!place) {
      showToast(`Couldn't load a boundary for "${suggestion.label}".`, { error: true });
      return;
    }
    $("searchInput").value = "";
    const added = addPlaceFilter(place);
    showToast(added ? `Showing spots in ${place.label}.` : `${place.label} is already added.`);
  } catch (_) {
    showToast("Couldn't load that place — check your connection and try again.", { error: true });
  } finally {
    setLoading(false);
  }
}

function triggerSuggestions(value) {
  clearTimeout(suggestionTimer);
  if (!value) {
    hideSuggestions();
    return;
  }
  renderSuggestions(value, []); // show the text option immediately; places arrive shortly after
  if (value.length < 2) return; // too short to bother querying
  suggestionTimer = setTimeout(async () => {
    try {
      const places = await fetchPlaceSuggestions(value);
      if ($("searchInput").value.trim() === value) renderSuggestions(value, places);
    } catch (_) {
      if ($("searchInput").value.trim() === value) renderSuggestions(value, []);
    }
  }, 350);
}

$("searchInput").addEventListener("input", (e) => {
  triggerSuggestions(e.target.value.trim());
});

$("searchInput").addEventListener("focus", (e) => {
  const input = e.target;
  setTimeout(() => {
    const len = input.value.length;
    input.setSelectionRange(len, len); // resume typing at the end, not wherever the click landed
  }, 0);
  const value = input.value.trim();
  if (value) triggerSuggestions(value);
});

$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSuggestions();
    return;
  }
  if (e.key === "Enter" && currentSuggestions.length) {
    e.preventDefault();
    const item = currentSuggestions[0];
    if (item.type === "text") selectTextSuggestion(item.query);
    else selectPlaceSuggestion(item);
  }
});

let suppressNextBlurHide = false;

$("searchInput").addEventListener("blur", () => {
  if (suppressNextBlurHide) {
    suppressNextBlurHide = false;
    return;
  }
  setTimeout(hideSuggestions, 150); // delay so a click on a suggestion still registers
});

let outsidePointerStart = null;

document.addEventListener("pointerdown", (e) => {
  if ($("placeSuggestions").classList.contains("hidden")) return;
  if (e.target.closest(".searchbar") || e.target.closest("#placeSuggestions")) return;
  outsidePointerStart = { x: e.clientX, y: e.clientY };
});

document.addEventListener("pointerup", (e) => {
  if (!outsidePointerStart) return;
  const moved = Math.hypot(e.clientX - outsidePointerStart.x, e.clientY - outsidePointerStart.y);
  outsidePointerStart = null;
  if (moved >= 8) return; // a pan/drag, not a tap — leave the suggestions open
  if ($("placeSuggestions").classList.contains("hidden")) return;
  if (e.target.closest(".searchbar") || e.target.closest("#placeSuggestions")) return;
  hideSuggestions();
});

document.addEventListener("pointercancel", () => {
  outsidePointerStart = null;
});

let hoverPreviewTimer = null;

$("placeSuggestions").addEventListener("mouseover", (e) => {
  const btn = e.target.closest("[data-idx]");
  if (!btn || btn.contains(e.relatedTarget)) return; // moving within the same button
  const item = currentSuggestions[Number(btn.dataset.idx)];
  clearTimeout(hoverPreviewTimer);
  if (!item || item.type !== "place") {
    mapCtrl.clearHoverBoundary();
    return;
  }
  hoverPreviewTimer = setTimeout(async () => {
    try {
      const place = await fetchPlaceGeometry(item.osmType, item.osmId);
      if (place) mapCtrl.showHoverBoundary(place);
    } catch (_) {
      /* preview is a nicety — fail silently */
    }
  }, 250);
});

$("placeSuggestions").addEventListener("mouseout", (e) => {
  const btn = e.target.closest("[data-idx]");
  if (!btn || btn.contains(e.relatedTarget)) return;
  clearTimeout(hoverPreviewTimer);
  mapCtrl.clearHoverBoundary();
});

// Touch has no hover, so a long-press stands in for it: hold to preview the
// boundary, then a plain tap confirms the selection. Everything (both the
// preview and the selection) runs through pointer events uniformly, since
// canceling a touch pointerdown suppresses the synthetic mouse-event chain
// a separate mousedown-based handler would otherwise have relied on.
let touchHoldTimer = null;
let touchHoldTriggered = false;

$("placeSuggestions").addEventListener("pointerdown", (e) => {
  const btn = e.target.closest("[data-idx]");
  touchHoldTriggered = false;
  if (!btn) return;
  e.preventDefault(); // keep focus on the search input so the blur-based hide doesn't fire
  if (e.pointerType !== "touch") return;
  const item = currentSuggestions[Number(btn.dataset.idx)];
  if (!item || item.type !== "place") return;
  touchHoldTimer = setTimeout(async () => {
    touchHoldTriggered = true;
    suppressNextBlurHide = true;
    $("searchInput").blur(); // hide the keyboard so the preview underneath is actually visible
    try {
      const place = await fetchPlaceGeometry(item.osmType, item.osmId);
      if (place) mapCtrl.showHoverBoundary(place);
    } catch (_) {
      /* preview is a nicety — fail silently */
    }
  }, 450);
});

$("placeSuggestions").addEventListener("pointerup", (e) => {
  clearTimeout(touchHoldTimer);
  const btn = e.target.closest("[data-idx]");
  if (!btn) return;
  if (e.pointerType === "touch" && touchHoldTriggered) {
    touchHoldTriggered = false; // consume this tap — they just previewed it, tap again (without holding) to confirm
    return;
  }
  const item = currentSuggestions[Number(btn.dataset.idx)];
  if (!item) return;
  if (item.type === "text") selectTextSuggestion(item.query);
  else selectPlaceSuggestion(item);
});

$("placeSuggestions").addEventListener("pointercancel", () => {
  clearTimeout(touchHoldTimer);
});

$("textFilterChips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-text]");
  if (chip) removeTextFilter(chip.dataset.text);
});

$("placeFilterChips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-place]");
  if (chip) removePlaceFilter(chip.dataset.place);
});

tagChipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tag]");
  if (!chip) return;
  const tag = chip.dataset.tag;
  if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
  else activeTagFilters.add(tag);
  render();
});

clearFiltersBtn.addEventListener("click", () => {
  activeTagFilters.clear();
  textFilters = [];
  renderTextFilterChips();
  $("searchInput").value = "";
  clearPlaceFilters();
  render();
});

$("sortSelect").addEventListener("change", (e) => {
  const mode = e.target.value;
  if (mode === "distance" && !userLocation) {
    if (!navigator.geolocation) {
      showToast("Location isn't available in this browser.", { error: true });
      e.target.value = sortMode;
      return;
    }
    setLoading(true, "Finding your location…");
    requestUserLocation((success) => {
      setLoading(false);
      if (!success) {
        showToast("Couldn't get your location — check location permissions.", { error: true });
        e.target.value = sortMode;
        return;
      }
      sortMode = "distance";
      render();
    });
    return;
  }
  sortMode = mode;
  render();
});

$("sortDirectionBtn").addEventListener("click", () => {
  sortDirection *= -1;
  const btn = $("sortDirectionBtn");
  btn.classList.toggle("is-active", sortDirection === -1);
  btn.setAttribute("aria-pressed", sortDirection === -1 ? "true" : "false");
  render();
});

spotListEl.addEventListener("click", (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const id = card.dataset.id;
  mapCtrl.showPreview(id);
  mapCtrl.revealSpot(id);
  if (isMobileLayout()) switchMobileView("map");
});

spotListEl.addEventListener("mouseover", (e) => {
  const card = e.target.closest("[data-id]");
  if (!card || card.contains(e.relatedTarget)) return;
  mapCtrl.hoverPreviewStart(card.dataset.id);
});
spotListEl.addEventListener("mouseout", (e) => {
  const card = e.target.closest("[data-id]");
  if (!card || card.contains(e.relatedTarget)) return;
  mapCtrl.hoverPreviewEnd(card.dataset.id);
});

// Prevent page-level zoom on desktop (Ctrl+wheel, Safari's pinch-gesture
// events) — the map manages its own zoom independently of these.
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());

// ============================================================
// Shared spot links (#spot=<id>)
// ============================================================
function openSharedSpotFromUrl() {
  const match = location.hash.match(/spot=([^&]+)/);
  if (!match) return;
  const spot = allSpots.find((s) => s.id === decodeURIComponent(match[1]));
  if (!spot) return;
  mapCtrl.focusSpot(spot.id);
  mapCtrl.showPreview(spot.id);
  openDetailModal(spot.id);
}

// ============================================================
// Boot
// ============================================================
switchMobileView("map");
refreshAll().then(() => {
  openSharedSpotFromUrl();
  requestUserLocation((success) => {
    if (!success) sortMode = "name";
    $("sortSelect").value = sortMode;
    render();
  });
  const cfg = store.getConfig();
  const alreadySeenTip = localStorage.getItem("spotdepot_seen_tip");
  if (!alreadySeenTip) {
    localStorage.setItem("spotdepot_seen_tip", "1");
    if (cfg.mode === "github" && !cfg.token) {
      showToast("Showing this repo's shared spots. Add a token when you go to add, edit, or delete one.", { duration: 5500 });
    } else if (cfg.mode === "local") {
      showToast("This page hasn't been pointed at a repo yet — see js/site-config.js.", { duration: 5500 });
    }
  }
});
