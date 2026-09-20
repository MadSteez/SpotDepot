#!/usr/bin/env python3
"""
Downloads every photo referenced in spots.json to a local images/ folder,
then rewrites spots.json so each spot points at the raw GitHub URL those
files will have once you push them — matching exactly how the app stores
images for spots added through its own UI.

Usage:
    1. Put this script in the same folder as spots.json.
    2. Fill in OWNER / REPO / BRANCH below to match wherever you'll commit
       the images/ folder this script creates (your data repo).
    3. Run:  python3 download_images.py
    4. Commit the resulting images/ folder and the updated spots.json to
       that repo.

No third-party packages needed — just Python 3's standard library.
"""

import json
import os
import time
import urllib.request

# --- fill these in to match the repo you'll push images/ to ---
OWNER = "MadSteez"
REPO = "SpotDepot"
BRANCH = "main"
# ----------------------------------------------------------------

SPOTS_FILE = "spots.json"
IMAGES_DIR = "images"


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp, open(path, "wb") as f:
        f.write(resp.read())


def main():
    with open(SPOTS_FILE, encoding="utf-8") as f:
        spots = json.load(f)

    os.makedirs(IMAGES_DIR, exist_ok=True)
    total = sum(len(s.get("images", [])) for s in spots)
    done = 0
    failed = []

    for spot in spots:
        new_images = []
        for i, url in enumerate(spot.get("images", [])):
            done += 1
            filename = f"{spot['id']}-{i}.jpg"
            path = os.path.join(IMAGES_DIR, filename)
            print(f"[{done}/{total}] {spot['name']!r} photo {i + 1} -> {filename}")
            try:
                download(url, path)
                new_images.append(
                    f"https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/images/{filename}"
                )
            except Exception as e:
                print(f"    FAILED: {e}")
                failed.append((spot["name"], url, str(e)))
            time.sleep(0.2)  # be polite to the server
        spot["images"] = new_images

    with open(SPOTS_FILE, "w", encoding="utf-8") as f:
        json.dump(spots, f, indent=2, ensure_ascii=False)

    ok = total - len(failed)
    print(f"\nDone: {ok}/{total} photos downloaded.")
    if failed:
        with open("failed_downloads.txt", "w", encoding="utf-8") as f:
            for name, url, err in failed:
                f.write(f"{name}\t{url}\t{err}\n")
        print(f"{len(failed)} failed — see failed_downloads.txt (those spots were left with no images, not broken links).")


if __name__ == "__main__":
    main()
