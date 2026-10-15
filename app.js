import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

// Browsers refuse to build a web worker from a script on another domain. Left to
// itself the FFmpeg library does new Worker(new URL("./worker.js", import.meta.url)),
// and because the library is imported from a CDN that URL is cross-origin, so
// export always failed with "cannot be accessed from origin ...". We point it at
// our own bundled, self-contained worker instead, which is same-origin and loads.
const workerUrl = new URL("ffmpeg-worker.js", location.href).href;

const $ = (id) => document.getElementById(id);
const input = $("photoInput"), list = $("photoList"), durationInput = $("duration");
const qualitySelect = $("quality"), fpsSelect = $("fps");
const preview = $("preview"), ctx = preview.getContext("2d");
let photos = [], selectedIndex = -1, dragIndex = null, ffmpeg = null, outputUrl = null, exporting = false;
let previewImage = null, previewImageIndex = -1;

function seconds() {
  const n = Number(durationInput.value);
  return Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : 5;
}
function fmtTime(s) {
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function frameRate() {
  // Stills have no motion, so a lower rate looks identical but encodes far fewer
  // frames; this is the single biggest lever on export time for a slideshow.
  const n = Number(fpsSelect.value);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 30;
}
function outputSize() {
  // Frame size comes from the largest photo by pixel area, then is capped by the
  // chosen quality. The encoder runs single-threaded in WebAssembly, so its speed
  // depends on frame pixels: 1080p renders many times faster than a 12-48 MP frame
  // while looking the same on any screen. 0 means keep the original size.
  const cap = Number(qualitySelect.value) || 0;
  const biggest = photos.reduce((a,b) => (a.width*a.height >= b.width*b.height ? a : b));
  let w = biggest.width, h = biggest.height;
  if (cap > 0) {
    const scale = Math.min(1, cap / Math.max(w, h));
    w = Math.max(2, Math.round(w * scale));
    h = Math.max(2, Math.round(h * scale));
  }
  return { W: w + (w % 2), H: h + (h % 2) };
}
function updateSummary() {
  const total = photos.reduce((sum, p) => sum + (p.duration || seconds()), 0);
  $("durationSummary").textContent = `Total duration: ${total ? `${total} seconds (${fmtTime(total)})` : "0 seconds"}`;
  $("totalDuration").textContent = total ? `${total} seconds (${fmtTime(total)})` : "0 seconds";
  $("photoCount").textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"} selected`;
  $("generateBtn").disabled = !photos.length || exporting;
  $("clearBtn").disabled = !photos.length || exporting;
  $("prevBtn").disabled = photos.length < 2 || selectedIndex <= 0;
  $("nextBtn").disabled = photos.length < 2 || selectedIndex >= photos.length - 1;
  $("previewIndex").textContent = photos.length ? `${selectedIndex + 1} / ${photos.length}` : "0 / 0";
  if (photos.length) {
    const { W, H } = outputSize();
    $("resolutionLabel").textContent = `${W} × ${H}`;
  } else $("resolutionLabel").textContent = "Based on largest photo";
}
function paintPreview(p, source, sw, sh) {
  const scale = Math.min(preview.width/p.width, preview.height/p.height);
  const w = p.width*scale, h = p.height*scale;
  ctx.drawImage(source, 0, 0, sw, sh, (preview.width-w)/2, (preview.height-h)/2, w, h);
}
function drawPreview() {
  ctx.fillStyle = "#03070d"; ctx.fillRect(0,0,preview.width,preview.height);
  if (selectedIndex < 0 || !photos[selectedIndex]) {
    ctx.fillStyle = "#a8bad0"; ctx.font = "18px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Add photos to preview your slideshow", preview.width/2, preview.height/2); return;
  }
  const p = photos[selectedIndex];
  if (previewImageIndex === selectedIndex && previewImage) {
    paintPreview(p, previewImage, previewImage.width, previewImage.height);
    return;
  }
  // Decode just the selected photo, at roughly preview size, and keep only that one.
  const index = selectedIndex;
  const img = new Image();
  previewImage = img;
  previewImageIndex = index;
  // Paint only if this is still the image we are waiting for, so a slow decode
  // cannot overwrite a newer selection.
  img.onload = () => {
    if (previewImage === img && previewImageIndex === index) {
      paintPreview(p, img, img.naturalWidth, img.naturalHeight);
    }
  };
  img.src = p.url;
}
function renderList() {
  list.replaceChildren();
  if (!photos.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    empty.textContent = "Your selected photos will appear here."; list.append(empty);
  } else photos.forEach((p, i) => {
    const card = document.createElement("div"); card.className = "photo-card" + (i === selectedIndex ? " selected" : "");
    card.draggable = !exporting; card.dataset.index = i;
    const img = document.createElement("img"); img.src = p.thumbUrl; img.alt = p.name;
    const num = document.createElement("span"); num.className = "photo-number"; num.textContent = i + 1;
    const remove = document.createElement("button"); remove.className = "remove-photo"; remove.type = "button"; remove.textContent = "×"; remove.title = "Remove photo";
    remove.addEventListener("click", e => { e.stopPropagation(); removePhoto(i); });
    const name = document.createElement("div"); name.className = "photo-name"; name.textContent = p.name; name.title = p.name;
    const durationWrap = document.createElement("label"); durationWrap.className = "photo-duration";
    const durationLabel = document.createElement("span"); durationLabel.textContent = "Seconds";
    const durationField = document.createElement("input"); durationField.type = "number"; durationField.min = "1"; durationField.max = "120"; durationField.step = "0.5"; durationField.value = p.duration || seconds(); durationField.setAttribute("aria-label", `Duration for ${p.name}`);
    durationField.addEventListener("click", e => e.stopPropagation());
    durationField.addEventListener("change", e => {
      e.stopPropagation();
      const value = Number(durationField.value);
      if (!Number.isFinite(value) || value < 1 || value > 120) { durationField.value = p.duration || seconds(); return; }
      p.duration = value; updateSummary();
    });
    durationWrap.append(durationLabel, durationField);
    card.append(img,num,remove,name,durationWrap);
    card.addEventListener("click", () => { selectedIndex = i; renderList(); drawPreview(); updateSummary(); });
    card.addEventListener("dragstart", e => { dragIndex = i; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    card.addEventListener("dragend", () => { dragIndex = null; card.classList.remove("dragging"); });
    card.addEventListener("dragover", e => e.preventDefault());
    card.addEventListener("drop", e => {
      e.preventDefault(); const target = i;
      if (dragIndex === null || dragIndex === target) return;
      const moved = photos.splice(dragIndex,1)[0]; photos.splice(target,0,moved);
      if (selectedIndex === dragIndex) selectedIndex = target;
      else if (dragIndex < selectedIndex && target >= selectedIndex) selectedIndex--;
      else if (dragIndex > selectedIndex && target <= selectedIndex) selectedIndex++;
      renderList(); drawPreview(); updateSummary();
    });
    list.append(card);
  });
  updateSummary();
}
function makeThumbnail(image) {
  // A small copy for the list, so a big album does not keep every full-size photo
  // decoded in memory (which is what starves the encoder of memory).
  const max = 240;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(image, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}
function addFiles(files) {
  const candidates = [...files].filter(f => f.type.startsWith("image/"));
  if (!candidates.length) return setStatus("No supported images found. Choose JPG, PNG, WebP, or another browser-readable image.",0,"Waiting for photos");
  let pending = candidates.length;
  for (const file of candidates) {
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => {
      image.onload = image.onerror = null;   // detach first: clearing src re-fires error
      const thumbUrl = makeThumbnail(image);
      const width = image.naturalWidth, height = image.naturalHeight;
      image.src = "";   // release the full-size decode straight away
      photos.push({file,url,thumbUrl,name:file.name,width,height,duration:seconds()});
      pending--;
      if (selectedIndex < 0) selectedIndex = 0;
      if (pending === 0) { renderList(); drawPreview(); setStatus(`${photos.length} photo(s) ready to export.`,0,"Ready"); }
    };
    image.onerror = () => { URL.revokeObjectURL(url); pending--; if (pending===0) {renderList();drawPreview();} };
    image.src = url;
  }
}
function removePhoto(i) {
  if (exporting) return;
  URL.revokeObjectURL(photos[i].url); photos.splice(i,1);
  previewImage = null; previewImageIndex = -1;
  if (!photos.length) selectedIndex = -1;
  else if (selectedIndex >= photos.length) selectedIndex = photos.length-1;
  else if (i < selectedIndex) selectedIndex--;
  renderList(); drawPreview();
}
function setStatus(message, percent=0, detail="") {
  $("statusText").textContent = message;
  $("progressBar").style.width = `${Math.max(0,Math.min(100,percent))}%`;
  $("progressLabel").textContent = `${Math.round(percent)}%`;
  $("progressDetail").textContent = detail;
}
async function loadEncoder() {
  if (ffmpeg) return ffmpeg;
  setStatus("Loading video encoder. This may take a little while on the first export…",2,"Loading FFmpeg");
  const instance = new FFmpeg();
  instance.on("progress", ({progress}) => {
    if (exporting) setStatus("Encoding MP4…", 25 + Math.max(0,Math.min(1,progress))*70, "Encoding video");
  });
  instance.on("log", ({message}) => console.debug("[FFmpeg]", message));
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
  try {
    await instance.load({
      classWorkerURL: workerUrl,
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm")
    });
  } catch (err) {
    // Don't cache a half-initialised instance: a broken FFmpeg would make every
    // later attempt fail with "ffmpeg is not loaded, call await ffmpeg.load() first".
    try { instance.terminate(); } catch {}
    throw new Error(`Could not start the video encoder (${err?.message || err}). Check your internet connection and try again.`);
  }
  ffmpeg = instance;
  return ffmpeg;
}
async function renderFrame(photo, W, H) {
  // Scale and letterbox the photo here, in the browser, and hand ffmpeg only the
  // finished frame. ffmpeg.wasm decoding the full-size originals inside its own
  // heap is what caused "memory access out of bounds".
  const scale = Math.min(W / photo.width, H / photo.height);
  const dw = Math.max(1, Math.round(photo.width * scale));
  const dh = Math.max(1, Math.round(photo.height * scale));
  let bmp;
  try {
    // Decode at (at most) the frame size so a huge photo is never fully expanded.
    bmp = await createImageBitmap(photo.file, { resizeWidth: dw, resizeHeight: dh, resizeQuality: "high" });
  } catch {
    bmp = await createImageBitmap(photo.file);
  }
  try {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    g.drawImage(bmp, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    if (bmp && bmp.close) bmp.close();
  }
}
async function generateVideo() {
  if (!photos.length || exporting) return;
  exporting = true; $("downloadLink").hidden = true; $("generateBtn").disabled = true;
  $("generateBtn").textContent = "Rendering…"; $("clearBtn").disabled = true;
  try {
    const enc = await loadEncoder();
    // Frame size from the largest photo, capped by the chosen quality.
    const { W, H } = outputSize();
    $("resolutionLabel").textContent = `${W} × ${H}`;
    // Every photo is scaled and letterboxed in the browser first, so ffmpeg only
    // ever sees small, already-correct-size images. Encoding still runs in batches
    // with the encoder rebuilt between them, which keeps its memory flat no matter
    // how large the album is.
    const total = photos.length;
    const CHUNK = 12;
    const parts = [];
    for (let start = 0; start < total; start += CHUNK) {
      const slice = photos.slice(start, start + CHUNK);
      const enc = await loadEncoder();
      const norm = [];
      for (let j = 0; j < slice.length; j++) {
        const i = start + j, p = slice[j];
        setStatus(`Preparing photo ${i+1} of ${total}…`, 2 + (i / total) * 18, `Photo ${i+1}/${total}`);
        const name = `norm_${String(i).padStart(4,"0")}.jpg`;
        await enc.writeFile(name, await renderFrame(p, W, H));
        norm.push({ filename: name, duration: p.duration || seconds() });
      }
      setStatus("Encoding MP4…", 20 + ((start + slice.length) / total) * 72, `Encoding part ${parts.length + 1}`);
      let concat = "";
      for (const item of norm) concat += `file '${item.filename}'\nduration ${item.duration}\n`;
      concat += `file '${norm[norm.length-1].filename}'\n`;
      await enc.writeFile("photos.txt", new TextEncoder().encode(concat));
      const partDuration = norm.reduce((sum, item) => sum + item.duration, 0);
      const partName = `part_${parts.length}.mp4`;
      await enc.exec(["-y","-f","concat","-safe","0","-i","photos.txt","-vf",`fps=${frameRate()},format=yuv420p`,"-vsync","vfr","-c:v","libx264","-preset","ultrafast","-crf","18","-movflags","+faststart","-t",String(partDuration),partName]);
      parts.push(new Uint8Array(await enc.readFile(partName)));
      try { ffmpeg.terminate(); } catch {}
      ffmpeg = null;
    }
    setStatus("Preparing your download…",94,"Joining video");
    let data;
    if (parts.length === 1) {
      data = parts[0];
    } else {
      const enc = await loadEncoder();
      for (let i = 0; i < parts.length; i++) await enc.writeFile(`part_${i}.mp4`, parts[i]);
      let list = "";
      for (let i = 0; i < parts.length; i++) list += `file 'part_${i}.mp4'\n`;
      await enc.writeFile("parts.txt", new TextEncoder().encode(list));
      await enc.exec(["-y","-f","concat","-safe","0","-i","parts.txt","-c","copy","-movflags","+faststart","output.mp4"]);
      data = new Uint8Array(await enc.readFile("output.mp4"));
    }
    const blob = new Blob([data.buffer], {type:"video/mp4"});
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);
    $("downloadLink").href = outputUrl;
    $("downloadLink").download = `photo-slideshow-${new Date().toISOString().slice(0,10)}.mp4`;
    $("downloadLink").hidden = false;
    setStatus("Your slideshow is ready. Click Download MP4 to save it.",100,`${(blob.size/1024/1024).toFixed(1)} MB`);
  } catch (err) {
    console.error(err);
    try { if (ffmpeg) { ffmpeg.terminate(); ffmpeg = null; } } catch {}
    setStatus(`Export failed: ${err?.message || err}. Try again, or lower the Quality or Frame rate setting.`,0,"Export error");
  } finally {
    exporting = false; $("generateBtn").disabled = !photos.length; $("generateBtn").textContent = "⚙ Generate MP4";
    $("clearBtn").disabled = !photos.length; renderList();
  }
}
input.addEventListener("change", e => { addFiles(e.target.files); input.value = ""; });
durationInput.addEventListener("input", () => { if (Number(durationInput.value) > 0) updateSummary(); });
qualitySelect.addEventListener("change", () => { if (photos.length) updateSummary(); });
$("applyDurationBtn").addEventListener("click", () => {
  const value = Number(durationInput.value);
  if (!Number.isFinite(value) || value < 1 || value > 120) { setStatus("Duration must be between 1 and 120 seconds.",0,"Invalid duration"); return; }
  photos.forEach(p => p.duration = value);
  renderList(); setStatus(`Set all ${photos.length} photo durations to ${value} second(s).`,0,"Durations updated");
});
$("prevBtn").addEventListener("click", () => { if (selectedIndex>0) {selectedIndex--;renderList();drawPreview();} });
$("nextBtn").addEventListener("click", () => { if (selectedIndex<photos.length-1) {selectedIndex++;renderList();drawPreview();} });
$("clearBtn").addEventListener("click", () => { if (exporting) return; photos.forEach(p=>URL.revokeObjectURL(p.url));photos=[];selectedIndex=-1;previewImage=null;previewImageIndex=-1;renderList();drawPreview();setStatus("Add photos to begin.",0,"No export started");$("downloadLink").hidden=true; });
$("generateBtn").addEventListener("click", generateVideo);
const dz = $("dropzone");
dz.addEventListener("dragover", e=>{e.preventDefault();dz.classList.add("dragover");});
dz.addEventListener("dragleave", ()=>dz.classList.remove("dragover"));
dz.addEventListener("drop", e=>{e.preventDefault();dz.classList.remove("dragover");addFiles(e.dataTransfer.files);});
drawPreview(); updateSummary();
