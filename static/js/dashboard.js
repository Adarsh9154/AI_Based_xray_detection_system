// static/js/dashboard.js
// Dashboard behavior for the enhanced dashboard HTML/CSS
// - Loads /api/stats, /api/recent
// - Updates KPIs, sparklines and the gradient volumeChart
// - AJAX upload to /predict (returns JSON)
// - Inline prediction card + auto-open detail modal
// - Simple pagination & search

(() => {
  // --- small helpers ---
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const noop = () => {};
  const esc = s => String(s || "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // --- DOM refs (must match the HTML you installed) ---
  const kTotal = $("#kpiTotal");
  const kFract = $("#kpiFractures");
  const kAcc = $("#kpiAcc");
  const kLat = $("#kpiLatency");

  const sparkTotal = document.getElementById("sparkTotal");
  const sparkFract = document.getElementById("sparkFract");
  const sparkAcc = document.getElementById("sparkAcc");
  const sparkLat = document.getElementById("sparkLat");

  const recentTbody = $("#recentTbody");
  const rowsCount = $("#rowsCount");
  const pageInfo = $("#pageInfo");
  const prevPage = $("#prevPage");
  const nextPage = $("#nextPage");
  const globalSearch = $("#globalSearch");

  const uploadForm = $("#uploadForm");
  const uploadBtn = $("#uploadBtn");
  const patientName = $("#patientName");
  const fileInput = $("#fileInput");
  const previewImg = $("#preview");

  const predCard = $("#predictionCard");
  const predLabel = predCard?.querySelector(".predLabel");
  const predPatient = predCard?.querySelector(".predPatient");
  const predConfidence = predCard?.querySelector(".predConfidence");
  const predTime = predCard?.querySelector(".predTime");
  const predDownload = $("#predictionDownload");
  const predViewBtn = $("#predictionViewBtn");

  const detailModalEl = $("#detailModal");
  const detailModal = detailModalEl ? new bootstrap.Modal(detailModalEl) : null;
  const detailImage = $("#detailImage");
  const detailScan = $("#detailScan");
  const detailPatient = $("#detailPatient");
  const detailLabel = $("#detailLabel");
  const detailConfidence = $("#detailConfidence");
  const detailTime = $("#detailTime");
  const detailInfer = $("#detailInfer");
  const detailDownload = $("#detailDownload");

  // --- state & config ---
  let allRows = [];
  let filtered = [];
  let page = 1;
  const perPage = 8;
  let sortKey = "timestamp";
  let sortDir = "desc";

  // chart vars
  let volumeChart = null;
  // small sparklines
  function makeSpark(canvasEl, dataArr=[]) {
    if (!canvasEl) return;
    try { if (canvasEl._c) canvasEl._c.destroy(); } catch(e){}
    const ctx = canvasEl.getContext("2d");
    canvasEl._c = new Chart(ctx, {
      type: "line",
      data: { labels: dataArr.map((_,i)=>i+1), datasets:[{data:dataArr, tension:0.35, borderWidth:1, pointRadius:0, fill:true}] },
      options: { plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}} }
    });
  }

  // init gradient volume chart (HTML contains init function, but we can init here too)
  function initVolumeChart(labels=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], values=[40,60,50,75,55,80,70]) {
    const canvas = document.getElementById("volumeChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0,0,0,canvas.height || 260);
    gradient.addColorStop(0, 'rgba(9,198,217,0.9)');
    gradient.addColorStop(0.4, 'rgba(9,198,217,0.35)');
    gradient.addColorStop(1, 'rgba(9,198,217,0.06)');

    if (volumeChart) try { volumeChart.destroy(); } catch(e){}
    volumeChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label:'Scans', data: values, fill:true, backgroundColor: gradient, borderColor: 'rgba(9,198,217,1)', tension:0.4, borderWidth:2, pointRadius:3 }] },
      options: { responsive:true, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}, ticks:{color:'#cfeff2'}}, y:{ticks:{color:'#cfeff2'}, beginAtZero:true } } }
    });
  }

  function updateVolumeChart(labels, values) {
    if (!volumeChart) return initVolumeChart(labels, values);
    volumeChart.data.labels = labels;
    volumeChart.data.datasets[0].data = values;
    volumeChart.update();
  }

  // --- Stats loader ---
  async function loadStats(){
    try{
      const r = await fetch("/api/stats");
      if (!r.ok) throw new Error("Failed to fetch /api/stats");
      const json = await r.json();
      kTotal && (kTotal.textContent = json.total_scans ?? "—");
      kFract && (kFract.textContent = json.fractures ?? "—");
      kAcc && (kAcc.textContent = json.model_accuracy != null ? (json.model_accuracy + "%") : "—");
      kLat && (kLat.textContent = json.avg_latency != null ? (json.avg_latency.toFixed(2)+"s") : "—");

      // update sparklines (the API may not return arrays — generate small synthetic ones)
      const gen = v => Array.from({length:7}, (_,i) => Math.max(0, (v||10) + Math.sin(i/2 + Math.random())*10 ));
      makeSpark(sparkTotal, gen(json.total_scans));
      makeSpark(sparkFract, gen(json.fractures));
      makeSpark(sparkAcc, gen(json.model_accuracy));
      makeSpark(sparkLat, gen(json.avg_latency));

      // if stats include weekly volume arrays, update main chart
      if (json.week_labels && json.week_values) updateVolumeChart(json.week_labels, json.week_values);
    }catch(e){
      console.warn("loadStats error:", e);
    }
  }

  // --- Fetch recent rows ---
  async function fetchRecent(n=200){
    try{
      const r = await fetch(`/api/recent?n=${n}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("Failed to fetch /api/recent");
      const json = await r.json();
      allRows = json.recent || [];
      applyFilters();
    }catch(e){ console.warn("fetchRecent error:", e); }
  }

  // --- Filtering / Sorting / Pagination ---
  function applyFilters(){
    const q = (globalSearch?.value || "").trim().toLowerCase();
    filtered = q ? allRows.filter(r => (r.scan_id||"").toLowerCase().includes(q) || (r.patient_name||"").toLowerCase().includes(q)) : allRows.slice();
    sortFiltered();
    page = 1;
    renderPage();
  }

  function sortFiltered(){
    filtered.sort((a,b) => {
      const A = a[sortKey], B = b[sortKey];
      if (sortKey === "confidence" || sortKey === "inference_time") return sortDir==="asc" ? (A-B) : (B-A);
      if (sortKey === "timestamp") return sortDir==="asc" ? (new Date(A)-new Date(B)) : (new Date(B)-new Date(A));
      return sortDir==="asc" ? String(A).localeCompare(String(B)) : String(B).localeCompare(String(A));
    });
  }

  function renderPage(){
    if (!recentTbody) return;
    recentTbody.innerHTML = "";
    const start = (page-1)*perPage;
    const pageRows = filtered.slice(start, start+perPage);
    pageRows.forEach(r => {
      const tr = document.createElement("tr");
      const badge = r.label === "Fractured" ? `<span class="badge-fracture">Fractured</span>` : `<span class="badge-normal">Normal</span>`;
      tr.innerHTML = `<td>${esc(r.scan_id)}</td><td>${esc(r.patient_name)}</td><td>${badge}</td><td>${r.confidence!=null?Number(r.confidence).toFixed(2):'—'}</td><td>${r.timestamp?new Date(r.timestamp).toLocaleString():'—'}</td>`;
      tr.addEventListener("click", ()=> openDetail(r));
      recentTbody.appendChild(tr);
    });
    rowsCount && (rowsCount.textContent = `${filtered.length} rows`);
    pageInfo && (pageInfo.textContent = `Page ${page} of ${Math.max(1, Math.ceil(filtered.length/perPage))}`);
  }

  prevPage?.addEventListener("click", ()=> { if (page>1){ page--; renderPage(); }});
  nextPage?.addEventListener("click", ()=> { if (page < Math.ceil(filtered.length/perPage)){ page++; renderPage(); }});

  // allow header click sorting (if you later add data-sort attrs)
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortKey === key) sortDir = (sortDir === "asc" ? "desc" : "asc"); else { sortKey = key; sortDir = "desc"; }
      sortFiltered(); renderPage();
    });
  });

  // search
  globalSearch?.addEventListener("input", () => { page = 1; applyFilters(); });

  // --- Detail modal ---
  function openDetail(row){
    if (!detailModal) return;
    detailImage.src = row.image_path || "/static/images/placeholder-xray.png";
    detailScan.textContent = row.scan_id || "";
    detailPatient.textContent = row.patient_name || "";
    detailLabel.textContent = row.label || "";
    detailConfidence.textContent = row.confidence != null ? row.confidence.toFixed(4) : "—";
    detailInfer.textContent = row.inference_time != null ? row.inference_time.toFixed(3) : "—";
    detailTime.textContent = row.timestamp ? new Date(row.timestamp).toLocaleString() : "—";

    const params = new URLSearchParams({
      prediction: row.label || "Unknown",
      accuracy: row.confidence!=null ? (row.confidence*100).toFixed(2) : "N/A",
      patient_name: row.patient_name || "",
      image_path: row.image_path || "",
      current_date: new Date().toLocaleDateString()
    });
    detailDownload.href = "/download_report?" + params.toString();

    detailModal.show();
  }

  // --- Upload handler (AJAX) ---
  if (uploadForm) {
    uploadForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();

      // patient name required
      const p = (patientName?.value || "").trim();
      if (!p) { patientName?.focus(); return; }
      if (!fileInput?.files?.length) { alert("Please choose an X-ray image"); return; }

      uploadBtn.disabled = true;
      const oldHtml = uploadBtn.innerHTML;
      uploadBtn.innerHTML = `<i class="bi bi-hourglass-split me-2"></i>Analyzing...`;

      const fd = new FormData();
      fd.append("patient_name", p);
      fd.append("file", fileInput.files[0]);

      try {
        const resp = await fetch(uploadForm.action || "/predict", {
          method: "POST", body: fd,
          headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" }
        });

        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (!resp.ok) {
          if (ct.includes("json")) {
            const j = await resp.json();
            throw new Error(j.error || JSON.stringify(j));
          } else {
            const txt = await resp.text();
            console.error("Server HTML error:", txt);
            throw new Error("Server error (check logs)");
          }
        }
        if (!ct.includes("json")) {
          const txt = await resp.text();
          console.warn("Server returned HTML (expected JSON). First 400 chars:", txt.slice(0,400));
          throw new Error("Server returned HTML instead of JSON");
        }

        const data = await resp.json();

        // update preview
        if (previewImg && data.image_path) previewImg.src = data.image_path;

        // push new row to state
        const newRow = {
          scan_id: data.id || data.scan_id || ("A"+Date.now()),
          patient_name: data.patient_name || p,
          label: data.label || "",
          confidence: data.confidence != null ? Number(data.confidence) : (data.confidence_pct ? Number(data.confidence_pct)/100.0 : null),
          inference_time: data.inference_time ?? null,
          image_path: data.image_path || "",
          timestamp: new Date().toISOString()
        };
        allRows.unshift(newRow);
        applyFilters();
        await loadStats();

        // show inline prediction card without alert
        if (predCard) {
          predLabel && (predLabel.textContent = data.label || "—");
          predPatient && (predPatient.textContent = "Patient: " + (data.patient_name || p));
          const confText = data.confidence_pct !== undefined && data.confidence_pct !== null
            ? (data.confidence_pct + "%")
            : (newRow.confidence != null ? (newRow.confidence*100).toFixed(2) + "%" : "—");
          predConfidence && (predConfidence.textContent = confText);
          predTime && (predTime.textContent = new Date().toLocaleString());

          // download link
          const params = new URLSearchParams({
            prediction: data.label || "Unknown",
            accuracy: newRow.confidence != null ? (newRow.confidence*100).toFixed(2) : "N/A",
            patient_name: newRow.patient_name || "",
            image_path: newRow.image_path || "",
            current_date: new Date().toLocaleDateString()
          });
          predDownload && (predDownload.href = "/download_report?" + params.toString());

          predCard.classList.remove("d-none");
          predViewBtn && (predViewBtn.onclick = () => openDetail(newRow));

          // auto-open detail modal (optional)
          openDetail(newRow);
        }

      } catch(err) {
        console.error("Upload error:", err);
        alert(err.message || "Prediction/upload failed");
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = oldHtml;
        uploadForm.reset();
      }
    });

    // preview selected file locally
    fileInput?.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f || !previewImg) return;
      previewImg.src = URL.createObjectURL(f);
      setTimeout(()=> URL.revokeObjectURL(previewImg.src), 20000);
    });
  }

  // --- Init on load ---
  window.addEventListener("load", async () => {
    try {
      document.getElementById("year") && (document.getElementById("year").textContent = new Date().getFullYear());
      initVolumeChart();  // placeholder gradient chart
      await loadStats();
      await fetchRecent(200);
    } catch(e) { console.warn("init error:", e); }
  });

  // expose updateVolumeChart globally in case inline HTML initializer or other script wants it
  window.updateVolumeChart = updateVolumeChart;

})();
