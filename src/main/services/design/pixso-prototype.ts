import path from "node:path"

export const DESIGN_PROTOTYPE_ZIP_MAX_BYTES = 120 * 1024 * 1024
export const DESIGN_PROTOTYPE_ZIP_MAX_IMAGES = 80
export const DESIGN_PROTOTYPE_ZIP_MAX_ENTRY_BYTES = 30 * 1024 * 1024
export const DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_IMAGE_BYTES = 90 * 1024 * 1024
export const DESIGN_PROTOTYPE_ZIP_MAX_JSON_BYTES = 5 * 1024 * 1024
export const DESIGN_PROTOTYPE_ZIP_MAX_JSON_FILES = 20
export const DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_JSON_BYTES = 20 * 1024 * 1024

function escapeHtmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeScriptJson<T>(value: T): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export function normalizeZipEntryPath(entryName: string): string {
  return String(entryName || "").replace(/\\/g, "/").replace(/^\/+/, "")
}

export function isDesignPrototypeImagePath(entryPath: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(entryPath)
}

export function getDesignPrototypeMimeType(entryPath: string): string {
  const ext = path.extname(entryPath).toLowerCase()
  switch (ext) {
    case ".avif":
      return "image/avif"
    case ".bmp":
      return "image/bmp"
    case ".gif":
      return "image/gif"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".svg":
      return "image/svg+xml"
    case ".webp":
      return "image/webp"
    case ".png":
    default:
      return "image/png"
  }
}

export function naturalPrototypeSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

function readWebpChunkHeader(
  buffer: Buffer,
  offset: number
): { type: string; size: number; dataOffset: number; nextOffset: number } | null {
  if (offset + 8 > buffer.length) return null
  const type = buffer.toString("ascii", offset, offset + 4)
  const size = buffer.readUInt32LE(offset + 4)
  const dataOffset = offset + 8
  const nextOffset = dataOffset + size + (size % 2)
  if (dataOffset + size > buffer.length) return null
  return { type, size, dataOffset, nextOffset }
}

