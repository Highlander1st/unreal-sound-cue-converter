// script.js
// Updated SoundCue JSON -> Unreal SoundCueGraph exporter (full-hierarchy, per-child input slots, bi-directional LinkedTo)
// Save this file as script.js. Open index.html in a browser to use.

(() => {
  const fileInput = document.getElementById('jsonFile');
  const convertBtn = document.getElementById('convertBtn');
  const output = document.getElementById('output');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const includeGuidsCheckbox = document.getElementById('includeGuids');

  let lastResult = '';

  fileInput.addEventListener('change', () => {
    convertBtn.disabled = fileInput.files.length === 0;
  });

  convertBtn.addEventListener('click', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const text = await f.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      output.value = 'ERROR: invalid JSON - ' + e.message;
      return;
    }

    try {
      lastResult = convertSoundCueJson(json, includeGuidsCheckbox.checked);
      output.value = lastResult;
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
    } catch (e) {
      output.value = 'ERROR during conversion: ' + e.message + '\n' + (e.stack || '');
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy Output', 1400);
    } catch (e) {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => copyBtn.textContent = 'Copy Output', 1400);
    }
  });

  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([lastResult], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Converted_SoundCueGraph.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- Core conversion logic ----------
  function convertSoundCueJson(arr, includeGuids = true) {
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('JSON must be a non-empty array.');
    const cueObjectIndex = arr.findIndex(o => o.Type === 'SoundCue');
    if (cueObjectIndex === -1) throw new Error('No root SoundCue object found in JSON.');
    const cueObj = arr[cueObjectIndex];

    // derive exportBasePath from FirstNode.ObjectPath or fallback to cue name
    let exportBasePath = '/Game/NewSoundCue.NewSoundCue';
    try {
      const fp = (cueObj.Properties && cueObj.Properties.FirstNode && (cueObj.Properties.FirstNode.ObjectPath || cueObj.Properties.FirstNode.ObjectName)) || null;
      if (fp) {
        let base = String(fp).replace(/\.\d+$/, '');
        const lastName = base.split('/').pop() || 'NewSoundCue';
        exportBasePath = `${base}.${lastName}`;
      } else {
        const nm = cueObj.Name || 'NewSoundCue';
        exportBasePath = `/Game/${nm}.${nm}`;
      }
    } catch (e) {
      console.warn('failed to get cue path, using fallback', e);
    }

    // ----- pre-scan: compute child counts and create nodeMap entries -----
    const nodeMap = {}; // idx -> { graphIndex, soundNodeName, soundNodeType, nodeGuid, outputPinId, inputPinIds:[] }
    let graphCounter = 0;
    const typeCounters = {};

    function nextGraphIndex(){ return graphCounter++; }
    function nextSoundNodeName(type){
      typeCounters[type] = (typeCounters[type] || 0) + 1;
      return `${type}_${typeCounters[type]-1}`;
    }

    // helper to parse reference index from ObjectPath or ObjectName
    function parseRefIndex(opath){
      if (!opath) return null;
      const s = String(opath);
      const m = s.match(/\.([0-9]+)$/);
      if (m) return parseInt(m[1],10);
      // also handle patterns like '...:SoundCueGraphNode_3.SoundNodeMixer_0' (not typical) -> ignore
      return null;
    }

    // pre-scan compute child counts for each node (use ChildNodes length if present)
    const childCounts = new Array(arr.length).fill(0);
    for (let i=0;i<arr.length;i++){
      const props = arr[i].Properties || {};
      if (Array.isArray(props.ChildNodes) && props.ChildNodes.length>0) {
        childCounts[i] = props.ChildNodes.length;
      } else {
        // default to 1 input for nodes that typically accept an input
        childCounts[i] = 1;
      }
    }

    for (let i=0;i<arr.length;i++){
      const el = arr[i];
      const t = el.Type || 'SoundNodeUnknown';
      const gIdx = nextGraphIndex();
      const nodeName = nextSoundNodeName(t);
      nodeMap[i] = {
        graphIndex: gIdx,
        soundNodeName: nodeName,
        soundNodeType: t,
        nodeGuid: includeGuids ? randomGuid() : '00000000000000000000000000000000',
        outputPinId: randomHex(32),
        inputPinIds: new Array(childCounts[i]).fill(null).map(()=>randomHex(32))
      };
    }

    // helpers for formatting
    function graphNodeHeader(graphIndex){
      return `Begin Object Class=/Script/AudioEditor.SoundCueGraphNode Name="SoundCueGraphNode_${graphIndex}" ExportPath="/Script/AudioEditor.SoundCueGraphNode'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${graphIndex}'"\n`;
    }
    function soundNodeExportPath(engineClass, graphIndex, soundNodeName){
      return `/Script/Engine.${engineClass}'${exportBasePath}:SoundCueGraph_0.SoundCueGraphNode_${graphIndex}.${soundNodeName}'`;
    }
    function renderBool(b){ return b ? 'True' : 'False'; }

    // Build blocks for each node
    const blocks = new Array(arr.length).fill(null);
    for (let i=0;i<arr.length;i++){
      const el = arr[i];
      const map = nodeMap[i];
      const gIdx = map.graphIndex;
      const soundNodeName = map.soundNodeName;
      const soundNodeType = el.Type || 'SoundNodeUnknown';
      const props = el.Properties || {};

      let block = '';
      block += graphNodeHeader(gIdx);

      // Determine engine class
      let engineClass = null;
      if (soundNodeType === 'SoundNodeWavePlayer') engineClass = 'SoundNodeWavePlayer';
      else if (soundNodeType === 'SoundNodeModulator') engineClass = 'SoundNodeModulator';
      else if (soundNodeType === 'SoundNodeMixer') engineClass = 'SoundNodeMixer';
      else if (soundNodeType === 'SoundNodeAttenuation') engineClass = 'SoundNodeAttenuation';
      else if (soundNodeType === 'SoundNodeSoundClass') engineClass = 'SoundNodeSoundClass';
      else if (soundNodeType === 'SoundNodeRandom') engineClass = 'SoundNodeRandom';
      else if (el.Type === 'SoundCue') engineClass = null; // root cue object — no engine node type to create
      else {
        // fallback: try to use the Type directly if it looks like an Engine class
        engineClass = soundNodeType;
      }

      if (engineClass) {
        block += `   Begin Object Class=/Script/Engine.${engineClass} Name="${soundNodeName}" ExportPath="${soundNodeExportPath(engineClass,gIdx,soundNodeName)}'\">\n`;
        block += `   End Object\n`;
      }

      block += `   Begin Object Name="${soundNodeName}" ExportPath="${soundNodeExportPath(engineClass,gIdx,soundNodeName)}'\n`;

      // Type-specific properties
      if (engineClass === 'SoundNodeWavePlayer') {
        // get path from various possible locations
        let path = null;
        if (props.SoundWaveAssetPtr) {
          if (typeof props.SoundWaveAssetPtr === 'string') path = props.SoundWaveAssetPtr;
          else if (typeof props.SoundWaveAssetPtr === 'object' && props.SoundWaveAssetPtr.AssetPathName) path = props.SoundWaveAssetPtr.AssetPathName;
        }
        if (!path && props.SoundWave && props.SoundWave.ObjectPath) {
          path = props.SoundWave.ObjectPath.replace(/\.\d+$/, '');
          const last = path.split('/').pop(); path = `${path}.${last}`;
        }
        if (!path && el.SoundWave && el.SoundWave.ObjectPath) {
          path = el.SoundWave.ObjectPath.replace(/\.\d+$/, '');
          const last = path.split('/').pop(); path = `${path}.${last}`;
        }
        if (path) {
          if (!path.includes('.')) {
            const last = path.split('/').pop();
            path = `${path}.${last}`;
          }
          block += `      SoundWaveAssetPtr="${path}"\n`;
        } else {
          block += `      /* SoundWaveAssetPtr unresolved for this WavePlayer */\n`;
        }

        block += `      bLooping=${renderBool(props.bLooping !== undefined ? props.bLooping : true)}\n`;
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      }
      else if (engineClass === 'SoundNodeModulator') {
        if (props.PitchMin !== undefined) block += `      PitchMin=${Number(props.PitchMin).toFixed(6)}\n`;
        if (props.PitchMax !== undefined) block += `      PitchMax=${Number(props.PitchMax).toFixed(6)}\n`;
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      }
      else if (engineClass === 'SoundNodeMixer') {
        if (Array.isArray(props.InputVolume)) {
          for (let vi=0; vi<props.InputVolume.length; vi++){
            block += `      InputVolume(${vi})=${Number(props.InputVolume[vi]).toFixed(6)}\n`;
          }
        }
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      }
      else if (engineClass === 'SoundNodeAttenuation') {
        if (props.AttenuationSettings && (props.AttenuationSettings.ObjectPath || props.AttenuationSettings.ObjectName)) {
          const ap = props.AttenuationSettings.ObjectPath || props.AttenuationSettings.ObjectName;
          const attPath = (typeof ap === 'string') ? ap.replace(/\.\d+$/, '') : String(ap);
          block += `      AttenuationSettings=(ObjectName="${props.AttenuationSettings.ObjectName || ''}",ObjectPath="${attPath}")\n`;
        }
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      }
      else if (engineClass === 'SoundNodeSoundClass') {
        if (props.SoundClassOverride && (props.SoundClassOverride.ObjectPath || props.SoundClassOverride.ObjectName)) {
          const scp = (props.SoundClassOverride.ObjectPath || props.SoundClassOverride.ObjectName).replace(/\.\d+$/, '');
          block += `      SoundClassOverride=(ObjectName="${props.SoundClassOverride.ObjectName || ''}",ObjectPath="${scp}")\n`;
        }
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      } else {
        // generic
        if (props.bLooping !== undefined) block += `      bLooping=${renderBool(props.bLooping)}\n`;
        if (Array.isArray(props.InputVolume)) {
          for (let vi=0; vi<props.InputVolume.length; vi++){
            block += `      InputVolume(${vi})=${Number(props.InputVolume[vi]).toFixed(6)}\n`;
          }
        }
        block += `      GraphNode="/Script/AudioEditor.SoundCueGraphNode'SoundCueGraphNode_${gIdx}'"\n`;
      }

      // ChildNodes property listing in the node object (references to child nodes)
      if (Array.isArray(props.ChildNodes) && props.ChildNodes.length>0) {
        for (let ci=0; ci<props.ChildNodes.length; ci++){
          const childRef = props.ChildNodes[ci];
          const op = childRef && (childRef.ObjectPath || childRef.ObjectName || childRef);
          const idx = parseRefIndex(op);
          if (idx === null || nodeMap[idx]===undefined) {
            block += `      /* ChildNodes(${ci}) unresolved: ${String(op)} */\n`;
          } else {
            const target = nodeMap[idx];
            const childEngineType = arr[idx].Type || 'SoundNodeWavePlayer';
            const childName = target.soundNodeName;
            const childGraphIndex = target.graphIndex;
            const childPath = `/Script/Engine.${childEngineType}'SoundCueGraphNode_${childGraphIndex}.${childName}'`;
            block += `      ChildNodes(${ci})="${childPath}"\n`;
          }
        }
      }

      // End inner object
      block += `   End Object\n`;

      // SoundNode pointer
      if (engineClass) {
        block += `   SoundNode="/Script/Engine.${engineClass}'${soundNodeName}'"\n`;
      } else {
        block += `   /* No engine class assigned for this node (type: ${el.Type}) */\n`;
      }

      // NodePosX/Y and NodeGuid
      block += `   NodePosX=${(Math.floor(Math.random()*1600)-800)}\n`;
      block += `   NodePosY=${(Math.floor(Math.random()*900)-450)}\n`;
      block += `   NodeGuid=${map.nodeGuid}\n`;

      // Output pin line (initially with empty LinkedTo; we'll populate later)
      block += `   CustomProperties Pin (PinId=${map.outputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,LinkedTo=(),PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)\n`;

      // Generate Input pins per expected child slot. Labels: Input, Input2, Input3...
      for (let ci=0; ci<map.inputPinIds.length; ci++){
        const pinLabel = (ci === 0) ? 'Input' : `Input${ci+1}`;
        const pinId = map.inputPinIds[ci];
        block += `   CustomProperties Pin (PinId=${pinId},PinName="${pinLabel}",PinFriendlyName=" ",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,LinkedTo=(),PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)\n`;
      }

      block += `End Object\n\n`;

      blocks[i] = { index: i, text: block };
    }

    // Build parent->children map (using indices from ChildNodes)
    const parentToChildren = {}; // parentIdx -> [childIdx,...] in order
    for (let i=0;i<arr.length;i++){
      const props = arr[i].Properties || {};
      if (Array.isArray(props.ChildNodes) && props.ChildNodes.length>0){
        parentToChildren[i] = [];
        for (let ci=0; ci<props.ChildNodes.length; ci++){
          const cr = props.ChildNodes[ci];
          const op = cr && (cr.ObjectPath || cr.ObjectName || cr);
          const idx = parseRefIndex(op);
          if (idx !== null && nodeMap[idx]) parentToChildren[i].push(idx);
          else parentToChildren[i].push(null); // preserve slot index even if unresolved
        }
      }
    }

    // Combine blocks into one string
    let combined = blocks.map(b=>b.text).join('');

    // Now populate LinkedTo fields.
    // For each parent, for each child slot index, find that child's outputPinId and fill parent's input pin LinkedTo to reference (SoundCueGraphNode_childGraphIndex childOutputPinId,)
    for (const [parentStr, children] of Object.entries(parentToChildren)) {
      const parentIdx = Number(parentStr);
      for (let slotIndex=0; slotIndex<children.length; slotIndex++){
        const childIdx = children[slotIndex];
        const parentMap = nodeMap[parentIdx];
        const parentInputPinId = parentMap.inputPinIds[slotIndex];
        if (childIdx === null) {
          // unresolved child reference; leave comment as-is
          continue;
        }
        const childMap = nodeMap[childIdx];

        // 1) Replace parent's Input pin LinkedTo=() => LinkedTo=(SoundCueGraphNode_childGraphIndex childOutputPinId,)
        const parentInputPinLineRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(parentInputPinId)}[^\\n]*LinkedTo=\\(\\)`, 'm');
        const parentLinkedToValue = `LinkedTo=(SoundCueGraphNode_${childMap.graphIndex} ${childMap.outputPinId},)`;
        combined = combined.replace(parentInputPinLineRe, match => match.replace('LinkedTo=()', parentLinkedToValue));

        // 2) Add parent reference into child's Output pin LinkedTo list.
        // Find child's output pin line and insert parent ref inside its LinkedTo tuple.
        const childOutputPinLineRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childMap.outputPinId)}[^\\n]*LinkedTo=\\(([^\\)]*)\\)`, 'm');
        const parentRefText = `SoundCueGraphNode_${parentMap.graphIndex} ${parentInputPinId},`;
        const childMatch = combined.match(childOutputPinLineRe);
        if (childMatch) {
          const existing = childMatch[1] || '';
          const newInner = existing + parentRefText;
          combined = combined.replace(childOutputPinLineRe, `CustomProperties Pin (PinId=${childMap.outputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,LinkedTo=(${newInner})`);
        } else {
          // if not found, attempt simpler replacement of LinkedTo=() line
          const fallbackRe = new RegExp(`CustomProperties Pin \\(PinId=${escapeRegex(childMap.outputPinId)}[^\\n]*\\)\\n`);
          combined = combined.replace(fallbackRe, match => {
            // insert a new LinkedTo line after the Output pin line by re-creating the Output pin with LinkedTo filled
            const replacement = `   CustomProperties Pin (PinId=${childMap.outputPinId},PinName="Output",Direction="EGPD_Output",PinType.PinCategory="SoundNode",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,LinkedTo=(SoundCueGraphNode_${parentMap.graphIndex} ${parentInputPinId},),PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)\n`;
            return replacement;
          });
        }
      }
    }

    // Small cleanup: ensure the per-node ChildNodes(...) entries use the correct full path format (we already produced them).
    // Return combined
    return combined;
  }

  // ---------- Utilities ----------
  function randomGuid(){
    // 32 hex uppercase, like earlier outputs
    const s = [];
    for (let i=0;i<32;i++){
      s.push('0123456789ABCDEF'[Math.floor(Math.random()*16)]);
    }
    return s.join('');
  }

  function randomHex(len){
    let s='';
    for (let i=0;i<len;i++){
      s += '0123456789ABCDEF'[Math.floor(Math.random()*16)];
    }
    return s;
  }

  function escapeRegex(str){
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

})();
