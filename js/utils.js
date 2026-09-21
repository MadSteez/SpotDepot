// ---- small shared helpers ----

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Strips accents/diacritics so search matching treats "e" the same as "é", "è", "ë", etc.
export function foldAccents(str = "") {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// UTF-8 safe base64 encode/decode (for JSON text committed to GitHub)
export function utf8ToB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
export function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

// Read a File as a raw base64 string (no data: prefix) — used for image uploads
export function fileToRawBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Resize + compress an image file client-side via canvas, returns a Blob (JPEG).
// Defaults are intentionally close to lossless (most phone photos are already
// at or below 4000px on their long edge, and JPEG quality 0.95 has no
// perceptible loss) — this step exists mainly so every photo, regardless of
// source format (e.g. HEIC from iPhones) or EXIF orientation, ends up as a
// normal, correctly-oriented JPEG every browser can display, not to shrink
// files. Raise maxDim/quality further, or skip this entirely and upload
// files as-is, if that normalization isn't a concern for your group.
export function compressImage(file, maxDim = 4000, quality = 0.95) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export function blobToRawBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---- toast ----
let toastTimer = null;
export function showToast(message, { error = false, duration = 3200 } = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", !!error);
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), duration);
}

// ---- loading veil ----
export function setLoading(isLoading, text = "Syncing…") {
  const veil = document.getElementById("loadingVeil");
  const label = document.getElementById("loadingText");
  if (!veil) return;
  if (label) label.textContent = text;
  veil.classList.toggle("hidden", !isLoading);
}

export function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