export function readPrototypeImageDimensions(
  buffer: Buffer,
  mimeType: string
): { width?: number; height?: number } {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    }
  }

  if (mimeType === "image/gif" && buffer.length >= 10) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    }
  }

  if (mimeType === "image/jpeg" && buffer.length > 4) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]
      const blockLength = buffer.readUInt16BE(offset + 2)
      if (!blockLength || offset + 2 + blockLength > buffer.length) break
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        }
      }
      offset += 2 + blockLength
    }
  }

  if (
    mimeType === "image/webp" &&
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    let offset = 12
    while (offset + 8 <= buffer.length) {
      const chunk = readWebpChunkHeader(buffer, offset)
      if (!chunk) break
      if (chunk.type === "VP8X" && chunk.size >= 10) {
        return {
          width: 1 + buffer.readUIntLE(chunk.dataOffset + 4, 3),
          height: 1 + buffer.readUIntLE(chunk.dataOffset + 7, 3)
        }
      }
      if (chunk.type === "VP8 " && chunk.size >= 10) {
        return {
          width: buffer.readUInt16LE(chunk.dataOffset + 6) & 0x3fff,
          height: buffer.readUInt16LE(chunk.dataOffset + 8) & 0x3fff
        }
      }
      if (chunk.type === "VP8L" && chunk.size >= 5) {
        const bits = buffer.readUInt32LE(chunk.dataOffset + 1)
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1
        }
      }
      offset = chunk.nextOffset
    }
  }

  if (mimeType === "image/svg+xml") {
    const svg = buffer.toString("utf-8", 0, Math.min(buffer.length, 4096))
    const tagMatch = svg.match(/<svg\b[^>]*>/i)
    const tag = tagMatch?.[0] ?? ""
    const width = tag.match(/\bwidth\s*=\s*["']?([\d.]+)/i)?.[1]
    const height = tag.match(/\bheight\s*=\s*["']?([\d.]+)/i)?.[1]
    if (width && height) {
      return { width: Number(width), height: Number(height) }
    }
    const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i)
    if (viewBox) {
      return { width: Number(viewBox[1]), height: Number(viewBox[2]) }
    }
  }

  return {}
}

export function prototypeBaseName(value: string): string {
  const normalized = normalizeZipEntryPath(value)
  const parsed = path.posix.parse(normalized)
  return (parsed.name || parsed.base || normalized)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function findStringByKeys(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function findNumberByKeys(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
      return Number(value)
  }
  return undefined
}

function findNestedRecord(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>
  }
  return undefined
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value?.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export type PrototypeHotspot = {
  x: number
  y: number
  width: number
  height: number
  target?: string
  targetIndex?: number
  label?: string
}

export type PrototypeMetadataScreen = {
  ids: string[]
  name?: string
  imageRef?: string
  width?: number
  height?: number
  hotspots?: PrototypeHotspot[]
}

export type PrototypeImageScreen = {
  id: string
  metadataIds: string[]
  name: string
  zipPath: string
  mimeType: string
  imageSrc: string
  size: number
  width?: number
  height?: number
  hotspots: PrototypeHotspot[]
}

function getPrototypeObjectLabel(source: Record<string, unknown>): string | undefined {
  return findStringByKeys(source, [
    "name",
    "title",
    "label",
    "screenName",
    "pageName",
    "frameName",
    "nodeName",
    "id"
  ])
}

function getPrototypeObjectIds(source: Record<string, unknown>): string[] {
  return uniqueStrings([
    findStringByKeys(source, ["id", "nodeId", "screenId", "pageId", "frameId", "guid", "uuid", "key"]),
    findStringByKeys(source, ["targetId", "destinationId"])
  ])
}

function getPrototypeImageReference(source: Record<string, unknown>): string | undefined {
  const direct = findStringByKeys(source, [
    "image",
    "imagePath",
    "imageUrl",
    "src",
    "url",
    "file",
    "filePath",
    "path",
    "filename",
    "screenshot",
    "thumbnail",
    "exportPath"
  ])
  if (direct && isDesignPrototypeImagePath(direct)) return direct

  const nested = findNestedRecord(source, ["image", "asset", "screenshot", "thumbnail", "export"])
  if (nested) return getPrototypeImageReference(nested)
  return undefined
}

function normalizePrototypeRect(raw: Record<string, unknown>): {
  x?: number
  y?: number
  width?: number
  height?: number
} {
  const bounds =
    findNestedRecord(raw, ["bounds", "rect", "frame", "absoluteBoundingBox", "box"]) ?? raw
  const x = findNumberByKeys(bounds, ["x", "left", "l"])
  const y = findNumberByKeys(bounds, ["y", "top", "t"])
  const width = findNumberByKeys(bounds, ["width", "w"])
  const height = findNumberByKeys(bounds, ["height", "h"])
  const right = findNumberByKeys(bounds, ["right", "r"])
  const bottom = findNumberByKeys(bounds, ["bottom", "b"])
  return {
    x,
    y,
    width: width ?? (typeof x === "number" && typeof right === "number" ? right - x : undefined),
    height: height ?? (typeof y === "number" && typeof bottom === "number" ? bottom - y : undefined)
  }
}

function extractPrototypeTarget(raw: Record<string, unknown>): string | undefined {
  const direct = findStringByKeys(raw, [
    "target",
    "targetId",
    "targetName",
    "destination",
    "destinationId",
    "navigateTo",
    "nodeId",
    "screenId",
    "pageId",
    "to",
    "link"
  ])
  if (direct) return direct
  const action = findNestedRecord(raw, ["action", "transition", "interaction", "navigation"])
  return action ? extractPrototypeTarget(action) : undefined
}

function extractPrototypeHotspots(value: unknown): PrototypeHotspot[] {
  const hotspots: PrototypeHotspot[] = []
  const visit = (node: unknown, depth: number) => {
    if (!node || depth > 4) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== "object") return

    const raw = node as Record<string, unknown>
    const rect = normalizePrototypeRect(raw)
    const target = extractPrototypeTarget(raw)
    if (
      typeof rect.x === "number" &&
      typeof rect.y === "number" &&
      typeof rect.width === "number" &&
      typeof rect.height === "number" &&
      rect.width > 0 &&
      rect.height > 0 &&
      target
    ) {
      hotspots.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        target,
        label: getPrototypeObjectLabel(raw)
      })
      return
    }

    for (const key of [
      "hotspots",
      "links",
      "connections",
      "interactions",
      "actions",
      "areas",
      "children"
    ]) {
      if (key in raw) visit(raw[key], depth + 1)
    }
  }
  visit(value, 0)
  return hotspots.slice(0, 120)
}

