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
const preview = $("preview"), ctx = preview.getContext("2d");
let photos = [], selectedIndex = -1, dragIndex = null, ffmpeg = null, outputUrl = null, exporting = false;

function seconds() {
  const n = Number(durationInput.value);
  return Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : 5;
}
function fmtTime(s) {
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
    const biggest = photos.reduce((a,b) => (a.width*a.height >= b.width*b.height ? a : b));
    $("resolutionLabel").textContent = `${biggest.width} × ${biggest.height}`;
  } else $("resolutionLabel").textContent = "Based on largest photo";
}
function drawPreview() {
  ctx.fillStyle = "#03070d"; ctx.fillRect(0,0,preview.width,preview.height);
  if (selectedIndex < 0 || !photos[selectedIndex]) {
    ctx.fillStyle = "#a8bad0"; ctx.font = "18px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Add photos to preview your slideshow", preview.width/2, preview.height/2); return;
  }
  const p = photos[selectedIndex], scale = Math.min(preview.width/p.width, preview.height/p.height);
  const w = p.width*scale, h = p.height*scale;
  ctx.drawImage(p.image, (preview.width-w)/2, (preview.height-h)/2, w, h);
}
function renderList() {
  list.replaceChildren();
  if (!photos.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    empty.textContent = "Your selected photos will appear here."; list.append(empty);
  } else photos.forEach((p, i) => {
    const card = document.createElement("div"); card.className = "photo-card" + (i === selectedIndex ? " selected" : "");
    card.draggable = !exporting; card.dataset.index = i;
    const img = document.createElement("img"); img.src = p.url; img.alt = p.name;
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
function addFiles(files) {
  const candidates = [...files].filter(f => f.type.startsWith("image/"));
  if (!candidates.length) return setStatus("No supported images found. Choose JPG, PNG, WebP, or another browser-readable image.",0,"Waiting for photos");
  let pending = candidates.length;
  for (const file of candidates) {
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => {
      photos.push({file,url,image,name:file.name,width:image.naturalWidth,height:image.naturalHeight,duration:seconds()});
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
async function generateVideo() {
  if (!photos.length || exporting) return;
  exporting = true; $("downloadLink").hidden = true; $("generateBtn").disabled = true;
  $("generateBtn").textContent = "Rendering…"; $("clearBtn").disabled = true;
  try {
    const enc = await loadEncoder();
    // Choose the dimensions of the largest photo by pixel area; round up to even dimensions for H.264.
    const biggest = photos.reduce((a,b) => (a.width*a.height >= b.width*b.height ? a : b));
    const W = biggest.width + (biggest.width % 2), H = biggest.height + (biggest.height % 2);
    $("resolutionLabel").textContent = `${W} × ${H}`;
    const fileList = [];
    for (let i=0; i<photos.length; i++) {
      setStatus(`Preparing photo ${i+1} of ${photos.length}…`, 5 + (i/photos.length)*18, `Photo ${i+1}/${photos.length}`);
      const ext = (photos[i].file.name.split(".").pop() || "").toLowerCase();
      const safeExt = ["jpg","jpeg","png","webp","bmp"].includes(ext) ? ext : "png";
      const filename = `photo_${String(i).padStart(4,"0")}.${safeExt}`;
      await enc.writeFile(filename, new Uint8Array(await photos[i].file.arrayBuffer()));
      fileList.push({filename, duration: photos[i].duration || seconds()});
    }
    // FFmpeg concat demuxer honours each image duration; repeat the last image so its duration is retained.
    let concat = "";
    for (const item of fileList) concat += `file '${item.filename}'\nduration ${item.duration}\n`;
    concat += `file '${fileList[fileList.length-1].filename}'\n`;
    await enc.writeFile("photos.txt", new TextEncoder().encode(concat));
    setStatus("Encoding MP4…",25,"Encoding video");
    const filter = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
    await enc.exec(["-f","concat","-safe","0","-i","photos.txt","-vf",filter,"-vsync","vfr","-c:v","libx264","-preset","ultrafast","-crf","18","-movflags","+faststart","-t",String(fileList.reduce((sum,item)=>sum+item.duration,0)),"output.mp4"]);
    setStatus("Preparing your download…",97,"Finalising MP4");
    const data = await enc.readFile("output.mp4");
    const blob = new Blob([data.buffer], {type:"video/mp4"});
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);
    $("downloadLink").href = outputUrl;
    $("downloadLink").download = `photo-slideshow-${new Date().toISOString().slice(0,10)}.mp4`;
    $("downloadLink").hidden = false;
    setStatus("Your slideshow is ready. Click Download MP4 to save it.",100,`${(blob.size/1024/1024).toFixed(1)} MB`);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err?.message || err}. Try fewer photos or a lower-resolution set, and check your internet connection.`,0,"Export error");
  } finally {
    exporting = false; $("generateBtn").disabled = !photos.length; $("generateBtn").textContent = "⚙ Generate MP4";
    $("clearBtn").disabled = !photos.length; renderList();
  }
}
input.addEventListener("change", e => { addFiles(e.target.files); input.value = ""; });
durationInput.addEventListener("input", () => { if (Number(durationInput.value) > 0) updateSummary(); });
$("applyDurationBtn").addEventListener("click", () => {
  const value = Number(durationInput.value);
  if (!Number.isFinite(value) || value < 1 || value > 120) { setStatus("Duration must be between 1 and 120 seconds.",0,"Invalid duration"); return; }
  photos.forEach(p => p.duration = value);
  renderList(); setStatus(`Set all ${photos.length} photo durations to ${value} second(s).`,0,"Durations updated");
});
$("prevBtn").addEventListener("click", () => { if (selectedIndex>0) {selectedIndex--;renderList();drawPreview();} });
$("nextBtn").addEventListener("click", () => { if (selectedIndex<photos.length-1) {selectedIndex++;renderList();drawPreview();} });
$("clearBtn").addEventListener("click", () => { if (exporting) return; photos.forEach(p=>URL.revokeObjectURL(p.url));photos=[];selectedIndex=-1;renderList();drawPreview();setStatus("Add photos to begin.",0,"No export started");$("downloadLink").hidden=true; });
$("generateBtn").addEventListener("click", generateVideo);
const dz = $("dropzone");
dz.addEventListener("dragover", e=>{e.preventDefault();dz.classList.add("dragover");});
dz.addEventListener("dragleave", ()=>dz.classList.remove("dragover"));
dz.addEventListener("drop", e=>{e.preventDefault();dz.classList.remove("dragover");addFiles(e.dataTransfer.files);});
drawPreview(); updateSummary();
