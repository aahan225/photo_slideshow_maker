PHOTO SLIDESHOW MAKER — SETUP

What it does
- Select multiple photos (JPG, PNG, WebP, BMP and other browser-readable image formats).
- Drag thumbnails to reorder them.
- Remove individual photos or clear the list.
- Set a default duration for new photos, and edit each thumbnail's duration independently. Use Apply to all photos to set a uniform duration.
- Preview photos and export an MP4 (H.264, 30 FPS).
- Output frame size is based on the largest selected photo by pixel area. Other photos are fitted inside that frame without stretching; black bars may appear where aspect ratios differ.
- Export runs locally in the browser. The FFmpeg engine core is fetched from jsDelivr on the first export.

Quick start (Mac, Windows, Linux)
1. Extract this ZIP to a folder.
2. Open index.html in a current browser. For the most reliable module loading, use a local server:
   - Install Python 3 if needed.
   - Open Terminal (Mac) or Command Prompt/PowerShell (Windows) in this folder.
   - Run: python3 -m http.server 8000
     On Windows, if python3 is not recognised, try: py -m http.server 8000
3. Open http://localhost:8000 in your browser.
4. Click Choose photos and select several pictures, or drag photos onto the drop area.
5. Drag thumbnails to reorder them. Click a thumbnail to preview it.
6. Set the default duration, then edit the Seconds field on each thumbnail (minimum 1 second; halves such as 2.5 are supported). Use Apply to all photos for a uniform duration.
7. Click Generate MP4. The first export downloads the FFmpeg core from a CDN and may take time.
8. Click Download MP4 when the export completes.

Important notes
- Internet is required on the first export because the FFmpeg WebAssembly core is loaded from a CDN. Photos themselves are processed on your device and are not uploaded by this app.
- MP4 generation can use substantial memory, especially with very large photos or many photos. If a browser tab runs out of memory, export fewer photos at a time or use smaller source images.
- The app uses the largest photo's pixel dimensions as the target frame, rounded up to even numbers required by H.264. It does not upscale each image independently to create new detail; smaller images are fitted into the common frame.
- H.264 is lossy compression. CRF 18 is set for high quality, but it is not mathematically lossless.
- Each photo can have its own duration. The default duration applies to newly added photos; Apply to all photos overwrites every selected photo's duration.
- This is a static slideshow: no transitions or motion effects.

Files
- index.html — interface
- styles.css — styling
- app.js — photo handling and FFmpeg MP4 export
- ffmpeg-worker.js — the FFmpeg web worker (must sit next to app.js; do not rename or delete)
- README.txt — instructions

Why ffmpeg-worker.js exists (do not delete it)
Browsers refuse to create a web worker from a script hosted on another domain. The FFmpeg library builds its worker with
    new Worker(new URL("./worker.js", import.meta.url))
and import.meta.url points at wherever the library was imported from. When the library was imported straight from a CDN, that
URL was cross-origin and the browser blocked it, so export always failed. app.js therefore points the library at ffmpeg-worker.js,
a small bundled copy of that worker kept inside your own project, so it is same-origin and loads. The large engine core
(ffmpeg-core.js / ffmpeg-core.wasm, about 31 MB) is still fetched from the CDN on first export, so it is not stored in your
repository.

Troubleshooting
- If the page looks blank, run the local server and visit http://localhost:8000 instead of opening the file directly.
- If export fails, check internet access, use Chrome/Edge/Firefox/Safari updated to a recent version, and try a smaller batch.
- If you see a CDN error, try again later; the engine core is downloaded from jsDelivr.
- Keep ffmpeg-worker.js in the same folder as app.js; moving or renaming it will break export.

Optional: fully offline export
If you want the app to work with no internet at all, download these two files into the same folder:
  https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js
  https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm
Then, in app.js, change the line that sets the core base URL from the jsDelivr address to "./" (or leave it as-is if you keep the
files on the CDN). Keep the file names unchanged.