export function extractPrototypeMetadataScreens(value: unknown): PrototypeMetadataScreen[] {
  const screens: PrototypeMetadataScreen[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, depth: number) => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== "object") return

    const raw = node as Record<string, unknown>
    const imageRef = getPrototypeImageReference(raw)
    const label = getPrototypeObjectLabel(raw)
    const ids = getPrototypeObjectIds(raw)
    const rect = normalizePrototypeRect(raw)
    if (imageRef || (label && (raw.hotspots || raw.links || raw.interactions || raw.connections))) {
      const key = `${ids.join("|")}:${imageRef ?? ""}:${label ?? ""}:${screens.length}`
      if (!seen.has(key)) {
        seen.add(key)
        screens.push({
          ids,
          name: label,
          imageRef,
          width: rect.width,
          height: rect.height,
          hotspots: extractPrototypeHotspots(raw)
        })
      }
    }

    for (const [key, child] of Object.entries(raw)) {
      if (["parent", "parentNode", "document"].includes(key)) continue
      if (typeof child === "object" && child !== null) visit(child, depth + 1)
    }
  }

  visit(value, 0)
  return screens.slice(0, 200)
}

export function metadataMatchesImage(
  metadata: PrototypeMetadataScreen,
  imagePath: string
): boolean {
  if (!metadata.imageRef) return false
  const imageRef = normalizeZipEntryPath(metadata.imageRef).toLowerCase()
  const zipPath = normalizeZipEntryPath(imagePath).toLowerCase()
  const refBase = path.posix.basename(imageRef)
  const pathBase = path.posix.basename(zipPath)
  return imageRef === zipPath || refBase === pathBase || zipPath.endsWith(`/${imageRef}`)
}

export function resolvePrototypeHotspotTarget(
  hotspot: PrototypeHotspot,
  screens: PrototypeImageScreen[],
  metadataScreens: PrototypeMetadataScreen[]
): number | undefined {
  const rawTarget = hotspot.target?.trim()
  if (!rawTarget) return undefined
  const target = rawTarget.toLowerCase()
  const directIndex = screens.findIndex((screen) => {
    return (
      screen.id.toLowerCase() === target ||
      screen.metadataIds.some((id) => id.toLowerCase() === target) ||
      screen.name.toLowerCase() === target ||
      prototypeBaseName(screen.zipPath).toLowerCase() === target ||
      normalizeZipEntryPath(screen.zipPath).toLowerCase() === target
    )
  })
  if (directIndex >= 0) return directIndex

  const metadataIndex = metadataScreens.findIndex((screen) => {
    const candidates = [
      ...screen.ids,
      screen.name,
      screen.imageRef,
      screen.imageRef ? prototypeBaseName(screen.imageRef) : undefined
    ].filter((item): item is string => Boolean(item))
    return candidates.some((candidate) => candidate.toLowerCase() === target)
  })
  if (metadataIndex >= 0) {
    const metadata = metadataScreens[metadataIndex]
    const screenIndex = screens.findIndex((screen) => metadataMatchesImage(metadata, screen.zipPath))
    if (screenIndex >= 0) return screenIndex
  }
  return undefined
}

