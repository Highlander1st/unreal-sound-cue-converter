// script.js
// SoundCue JSON -> Unreal SoundCueGraph converter
// Latest working converter with fixed placement of comment bubble fields.
// - Writes bCommentBubbleVisible & NodeComment at the graph-node level (same level as NodeGuid).
// - Preserves all other functionality (layout, pins, wave assignment, attenuation fallback).

(() => {
  // ---------------------------
  // UI bindings
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

  // Generic asset path finder for many JSON shapes
  function findAssetPathFromProps(props, candidateKeys = []) {
    if (!props || typeof props !== 'object') return null;

    const defaults = [
      'SoundWaveAssetPtr', 'SoundWave', 'SoundWaveObject', 'SoundWavePath', 'Wave', 'WaveAsset',
      'AttenuationSettings', 'AttenuationAsset', 'SoundAttenuation', 'Attenuation', 'AttenuationPath',
      'AssetPathName', 'ObjectPath', 'Asset', 'Path'
    ];
    const keys = Array.from(new Set([...candidateKeys, ...defaults]));

    for (const key of keys) {
      if (!(key in props)) continue;
      const val = props[key];
      if (!val) continue;
      if (typeof val === 'string') {
        let s = val.trim();
        if (s.includes('/Game/')) {
          s = s.replace(/\.\d+$/, '');
          if (!s.includes('.')) {
            const last = s.split('/').pop();
            s = `${s}.${last}`;
          }
          return s;
        }
        if (/\.[A-Za-z0-9_]+$/.test(s)) {
          return s.replace(/\.\d+$/, '');
        }
      } else if (typeof val === 'object') {
        if (val.ObjectPath && typeof val.ObjectPath === 'string') {
          let p = val.ObjectPath.replace(/\.\d+$/, '');
          if (!p.includes('.')) { const last = p.split('/').pop(); p = `${p}.${last}`; }
          return p;
        }
        if (val.AssetPathName && typeof val.AssetPathName === 'string') {
          let p = val.AssetPathName.replace(/\.\d+$/, '');
          if (!p.includes('.')) { const last = p.split('/').pop(); p = `${p}.${last}`; }
          return p;
        }
        if (val.Asset && typeof val.Asset === 'string') {
          let p = val.Asset.replace(/\.\d+$/, '');
          if (p.includes('/Game/')) {
            if (!p.includes('.')) { const last = p.split('/').pop(); p = `${p}.${last}`; }
            return p;
          }
        }
      }
    }

    return null;
  }

  function findAttenuationPathFromProps(props) {
    const candidateKeys = [
      'AttenuationSettings',
      'AttenuationAsset',
      'SoundAttenuation',
      'Attenuation',
      'AttenuationPreset',
      'AttenuationObject',
      'AttenuationPath',
      'AttenuationName',
      'AssetPathName',
      'ObjectPath'
    ];
    const p = findAssetPathFromProps(props, candidateKeys);
    if (p) return p;
    return null;
  }

  function assetNameFromPath(path) {
    if (!path || typeof path !== 'string') return null;
    const cleaned = path.replace(/\.\d+$/, '');
    if (cleaned.includes('.')) return cleaned.split('.').pop();
    const parts = cleaned.split('/');
    return parts.pop() || cleaned;
  }

  // ---------------------------
  // Layout & metadata (advanced lane layout)
  // ---------------------------
  function buildLayoutAndMetadata(arr, includeGuids = true) {
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Input must be a non-empty array.');

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
    const childToParents = {};
    const typeCounters = {};

    function nextName(type) {
      typeCounters[type] = (typeCounters[type] || 0) + 1;
      return `${type}_${typeCounters[type] - 1}`;
    }

    // Precompute child counts
    const childCounts = new Array(normalizedArr.length).fill(1);
    for (let i = 0; i < normalizedArr.length; i++) {
      const props = normalizedArr[i].Properties || {};
      if (Array.isArray(props.ChildNodes) && props.ChildNodes.length > 0) childCounts[i] = props.ChildNodes.length;
      else childCounts[i] = 1;
    }

    // Initialize nodeMap
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

    // Build parentToChildren preserving slot order
    for (let i = 0; i < normalizedArr.length; i++) {
      const props = normalizedArr[i].Properties || {};
      const children = Array.isArray(props.ChildNodes) ? props.ChildNodes : [];
      parentToChildren[i] = [];
      for (let ci = 0; ci < children.length; ci++) {
        const ref = children[ci];
        const op = ref?.ObjectPath || ref?.ObjectName || ref;
        const idx = parseRefIndex(op);
        parentToChildren[i].push(idx ?? null);
        if (idx != null) {
          childToParents[idx] = childToParents[idx] || [];
          childToParents[idx].push(i);
        }
      }
    }

    // roots
    const allIndices = normalizedArr.map((_, i) => i);
    const roots = allIndices.filter(i => !(i in childToParents));
    const layoutRoots = roots.length ? roots : [0];

    // layout consts
    const xStep = 420;
    const yStep = 250;
    const regionGap = 800;

    // compute subtree heights
    const visited = new Array(normalizedArr.length).fill(false);
    function dfsHeight(idx) {
      if (visited[idx]) return nodeMap[idx].subtreeHeight;
      const children = parentToChildren[idx] || [];
      if (!children.length) {
        nodeMap[idx].subtreeHeight = 1;
        visited[idx] = true;
        return 1;
      }
      let total = 0;
      for (const c of children) {
        if (c == null) total += 1;
        else total += Math.max(1, dfsHeight(c));
      }
      nodeMap[idx].subtreeHeight = Math.max(1, total);
      visited[idx] = true;
      return nodeMap[idx].subtreeHeight;
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

    // assign lanes recursively
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

    // lane->Y mapping
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

    // depth map BFS
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

    // assign positions (root on right)
    for (const k of Object.keys(nodeMap)) {
      const n = nodeMap[k];
      n.posX = (maxDepth - (depthMap[k] || 0)) * xStep;
      if (n.laneIndices && n.laneIndices.length > 0) {
        const sum = n.laneIndices.reduce((s, li) => s + laneToY(li), 0);
        n.posY = Math.round(sum / n.laneIndices.length);
      } else n.posY = 0;
    }

    // per-column collision reduction
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
    const allYs = Object.values(nodeMap).map(n => n.posY);
    const finalMin = allYs.length ? Math.min(...allYs) : 0;
    const finalMax = allYs.length ? Math.max(...allYs) : 0;
    const finalMid = (finalMin + finalMax) / 2;
    for (const nm of Object.values(nodeMap)) {
      nm.posY = Math.round(nm.posY - finalMid);
      nm.posX = Math.round(nm.posX);
    }

    return { arr: normalizedArr, exportBasePath, nodeMap, parentToChildren };
  }

  // ---------------------------
  // Serialize with comment fields at graph-node level
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

      // Build inner engine object block
      let inner = '';
      inner += `   Begin Object Class=/Script/Engine.${engineType} Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'">\n`;
      inner += `   End Object\n`;
      inner += `   Begin Object Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'\n`;

      // We'll collect comment text for placement at graph-node level
      let nodeCommentText = '';
      let willHaveComment = true; // we will always write bubble visible (user asked for visible bubble)

      // Handle specific node types
      if (engineType === 'SoundNodeAttenuation') {
        const found = findAttenuationPathFromProps(props);
        const attenuationPath = found || '/Game/Sounds/Attenuation/Default_Attenuation.Default_Attenuation';
        inner += `      AttenuationSettings="/Script/Engine.SoundAttenuation'${attenuationPath}'"\n`;
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
        nodeCommentText = assetNameFromPath(attenuationPath) || '';
      } else if (engineType === 'SoundNodeWavePlayer') {
        // resolve sound wave
        let resolved = null;
        if ('SoundWaveAssetPtr' in props) {
          const v = props.SoundWaveAssetPtr;
          if (typeof v === 'string') resolved = v;
          else if (v && typeof v === 'object' && v.AssetPathName) resolved = v.AssetPathName;
        }
        if (!resolved && 'SoundWave' in props) {
          const sw = props.SoundWave;
          if (typeof sw === 'string') resolved = sw.replace(/\.\d+$/, '');
          else if (sw && typeof sw === 'object' && sw.ObjectPath) resolved = sw.ObjectPath.replace(/\.\d+$/, '');
        }
        if (!resolved && el && el.SoundWave && el.SoundWave.ObjectPath) {
          resolved = el.SoundWave.ObjectPath.replace(/\.\d+$/, '');
        }
        if (resolved && !resolved.includes('.')) {
          const last = resolved.split('/').pop();
          resolved = `${resolved}.${last}`;
        }
        if (resolved) inner += `      SoundWaveAssetPtr="${resolved}"\n`;
        else inner += `      /* SoundWaveAssetPtr unresolved for this WavePlayer */\n`;
        inner += `      bLooping=${props.bLooping ? 'True' : 'False'}\n`;
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
        nodeCommentText = assetNameFromPath(resolved) || '';
      } else {
        if (engineType === 'SoundNodeMixer' && Array.isArray(props.InputVolume)) {
          for (let vi = 0; vi < props.InputVolume.length; vi++) {
            const val = Number(props.InputVolume[vi]) || 0;
            inner += `      InputVolume(${vi})=${val.toFixed(6)}\n`;
          }
        }
        if (engineType === 'SoundNodeModulator') {
          if (props.PitchMin !== undefined) inner += `      PitchMin=${Number(props.PitchMin).toFixed(6)}\n`;
          if (props.PitchMax !== undefined) inner += `      PitchMax=${Number(props.PitchMax).toFixed(6)}\n`;
        }
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
        nodeCommentText = '';
      }

      // ChildNodes
      const children = parentToChildren[i] || [];
      for (let ci = 0; ci < children.length; ci++) {
        const cIdx = children[ci];
        if (cIdx == null) inner += `      /* ChildNodes(${ci}) unresolved */\n`;
        else {
          const child = nodeMap[cIdx];
          const childPath = `/Script/Engine.${child.soundNodeType}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${cIdx}.${child.soundNodeName}'`;
          inner += `      ChildNodes(${ci})="${childPath}"\n`;
        }
      }

      inner += `   End Object\n`;

      // Build the graph-node wrapper (with NodePosX/Y and comment fields at the same level as NodeGuid)
      let block = '';
      block += graphNodeHeader(i);
      block += inner;
      block += `   SoundNode="/Script/Engine.${engineType}'${nodeName}'"\n`;
      block += `   NodePosX=${map.posX}\n`;
      block += `   NodePosY=${map.posY}\n`;

      // Insert the comment bubble fields HERE (same level as NodeGuid) for WavePlayers & Attenuation
      // For others, still write visible bubble with empty comment (per user preference)
      const safeComment = String(nodeCommentText || '').replace(/"/g, '\\"');
      block += `   bCommentBubbleVisible=True\n`;
      block += `   NodeComment="${safeComment}"\n`;

      // NodeGuid next
      block += `   NodeGuid=${map.nodeGuid}\n`;

      // Output pin placeholder
      block += `   CustomProperties Pin (PinId=${map.outputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(),PersistentGuid=00000000000000000000000000000000,)\n`;

      // Input pins
      for (let ci = 0; ci < map.inputPinIds.length; ci++) {
        const label = ci === 0 ? 'Input' : `Input${ci + 1}`;
        block += `   CustomProperties Pin (PinId=${map.inputPinIds[ci]},PinName="${label}",PinFriendlyName=" ",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(),PersistentGuid=00000000000000000000000000000000,)\n`;
      }

      block += `End Object\n\n`;
      blocks[i] = block;
    }

    // Combine blocks
    let combined = blocks.join('');

    // Populate LinkedTo mapping per-slot
    for (const [pStr, children] of Object.entries(parentToChildren)) {
      const p = Number(pStr);
      const pMap = nodeMap[p];
      for (let s = 0; s < children.length; s++) {
        const cIdx = children[s];
        if (cIdx == null) continue;
        const cMap = nodeMap[cIdx];

        const parentPinId = pMap.inputPinIds[s];
        const childOutputPinId = cMap.outputPinId;

        // parent input: set LinkedTo
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
          // fallback: replace bare output pin line
          const fallbackOutPinRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childOutputPinId)}[^\\n]*\\)\\n`, 'm');
          combined = combined.replace(fallbackOutPinRe, `   CustomProperties Pin (PinId=${childOutputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",LinkedTo=(SoundCueGraphNode_${p} ${parentPinId},),PersistentGuid=00000000000000000000000000000000,)\n`);
        }
      }
    }

    return combined;
  }

  // Top-level conversion
  function convertSoundCueJsonFull(json, includeGuids = true) {
    const arr = Array.isArray(json) ? json : (json.Exports || json);
    if (!arr || !arr.length) throw new Error('Invalid JSON: expected array or Exports');
    const struct = buildLayoutAndMetadata(arr, includeGuids);
    const out = finalizeExport(struct);
    return out;
  }

  // expose
  window.convertSoundCueJsonFull = convertSoundCueJsonFull;
  window.convertSoundCueJson = convertSoundCueJsonFull;
})();
