// script.js
// SoundCue JSON -> Unreal SoundCueGraph converter
// Updated: removes dead SoundCue wrapper node and restricts comment bubbles to WavePlayer/Attenuation/final node "Output".
// Preserves: layout, pin linking, attenuation fallback, modulator/delay/enveloper/random support, six-decimal formatting.

(() => {
  // ---------------------------
  // UI bindings (expected present in HTML)
  // ---------------------------
  const fileInput = document.getElementById('jsonFile');
  const convertBtn = document.getElementById('convertBtn');
  const outputEl = document.getElementById('output');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const includeGuidsCheckbox = document.getElementById('includeGuids');

  let lastResultText = '';

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (convertBtn) convertBtn.disabled = fileInput.files.length === 0;
    });
  }
  if (convertBtn) {
    convertBtn.addEventListener('click', async () => {
      const f = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (!f) return;
      try {
        const raw = await f.text();
        let json;
        try {
          json = JSON.parse(raw);
        } catch (err) {
          if (outputEl) outputEl.value = `ERROR: Invalid JSON — ${err.message}`;
          return;
        }
        try {
          const includeGuids = !!(includeGuidsCheckbox && includeGuidsCheckbox.checked);
          lastResultText = convertSoundCueJsonFull(json, includeGuids);
          if (outputEl) outputEl.value = lastResultText;
          if (copyBtn) copyBtn.disabled = false;
          if (downloadBtn) downloadBtn.disabled = false;
        } catch (err) {
          if (outputEl) outputEl.value = `ERROR during conversion: ${err.message}\n${err.stack || ''}`;
          if (copyBtn) copyBtn.disabled = true;
          if (downloadBtn) downloadBtn.disabled = true;
        }
      } catch (err) {
        if (outputEl) outputEl.value = `ERROR reading file: ${err.message}`;
      }
    });
  }
  if (copyBtn) {
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
  }
  if (downloadBtn) {
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
  }

  // ---------------------------
  // Utility helpers
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
  function float6(v) {
    if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
    return Number(v).toFixed(6);
  }

  // ---------------------------
  // Asset detection heuristics
  // ---------------------------
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
        if (s.includes('/Game/') || s.includes('/Vivid') || s.includes('/')) {
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
          if (p.includes('/Game/') || p.includes('/Vivid') || p.includes('/')) {
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
  // Enveloper curve helpers
  // ---------------------------
  function serializeCurveKey(key) {
    const parts = [];
    if ('InterpMode' in key && key.InterpMode != null) parts.push(`InterpMode=${key.InterpMode}`);
    if ('TangentMode' in key && key.TangentMode != null) parts.push(`TangentMode=${key.TangentMode}`);
    if ('TangentWeightMode' in key && key.TangentWeightMode != null) parts.push(`TangentWeightMode=${key.TangentWeightMode}`);
    if ('Time' in key && key.Time != null) parts.push(`Time=${float6(key.Time)}`);
    if ('Value' in key && key.Value != null) parts.push(`Value=${float6(key.Value)}`);
    if ('ArriveTangent' in key && key.ArriveTangent != null) parts.push(`ArriveTangent=${float6(key.ArriveTangent)}`);
    if ('ArriveTangentWeight' in key && key.ArriveTangentWeight != null) parts.push(`ArriveTangentWeight=${float6(key.ArriveTangentWeight)}`);
    if ('LeaveTangent' in key && key.LeaveTangent != null) parts.push(`LeaveTangent=${float6(key.LeaveTangent)}`);
    if ('LeaveTangentWeight' in key && key.LeaveTangentWeight != null) parts.push(`LeaveTangentWeight=${float6(key.LeaveTangentWeight)}`);
    return `(${parts.join(',')})`;
  }
  function serializeCurve(editorCurveData) {
    if (!editorCurveData) return null;
    const keys = editorCurveData.Keys || [];
    if (!Array.isArray(keys) || keys.length === 0) return null;
    const serializedKeys = keys.map(k => serializeCurveKey(k)).join(',');
    return `(EditorCurveData=(Keys=(${serializedKeys})))`;
  }

  // ---------------------------
  // Layout & metadata (lane sorting)
  // ---------------------------
  function buildLayoutAndMetadata(arr, includeGuids = true) {
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Input must be a non-empty array.');

    const normalizedArr = Array.isArray(arr) ? arr : (arr.Exports || arr);

    // try to find export base path
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

    // precompute child counts
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
        if (idx != null) {
          childToParents[idx] = childToParents[idx] || [];
          childToParents[idx].push(i);
        }
      }
    }

    // roots = nodes with no parents (final nodes)
    const allIndices = normalizedArr.map((_, i) => i);
    const roots = allIndices.filter(i => !(i in childToParents));
    const layoutRoots = roots.length ? roots : [0];

    // layout constants
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

    // assign lanes recursively preserving slot order
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

    // per-column anti-overlap
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

    return { arr: normalizedArr, exportBasePath, nodeMap, parentToChildren, roots: layoutRoots };
  }

  // ---------------------------
  // Final serialization (all nodes) - with dead-node removal and comment rules
  // ---------------------------
  function finalizeExport({ arr, exportBasePath, nodeMap, parentToChildren, roots }) {
    function graphNodeHeader(i) {
      return `Begin Object Class=/Script/AudioEditor.SoundCueGraphNode Name="SoundCueGraphNode_${i}" ExportPath="/Script/AudioEditor.SoundCueGraphNode'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${i}'"\n`;
    }
    function engineExportPath(engineClass, idx, nodeName) {
      return `/Script/Engine.${engineClass}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${idx}.${nodeName}'`;
    }

    // Determine hasParent quickly
    const hasParent = new Array(arr.length).fill(false);
    for (const [pStr, children] of Object.entries(parentToChildren)) {
      const p = Number(pStr);
      for (const c of children) {
        if (c != null) hasParent[c] = true;
      }
    }
    // roots array passed in; but recalc safety
    const rootsSet = new Set(roots || []);
    // We'll use rootsSet to mark final nodes — write "Output" there.

    const blocks = new Array(arr.length).fill('');
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      const map = nodeMap[i];
      const props = el.Properties || {};
      const engineType = el.Type || 'SoundNodeUnknown';
      const nodeName = map.soundNodeName;

      // If the element is the SoundCue wrapper, skip generating it entirely (dead node removal).
      // condition: Type contains 'SoundCue' OR engineType contains 'SoundCue'
      const typeLower = String(engineType).toLowerCase();
      const elTypeLower = String(el.Type || '').toLowerCase();
      if (elTypeLower.includes('soundcue') || typeLower.includes('soundcue')) {
        // produce an empty placeholder (no graph node block) so indices remain stable
        blocks[i] = '';
        continue;
      }

      // Begin building inner object
      let inner = '';
      inner += `   Begin Object Class=/Script/Engine.${engineType} Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'">\n`;
      inner += `   End Object\n`;
      inner += `   Begin Object Name="${nodeName}" ExportPath="${engineExportPath(engineType, i, nodeName)}'\n`;

      // Determine comment bubble and comment text rules:
      // Only WavePlayer & Attenuation get their asset short names as comment.
      // Roots (final nodes) get NodeComment "Output" and bubble enabled.
      // Everything else has bubble disabled and empty comment.

      let nodeCommentText = '';
      let bubbleVisible = false;

      if (rootsSet.has(i)) {
        // this is a final node -> Output - override everything
        bubbleVisible = true;
        nodeCommentText = 'Output';
      } else if (engineType === 'SoundNodeWavePlayer') {
        bubbleVisible = true;
      } else if (engineType === 'SoundNodeAttenuation') {
        bubbleVisible = true;
      } else {
        bubbleVisible = false;
      }

      // Node-specific inner content
      if (engineType === 'SoundNodeEnveloper') {
        if (props.LoopStart !== undefined) inner += `      LoopStart=${float6(props.LoopStart)}\n`;
        if (props.LoopEnd !== undefined) inner += `      LoopEnd=${float6(props.LoopEnd)}\n`;
        if (props.DurationAfterLoop !== undefined) inner += `      DurationAfterLoop=${float6(props.DurationAfterLoop)}\n`;
        if (props.LoopCount !== undefined) inner += `      LoopCount=${Number(props.LoopCount)}\n`;
        if (props.bLoopIndefinitely !== undefined) inner += `      bLoopIndefinitely=${props.bLoopIndefinitely ? 'True' : 'False'}\n`;
        if (props.bLoop !== undefined) inner += `      bLoop=${props.bLoop ? 'True' : 'False'}\n`;

        const volumeCurveObj = (props.VolumeCurve && (props.VolumeCurve.EditorCurveData || props.VolumeCurve)) || null;
        const pitchCurveObj = (props.PitchCurve && (props.PitchCurve.EditorCurveData || props.PitchCurve)) || null;
        const volSer = serializeCurve(volumeCurveObj);
        const pitchSer = serializeCurve(pitchCurveObj);
        if (volSer) inner += `      VolumeCurve=${volSer}\n`;
        if (pitchSer) inner += `      PitchCurve=${pitchSer}\n`;

        if (props.PitchMin !== undefined) inner += `      PitchMin=${float6(props.PitchMin)}\n`;
        if (props.PitchMax !== undefined) inner += `      PitchMax=${float6(props.PitchMax)}\n`;
        if (props.VolumeMin !== undefined) inner += `      VolumeMin=${float6(props.VolumeMin)}\n`;
        if (props.VolumeMax !== undefined) inner += `      VolumeMax=${float6(props.VolumeMax)}\n`;

        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else if (engineType === 'SoundNodeAttenuation') {
        const found = findAttenuationPathFromProps(props);
        const attenuationPath = found || '/Game/Sounds/Attenuation/Default_Attenuation.Default_Attenuation';
        inner += `      AttenuationSettings="/Script/Engine.SoundAttenuation'${attenuationPath}'"\n`;
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
        // If it's an attenuation node and not a root, NodeComment should show short name unless overridden by Output
        if (!rootsSet.has(i)) nodeCommentText = assetNameFromPath(attenuationPath) || '';
      } else if (engineType === 'SoundNodeWavePlayer') {
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
        // show short name if not root override
        if (!rootsSet.has(i)) nodeCommentText = assetNameFromPath(resolved) || '';
      } else if (engineType === 'SoundNodeModulator') {
        if (props.PitchMin !== undefined) inner += `      PitchMin=${float6(props.PitchMin)}\n`;
        if (props.PitchMax !== undefined) inner += `      PitchMax=${float6(props.PitchMax)}\n`;
        if (props.VolumeMin !== undefined) inner += `      VolumeMin=${float6(props.VolumeMin)}\n`;
        if (props.VolumeMax !== undefined) inner += `      VolumeMax=${float6(props.VolumeMax)}\n`;
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else if (engineType === 'SoundNodeDelay') {
        if (props.DelayMin !== undefined) inner += `      DelayMin=${float6(props.DelayMin)}\n`;
        if (props.DelayMax !== undefined) inner += `      DelayMax=${float6(props.DelayMax)}\n`;
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else if (engineType === 'SoundNodeRandom') {
        const weights = Array.isArray(props.Weights) ? props.Weights : (props.WeightArray || null);
        if (weights && Array.isArray(weights)) {
          for (let wi = 0; wi < weights.length; wi++) {
            inner += `      Weights(${wi})=${float6(weights[wi])}\n`;
          }
        }
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else if (engineType === 'SoundNodeMixer') {
        if (Array.isArray(props.InputVolume)) {
          for (let vi = 0; vi < props.InputVolume.length; vi++) {
            const val = Number(props.InputVolume[vi]) || 0;
            inner += `      InputVolume(${vi})=${val.toFixed(6)}\n`;
          }
        }
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      } else {
        // fallback
        inner += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${i}'"\n`;
      }

      // ChildNodes
      const children = parentToChildren[i] || [];
      for (let ci = 0; ci < children.length; ci++) {
        const cIdx = children[ci];
        if (cIdx == null) inner += `      ChildNodes(${ci})=None\n`;
        else {
          const child = nodeMap[cIdx];
          const childPath = `/Script/Engine.${child.soundNodeType}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${cIdx}.${child.soundNodeName}'`;
          inner += `      ChildNodes(${ci})="${childPath}"\n`;
        }
      }
      inner += `   End Object\n`;

      // Build graph-node wrapper
      let block = '';
      block += graphNodeHeader(i);
      block += inner;
      block += `   SoundNode="/Script/Engine.${engineType}'${nodeName}'"\n`;
      block += `   NodePosX=${map.posX}\n`;
      block += `   NodePosY=${map.posY}\n`;

      // Comment bubble preferences: only waveplayer, attenuation, or roots (Output)
      const bubbleFlag = !!bubbleVisible;
      const commentText = nodeCommentText || '';
      block += `   bCommentBubbleVisible=${bubbleFlag ? 'True' : 'False'}\n`;
      block += `   NodeComment="${String(commentText).replace(/"/g, '\\"')}"\n`;

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

    // Populate LinkedTo mapping (preserve original indices)
    for (const [pStr, children] of Object.entries(parentToChildren)) {
      const p = Number(pStr);
      // if p was a SoundCue wrapper, we generated an empty block for it — that's fine
      const pMap = nodeMap[p];
      for (let s = 0; s < children.length; s++) {
        const cIdx = children[s];
        if (cIdx == null) continue;
        const cMap = nodeMap[cIdx];

        const parentPinId = pMap.inputPinIds[s];
        const childOutputPinId = cMap.outputPinId;

        // update parent's input LinkedTo
        const parentInputRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(parentPinId)}[^\\)]*LinkedTo=\\(\\)`, 'm');
        const parentReplacement = `CustomProperties Pin (PinId=${parentPinId},PinName="${s===0 ? 'Input' : 'Input'+(s+1)}",PinFriendlyName=" ",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(SoundCueGraphNode_${cIdx} ${childOutputPinId},),PersistentGuid=00000000000000000000000000000000,)`;
        combined = combined.replace(parentInputRe, parentReplacement);

        // append parent ref to child's output LinkedTo
        const childOutputRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childOutputPinId)}[^\\)]*LinkedTo=\\(([^\\)]*)\\)`, 'm');
        const m = combined.match(childOutputRe);
        const parentRefText = `SoundCueGraphNode_${p} ${parentPinId},`;
        if (m) {
          const existingInner = m[1] || '';
          const newInner = existingInner + parentRefText;
          const replacement = `CustomProperties Pin (PinId=${childOutputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",LinkedTo=(${newInner}),PersistentGuid=00000000000000000000000000000000,)`;
          combined = combined.replace(childOutputRe, replacement);
        } else {
          const fallbackOutPinRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childOutputPinId)}[^\\n]*\\)\\n`, 'm');
          combined = combined.replace(fallbackOutPinRe, `   CustomProperties Pin (PinId=${childOutputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",LinkedTo=(SoundCueGraphNode_${p} ${parentPinId},),PersistentGuid=00000000000000000000000000000000,)\n`);
        }
      }
    }

    return combined;
  }

  // ---------------------------
  // Top-level conversion
  // ---------------------------
  function convertSoundCueJsonFull(json, includeGuids = true) {
    const arr = Array.isArray(json) ? json : (json.Exports || json);
    if (!arr || !arr.length) throw new Error('Invalid JSON: expected array or Exports');
    const struct = buildLayoutAndMetadata(arr, includeGuids);
    return finalizeExport(struct);
  }

  // Expose
  window.convertSoundCueJsonFull = convertSoundCueJsonFull;
  window.convertSoundCueJson = convertSoundCueJsonFull;
})();