export function buildPrototypeHtml(
  title: string,
  screens: PrototypeImageScreen[],
  metadataCount: number,
  sourceFileName: string
): string {
  const payload = screens.map((screen) => ({
    id: screen.id,
    name: screen.name,
    zipPath: screen.zipPath,
    width: screen.width,
    height: screen.height,
    imageSrc: screen.imageSrc,
    hotspots: screen.hotspots.filter((hotspot) => {
      return (
        typeof hotspot.targetIndex === "number" &&
        typeof screen.width === "number" &&
        screen.width > 0 &&
        typeof screen.height === "number" &&
        screen.height > 0
      )
    })
  }))
  const safeTitle = escapeHtmlText(title)
  const firstScreen = screens[0]
  const viewportMaxWidth = Math.min(1440, Math.max(390, firstScreen?.width ?? 1200))

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<style>
:root{
  --bg:#f6f4ef;
  --panel:#ffffff;
  --ink:#1f2328;
  --muted:#707782;
  --line:#ded9cf;
  --accent:#2563eb;
  --hotspot:rgba(37,99,235,.16);
  --hotspot-border:rgba(37,99,235,.42);
  --radius:12px;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:"Sora","Noto Sans SC",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{height:100vh;overflow:hidden}
.prototype-shell{height:100vh;display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);background:linear-gradient(180deg,#fbfaf7 0%,var(--bg) 100%)}
.sidebar{border-right:1px solid var(--line);background:rgba(255,255,255,.86);display:flex;flex-direction:column;min-width:0}
.brand{padding:18px 18px 14px;border-bottom:1px solid var(--line)}
.brand h1{margin:0 0 6px;font-size:15px;line-height:1.35;font-weight:750;letter-spacing:0;color:var(--ink)}
.brand p{margin:0;font-size:11px;line-height:1.5;color:var(--muted)}
.screen-list{padding:10px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.screen-btn{width:100%;display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;padding:8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}
.screen-btn:hover{background:#f3f1eb}
.screen-btn.active{background:#eef4ff;border-color:#c8dcff}
.screen-thumb{width:38px;height:38px;border:1px solid #e2ded6;border-radius:6px;background:#f7f7f7;object-fit:cover;object-position:top}
.screen-meta{min-width:0}
.screen-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700}
.screen-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;font-size:10px;color:var(--muted)}
.stage{min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);height:100vh}
.topbar{height:54px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line);background:rgba(250,249,246,.9);backdrop-filter:blur(10px)}
.screen-title{font-size:14px;font-weight:750;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-spacer{flex:1}
.count-pill,.zoom-pill{border:1px solid var(--line);border-radius:999px;background:#fff;padding:5px 9px;font-size:11px;color:var(--muted);white-space:nowrap}
.nav-btn{height:30px;min-width:30px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:13px;cursor:pointer}
.nav-btn:hover{border-color:#bfc7d5}
.viewer{height:100%;overflow:auto;padding:28px;display:flex;align-items:flex-start;justify-content:center}
.device{position:relative;width:min(100%,${viewportMaxWidth}px);border-radius:var(--radius);background:#fff;box-shadow:0 18px 50px rgba(31,35,40,.14),0 2px 8px rgba(31,35,40,.08);overflow:hidden}
.prototype-image{display:block;width:100%;height:auto}
.hotspot{position:absolute;border:1px solid var(--hotspot-border);background:var(--hotspot);border-radius:8px;cursor:pointer;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}
.hotspot:hover{background:rgba(37,99,235,.26);border-color:rgba(37,99,235,.7);box-shadow:0 0 0 4px rgba(37,99,235,.12)}
.empty-hotspots{position:absolute;right:12px;bottom:12px;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.85);border-radius:999px;padding:5px 9px;font-size:11px;color:var(--muted);pointer-events:none}
@media (max-width: 820px){
  body{overflow:auto}
  .prototype-shell{height:auto;min-height:100vh;display:block}
  .sidebar{position:sticky;top:0;z-index:4;border-right:0;border-bottom:1px solid var(--line);max-height:220px}
  .screen-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  .stage{height:auto;min-height:calc(100vh - 220px)}
  .topbar{position:sticky;top:220px;z-index:3}
  .viewer{padding:14px}
}
</style>
</head>
<body>
<div class="prototype-shell" data-design-anchor="pixso-prototype">
  <aside class="sidebar">
    <div class="brand">
      <h1>${safeTitle}</h1>
      <p>${screens.length} 个画板 · ${metadataCount} 个元数据文件 · ${escapeHtmlText(sourceFileName)}</p>
    </div>
    <div class="screen-list" id="screenList"></div>
  </aside>
  <main class="stage">
    <div class="topbar">
      <button class="nav-btn" id="prevBtn" type="button" aria-label="上一屏">‹</button>
      <button class="nav-btn" id="nextBtn" type="button" aria-label="下一屏">›</button>
      <div class="screen-title" id="screenTitle"></div>
      <div class="topbar-spacer"></div>
      <div class="count-pill" id="screenCount"></div>
      <div class="zoom-pill" id="screenSize"></div>
    </div>
    <div class="viewer">
      <div class="device" id="device">
        <img class="prototype-image" id="prototypeImage" alt="">
      </div>
    </div>
  </main>
</div>
<script>
(function(){
var screens=${escapeScriptJson(payload)};
var current=0;
var list=document.getElementById('screenList');
var title=document.getElementById('screenTitle');
var count=document.getElementById('screenCount');
var size=document.getElementById('screenSize');
var device=document.getElementById('device');
var image=document.getElementById('prototypeImage');
var prev=document.getElementById('prevBtn');
var next=document.getElementById('nextBtn');
function clamp(index){return Math.max(0,Math.min(screens.length-1,index));}
function pct(value,total){if(!total)return 0;return value<=1&&value>=0?value*100:(value/total)*100;}
function renderList(){
  list.innerHTML='';
  screens.forEach(function(screen,index){
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='screen-btn'+(index===current?' active':'');
    btn.setAttribute('data-design-anchor','screen-nav-'+index);
    btn.onclick=function(){show(index);};
    var thumb=document.createElement('img');
    thumb.className='screen-thumb';
    thumb.src=screen.imageSrc;
    thumb.alt='';
    var meta=document.createElement('span');
    meta.className='screen-meta';
    var name=document.createElement('span');
    name.className='screen-name';
    name.textContent=screen.name||('画板 '+(index+1));
    var path=document.createElement('span');
    path.className='screen-path';
    path.textContent=screen.zipPath||'';
    meta.appendChild(name);
    meta.appendChild(path);
    btn.appendChild(thumb);
    btn.appendChild(meta);
    list.appendChild(btn);
  });
}
function renderHotspots(screen){
  device.querySelectorAll('.hotspot,.empty-hotspots').forEach(function(node){node.remove();});
  var hotspots=screen.hotspots||[];
  if(hotspots.length===0){
    var hint=document.createElement('div');
    hint.className='empty-hotspots';
    hint.textContent='静态画板';
    device.appendChild(hint);
    return;
  }
  hotspots.forEach(function(hotspot,index){
    var target=typeof hotspot.targetIndex==='number'?hotspot.targetIndex:undefined;
    var area=document.createElement('button');
    area.type='button';
    area.className='hotspot';
    area.disabled=typeof target!=='number';
    area.title=hotspot.label||'跳转';
    area.setAttribute('aria-label',area.title);
    area.style.left=pct(hotspot.x,screen.width)+'%';
    area.style.top=pct(hotspot.y,screen.height)+'%';
    area.style.width=Math.max(.6,pct(hotspot.width,screen.width))+'%';
    area.style.height=Math.max(.6,pct(hotspot.height,screen.height))+'%';
    area.setAttribute('data-design-anchor','hotspot-'+current+'-'+index);
    area.onclick=function(){if(typeof target==='number')show(target);};
    device.appendChild(area);
  });
}
function show(index){
  current=clamp(index);
  var screen=screens[current];
  image.src=screen.imageSrc;
  image.alt=screen.name||'prototype screen';
  title.textContent=screen.name||('画板 '+(current+1));
  count.textContent=(current+1)+' / '+screens.length;
  size.textContent=(screen.width&&screen.height)?(screen.width+' × '+screen.height):'自适应';
  prev.disabled=current===0;
  next.disabled=current===screens.length-1;
  renderList();
  renderHotspots(screen);
}
prev.onclick=function(){show(current-1);};
next.onclick=function(){show(current+1);};
window.addEventListener('keydown',function(event){
  if(event.key==='ArrowLeft')show(current-1);
  if(event.key==='ArrowRight')show(current+1);
});
show(0);
var TWEAK_DEFAULTS=/*EDITMODE-BEGIN*/{"accent":"#2563eb","hotspot":true,"radius":12,"panelWidth":280}/*EDITMODE-END*/;
function applyTweaks(edits){
  var t=Object.assign({},TWEAK_DEFAULTS,edits||{});
  var r=document.documentElement;
  r.style.setProperty('--accent',String(t.accent));
  r.style.setProperty('--hotspot',t.hotspot?'rgba(37,99,235,.16)':'rgba(37,99,235,0)');
  r.style.setProperty('--hotspot-border',t.hotspot?'rgba(37,99,235,.42)':'rgba(37,99,235,0)');
  r.style.setProperty('--radius',String(t.radius)+'px');
  document.querySelector('.prototype-shell').style.gridTemplateColumns='minmax(220px,'+String(t.panelWidth)+'px) minmax(0,1fr)';
}
window.addEventListener('message',function(e){
  if(e.data&&e.data.type==='__set_tweak_keys')applyTweaks(e.data.edits);
  if(e.data&&e.data.type==='__activate_edit_mode')document.body.classList.add('edit-mode-ready');
  if(e.data&&e.data.type==='__deactivate_edit_mode')document.body.classList.remove('edit-mode-ready');
});
window.parent.postMessage({type:'__edit_mode_available'},'*');
applyTweaks({});
})()
</script>
</body>
</html>`
}
