// script.js
// SoundCue JSON -> Unreal SoundCueGraph converter
// - Full-featured converter with:
//   * lane-based subtree layout (preserves per-slot order)
//   * root-on-right orientation (left->right flow visually)
//   * vertical fan-out for multi-input nodes (Input/Input2/Input3 order)
//   * per-column collision reduction
//   * accurate per-slot CustomProperties Pin LinkedTo mapping
//   * WavePlayer SoundWaveAssetPtr heuristics
//   * Attenuation detection (uses JSON path or falls back to default fallback)
//   * UI: file input, Convert, Copy, Download, include GUIDs checkbox
// NOTE: Replace your existing script.js with this single block.

(() => {
  // ---------------------------
  // UI elements
  // ---------------------------
  const fileInput = document.getElementById('jsonFile');
  const convertBtn = document.getElementById('convertBtn');
  const outputEl = document.getElementById('output');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const includeGuidsCheckbox = document.getElementById('includeGuids');

  let lastResultText = '';

  fileInput.addEventListener('change', () => {
    convertBtn.disabled = fileInput.files.length === 0;
  });

  convertBtn.addEventListener('click', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const raw = await f.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        outputEl.value = `ERROR: Invalid JSON — ${err.message}`;
        return;
      }
      try {
        const includeGuids = !!includeGuidsCheckbox.checked;
        lastResultText = convertSoundCueJsonFull(json, includeGuids);
        outputEl.value = lastResultText;
        copyBtn.disabled = false;
        downloadBtn.disabled = false;
      } catch (err) {
        outputEl.value = `ERROR during conversion: ${err.message}\n${err.stack || ''}`;
        copyBtn.disabled = true;
        downloadBtn.disabled = true;
      }
    } catch (err) {
      outputEl.value = `ERROR reading file: ${err.message}`;
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(outputEl.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy Output'), 1200);
    } catch (err) {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => (copyBtn.textContent = 'Copy Output'), 1200);
    }
  });

  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([lastResultText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Converted_SoundCueGraph.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------------------------
  // Helpers
  // ---------------------------
  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function randomHex(len) {
    const chars = '0123456789ABCDEF';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  function randomGuid32() {
    return randomHex(32);
  }
  function parseRefIndex(opath) {
    if (opath === undefined || opath === null) return null;
    const s = String(opath);
    const m = s.match(/\.([0-9]+)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ---------------------------
  // Attenuation detection helper
  // ---------------------------
  function findAttenuationPathFromProps(props) {
    if (!props || typeof props !== 'object') return null;

    const candidateKeys = [
      'AttenuationSettings',
      'AttenuationAsset',
      'SoundAttenuation',
      'Attenuation',
      'AttenuationPreset',
      'AttenuationObject',
      'AttenuationPath',
      'AttenuationName'
    ];

    for (const key of candidateKeys) {
      if (!(key in props)) continue;
      const val = props[key];
      if (!val) continue;
      if (typeof val === 'object') {
        if (val.ObjectPath && typeof val.ObjectPath === 'string' && val.ObjectPath.includes('/Game/')) {
          let p = val.ObjectPath.replace(/\.\d+$/, '');
          if (!p.includes('.')) { const last = p.split('/').pop(); p = `${p}.${last}`; }
          return p;
        }
        if (val.AssetPathName && typeof val.AssetPathName === 'string' && val.AssetPathName.includes('/Game/')) {
          return val.AssetPathName;
        }
      } else if (typeof val === 'string') {
        let s = val.trim();
        if (s.includes('/Game/')) {
          s = s.replace(/\.\d+$/, '');
          if (!s.includes('.')) { const last = s.split('/').pop(); s = `${s}.${last}`; }
          return s;
        }
        // also accept "Path.Asset" style already
        if (/\.[A-Za-z0-9_]+$/.test(s)) {
          return s.replace(/\.\d+$/, '');
        }
      }
    }

    if (props.AttenuationSettings && typeof props.AttenuationSettings === 'object') {
      const candidate = props.AttenuationSettings.ObjectPath || props.AttenuationSettings.AssetPathName;
      if (candidate && typeof candidate === 'string') {
        let p = candidate.replace(/\.\d+$/, '');
        if (!p.includes('.')) { const last = p.split('/').pop(); p = `${p}.${last}`; }
        return p;
      }
    }

    return null;
  }

  // ---------------------------
  // Layout & metadata builder (restores advanced sorting)
  // Returns { arr, exportBasePath, nodeMap, parentToChildren }
  // ---------------------------
  function buildLayoutAndMetadata(arr, includeGuids = true) {
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Input must be a non-empty array.');

    // If the JSON is in the "Exports" style (your earlier files), normalize:
    const normalizedArr = Array.isArray(arr) ? arr : (arr.Exports || arr);

    // find SoundCue for naming
    const cueIndex = normalizedArr.findIndex(o => o.Type === 'SoundCue');
    const cueObj = cueIndex >= 0 ? normalizedArr[cueIndex] : null;
    let exportBasePath = '/Game/NewSoundCue.NewSoundCue';
    try {
      if (cueObj) {
        const fp = cueObj.Properties?.FirstNode?.ObjectPath || cueObj.Properties?.FirstNode?.ObjectName || cueObj.Name;
        if (fp) {
          let base = String(fp).replace(/\.\d+$/, '');
          const last = base.split('/').pop() || 'NewSoundCue';
          exportBasePath = `${base}.${last}`;
        }
      }
    } catch (e) { /* ignore */ }

    const nodeMap = {};
    const parentToChildren = {};
    const childToParent = {};
    const typeCounters = {};

    function nextName(type) {
      typeCounters[type] = (typeCounters[type] || 0) + 1;
      return `${type}_${typeCounters[type] - 1}`;
    }

    // Precompute child counts to size inputPinIds
    const childCounts = new Array(normalizedArr.length).fill(1);
    for (let i = 0; i < normalizedArr.length; i++) {
      const props = normalizedArr[i].Properties || {};
      if (Array.isArray(props.ChildNodes) && props.ChildNodes.length > 0) childCounts[i] = props.ChildNodes.length;
      else childCounts[i] = 1;
    }

    // initialize nodeMap
    for (let i = 0; i < normalizedArr.length; i++) {
      const type = normalizedArr[i].Type || 'SoundNodeUnknown';
      nodeMap[i] = {
        index: i,
        soundNodeType: type,
        soundNodeName: nextName(type),
        nodeGuid: includeGuids ? randomGuid32() : '00000000000000000000000000000000',
        outputPinId: randomHex(32),
        inputPinIds: new Array(childCounts[i]).fill(null).map(() => randomHex(32)),
        subtreeHeight: 0,
        laneIndices: [],
        laneStart: 0,
        laneEnd: 0,
        posX: 0,
        posY: 0
      };
    }

    // build parentToChildren preserving slot order
    for (let i = 0; i < normalizedArr.length; i++) {
      const props = normalizedArr[i].Properties || {};
      const children = Array.isArray(props.ChildNodes) ? props.ChildNodes : [];
      parentToChildren[i] = [];
      for (let ci = 0; ci < children.length; ci++) {
        const ref = children[ci];
        const op = ref?.ObjectPath || ref?.ObjectName || ref;
        const idx = parseRefIndex(op);
        parentToChildren[i].push(idx ?? null);
        if (idx != null) childToParent[idx] = i; // track one parent (used for roots)
      }
    }

    // roots are nodes without any parent
    const allIndices = normalizedArr.map((_, i) => i);
    const roots = allIndices.filter(i => !(i in childToParent));
    const layoutRoots = roots.length ? roots : [0];

    // layout constants
    const xStep = 420;
    const yStep = 250;
    const regionGap = 800;

    // compute subtree height function (in lanes)
    const visited = new Array(normalizedArr.length).fill(false);
    function dfsHeight(i) {
      if (visited[i]) return nodeMap[i].subtreeHeight;
      const children = parentToChildren[i] || [];
      if (!children.length) {
        nodeMap[i].subtreeHeight = 1;
        visited[i] = true;
        return 1;
      }
      let total = 0;
      for (const c of children) {
        if (c == null) total += 1;
        else total += Math.max(1, dfsHeight(c));
      }
      nodeMap[i].subtreeHeight = Math.max(1, total);
      visited[i] = true;
      return nodeMap[i].subtreeHeight;
    }
    for (const r of layoutRoots) dfsHeight(r);

    // assign lane start per root
    let laneCursor = 0;
    const rootLaneStart = {};
    for (let ri = 0; ri < layoutRoots.length; ri++) {
      const r = layoutRoots[ri];
      rootLaneStart[r] = laneCursor;
      laneCursor += nodeMap[r].subtreeHeight;
      if (ri < layoutRoots.length - 1) laneCursor += Math.ceil(regionGap / yStep);
    }

    // assign lanes recursively, preserving slot order
    function assignLanes(idx, start) {
      const children = parentToChildren[idx] || [];
      if (!children.length) {
        nodeMap[idx].laneIndices = [start];
        nodeMap[idx].laneStart = start;
        nodeMap[idx].laneEnd = start;
        return 1;
      }
      let cursor = start;
      const assigned = [];
      for (let ci = 0; ci < children.length; ci++) {
        const cIdx = children[ci];
        if (cIdx == null) {
          assigned.push(cursor);
          cursor += 1;
        } else {
          const h = Math.max(1, nodeMap[cIdx].subtreeHeight || 1);
          assignLanes(cIdx, cursor);
          for (let l = cursor; l < cursor + h; l++) assigned.push(l);
          cursor += h;
        }
      }
      const unique = Array.from(new Set(assigned)).sort((a, b) => a - b);
      nodeMap[idx].laneIndices = unique;
      nodeMap[idx].laneStart = unique[0];
      nodeMap[idx].laneEnd = unique[unique.length - 1];
      return unique.length;
    }

    for (const r of layoutRoots) assignLanes(r, rootLaneStart[r]);

    // lane -> Y mapping and depth map
    let minLane = Infinity, maxLane = -Infinity;
    for (const k of Object.keys(nodeMap)) {
      const nm = nodeMap[k];
      if (!nm.laneIndices || nm.laneIndices.length === 0) continue;
      minLane = Math.min(minLane, nm.laneStart);
      maxLane = Math.max(maxLane, nm.laneEnd);
    }
    if (!isFinite(minLane)) { minLane = 0; maxLane = 0; }
    const globalLaneCenter = (minLane + maxLane) / 2;
    function laneToY(l) { return Math.round((l - globalLaneCenter) * yStep); }

    // compute depth (distance from roots) via BFS
    const depthMap = new Array(normalizedArr.length).fill(null);
    const q = [];
    for (const r of layoutRoots) { depthMap[r] = 0; q.push(r); }
    while (q.length) {
      const cur = q.shift();
      for (const c of parentToChildren[cur] || []) {
        if (c == null) continue;
        const d = (depthMap[cur] || 0) + 1;
        if (depthMap[c] === null || d > depthMap[c]) {
          depthMap[c] = d;
          q.push(c);
        }
      }
    }
    for (let i = 0; i < normalizedArr.length; i++) if (depthMap[i] === null) depthMap[i] = 0;
    const maxDepth = Math.max(...depthMap);

    // assign positions: X inverted so root is rightmost
    for (const k of Object.keys(nodeMap)) {
      const n = nodeMap[k];
      n.posX = (maxDepth - (depthMap[k] || 0)) * xStep;
      if (n.laneIndices && n.laneIndices.length > 0) {
        const sum = n.laneIndices.reduce((s, li) => s + laneToY(li), 0);
        n.posY = Math.round(sum / n.laneIndices.length);
      } else n.posY = 0;
    }

    // per-column vertical collision reduction
    const buckets = {};
    for (const k of Object.keys(nodeMap)) {
      const n = nodeMap[k];
      const x = n.posX || 0;
      buckets[x] = buckets[x] || [];
      buckets[x].push(n);
    }
    const minVerticalGap = Math.round(yStep * 0.7);
    for (const bucket of Object.values(buckets)) {
      bucket.sort((a, b) => a.posY - b.posY);
      for (let i = 1; i < bucket.length; i++) {
        if (bucket[i].posY - bucket[i - 1].posY < minVerticalGap) {
          bucket[i].posY = bucket[i - 1].posY + minVerticalGap;
        }
      }
    }

    // center vertically
    const allY = Object.values(nodeMap).map(n => n.posY);
    const minY = allY.length ? Math.min(...allY) : 0;
    const maxY = allY.length ? Math.max(...allY) : 0;
    const mid = (minY + maxY) / 2;
    for (const nm of Object.values(nodeMap)) {
      nm.posY = Math.round(nm.posY - mid);
      nm.posX = Math.round(nm.posX);
    }

    return { arr: normalizedArr, exportBasePath, nodeMap, parentToChildren };
  }

  // ---------------------------
  // Finalize export (serialize to Unreal text, populate LinkedTo)
  // ---------------------------
  function finalizeExport({ arr, exportBasePath, nodeMap, parentToChildren }) {
    function graphNodeHeader(i) {
      return `Begin Object Class=/Script/AudioEditor.SoundCueGraphNode Name="SoundCueGraphNode_${i}" ExportPath="/Script/AudioEditor.SoundCueGraphNode'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${i}'"\n`;
    }
    function engineExportPath(engineClass, idx, nodeName) {
      return `/Script/Engine.${engineClass}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${idx}.${nodeName}'`;
    }

    const blocks = new Array(arr.length).fill('');
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      const map = nodeMap[i];
      const props = el.Properties || {};
      const engineType = el.Type || 'SoundNodeUnknown';
      const nodeName = map.soundNodeName;

      let b = '';
      b += graphNodeHeader(i);
      b += `   Begin Object Class=/Script/Engine.${engineType} Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'">\n`;
      b += `   End Object\n`;
      b += `   Begin Object Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'\n`;

      // Insert attenuation if this node is attenuation type
      if (engineType === 'SoundNodeAttenuation') {
        const found = findAttenuationPathFromProps(props);
        const attenuationPath = found || '/Game/Sounds/Attenuation/Default_Attenuation.Default_Attenuation';
        b += `      AttenuationSettings="/Script/Engine.SoundAttenuation'${attenuationPath}'"\n`;
        b += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else if (engineType === 'SoundNodeWavePlayer') {
        // WavePlayer heuristics
        let resolved = null;
        if (props.SoundWaveAssetPtr) {
          if (typeof props.SoundWaveAssetPtr === 'string') resolved = props.SoundWaveAssetPtr;
          else if (typeof props.SoundWaveAssetPtr === 'object' && props.SoundWaveAssetPtr.AssetPathName) resolved = props.SoundWaveAssetPtr.AssetPathName;
        }
        if (!resolved && props.SoundWave) {
          const sw = props.SoundWave;
          if (typeof sw === 'string') resolved = sw.replace(/\.\d+$/, '');
          else if (sw.ObjectPath) resolved = sw.ObjectPath.replace(/\.\d+$/, '');
          if (resolved && !resolved.includes('.')) {
            const last = resolved.split('/').pop();
            resolved = `${resolved}.${last}`;
          }
        }
        if (!resolved && el.SoundWave && el.SoundWave.ObjectPath) {
          const p = el.SoundWave.ObjectPath.replace(/\.\d+$/, '');
          const last = p.split('/').pop();
          resolved = `${p}.${last}`;
        }
        if (resolved) b += `      SoundWaveAssetPtr="${resolved}"\n`;
        else b += `      /* SoundWaveAssetPtr unresolved for this WavePlayer */\n`;
        b += `      bLooping=${props.bLooping ? 'True' : 'False'}\n`;
        b += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else {
        // Generic properties
        if (engineType === 'SoundNodeMixer' && Array.isArray(props.InputVolume)) {
          for (let vi = 0; vi < props.InputVolume.length; vi++) {
            const val = Number(props.InputVolume[vi]) || 0;
            b += `      InputVolume(${vi})=${val.toFixed(6)}\n`;
          }
        }
        if (engineType === 'SoundNodeModulator') {
          if (props.PitchMin !== undefined) b += `      PitchMin=${Number(props.PitchMin).toFixed(6)}\n`;
          if (props.PitchMax !== undefined) b += `      PitchMax=${Number(props.PitchMax).toFixed(6)}\n`;
        }
        b += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      }

      // ChildNodes (preserve slot order)
      const children = parentToChildren[i] || [];
      for (let ci = 0; ci < children.length; ci++) {
        const cIdx = children[ci];
        if (cIdx == null) {
          b += `      /* ChildNodes(${ci}) unresolved */\n`;
        } else {
          const child = nodeMap[cIdx];
          const childPath = `/Script/Engine.${child.soundNodeType}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${cIdx}.${child.soundNodeName}'`;
          b += `      ChildNodes(${ci})="${childPath}"\n`;
        }
      }

      b += `   End Object\n`;
      b += `   SoundNode="/Script/Engine.${engineType}'${nodeName}'"\n`;
      b += `   NodePosX=${map.posX}\n`;
      b += `   NodePosY=${map.posY}\n`;
      b += `   NodeGuid=${map.nodeGuid}\n`;

      // Output pin placeholder
      b += `   CustomProperties Pin (PinId=${map.outputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(),PersistentGuid=00000000000000000000000000000000,)\n`;

      // Input pins (one per slot)
      for (let ci = 0; ci < map.inputPinIds.length; ci++) {
        const label = ci === 0 ? 'Input' : `Input${ci + 1}`;
        b += `   CustomProperties Pin (PinId=${map.inputPinIds[ci]},PinName="${label}",PinFriendlyName=" ",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(),PersistentGuid=00000000000000000000000000000000,)\n`;
      }

      b += `End Object\n\n`;
      blocks[i] = b;
    }

    // join blocks
    let combined = blocks.join('');

    // populate LinkedTo per-slot (parent.input[s] -> child.output) and append reciprocal entries
    for (const [pStr, children] of Object.entries(parentToChildren)) {
      const p = Number(pStr);
      const pMap = nodeMap[p];
      for (let s = 0; s < children.length; s++) {
        const cIdx = children[s];
        if (cIdx == null) continue;
        const cMap = nodeMap[cIdx];

        const parentPinId = pMap.inputPinIds[s];
        const childOutputPinId = cMap.outputPinId;

        // parent input: replace LinkedTo=()
        const parentInputRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(parentPinId)}[^\\)]*LinkedTo=\\(\\)`, 'm');
        const parentReplacement = `CustomProperties Pin (PinId=${parentPinId},PinName="${s===0 ? 'Input' : 'Input'+(s+1)}",PinFriendlyName=" ",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(SoundCueGraphNode_${cIdx} ${childOutputPinId},),PersistentGuid=00000000000000000000000000000000,)`;
        combined = combined.replace(parentInputRe, parentReplacement);

        // child output: append parent ref
        const childOutputRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childOutputPinId)}[^\\)]*LinkedTo=\\(([^\\)]*)\\)`, 'm');
        const m = combined.match(childOutputRe);
        const parentRefText = `SoundCueGraphNode_${p} ${parentPinId},`;
        if (m) {
          const existingInner = m[1] || '';
          const newInner = existingInner + parentRefText;
          const replacement = `CustomProperties Pin (PinId=${childOutputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(${newInner}),PersistentGuid=00000000000000000000000000000000,)`;
          combined = combined.replace(childOutputRe, replacement);
        } else {
          // fallback: create output pin line with LinkedTo
          const fallbackRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childOutputPinId)}[^\\n]*\\)\\n`, 'm');
          combined = combined.replace(fallbackRe, `   CustomProperties Pin (PinId=${childOutputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",LinkedTo=(SoundCueGraphNode_${p} ${parentPinId},),PersistentGuid=00000000000000000000000000000000,)\n`);
        }
      }
    }

    return combined;
  }

  // ---------------------------
  // Full conversion entry
  // ---------------------------
  function convertSoundCueJsonFull(json, includeGuids = true) {
    // Accept both array-style exports or object containing Exports
    const arr = Array.isArray(json) ? json : (json.Exports || json);
    const struct = buildLayoutAndMetadata(arr, includeGuids);
    const final = finalizeExport(struct);
    return final;
  }

  // expose for UI
  window.convertSoundCueJsonFull = convertSoundCueJsonFull;
})();
