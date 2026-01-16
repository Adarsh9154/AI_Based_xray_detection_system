(() => {
  // --- helpers ---
  const $ = s => document.querySelector(s);
  const esc = s => String(s || "").replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])
  );

  // --- KPI elements ---
  const kTotal = $("#kpiTotal");
  const kFract = $("#kpiFractures");
  const kAcc   = $("#kpiAcc");
  const kLat   = $("#kpiLatency");

  const recentTbody = $("#recentTbody");
  const globalSearch = $("#globalSearch");

  const uploadForm = $("#uploadForm");
  const uploadBtn = $("#uploadBtn");
  const patientName = $("#patientName");
  const fileInput = $("#fileInput");
  const previewImg = $("#preview");

  let allRows = [];

  // --- Load stats ---
  async function loadStats() {
    try {
      const r = await fetch("/api/stats");
      if (!r.ok) return;
      const j = await r.json();

      if (kTotal) kTotal.textContent = j.total_scans ?? "—";
      if (kFract) kFract.textContent = j.fractures ?? "—";
      if (kAcc)   kAcc.textContent   = j.model_accuracy ? j.model_accuracy + "%" : "—";
      if (kLat)   kLat.textContent   = j.avg_latency ? j.avg_latency.toFixed(2) + "s" : "—";
    } catch (e) {
      console.warn("Stats error:", e);
    }
  }

  // --- Load recent scans ---
  async function loadRecent() {
    try {
      const r = await fetch("/api/recent");
      if (!r.ok) return;
      const j = await r.json();
      allRows = j.recent || [];
      renderRows(allRows);
    } catch (e) {
      console.warn("Recent error:", e);
    }
  }

  function renderRows(rows) {
    if (!recentTbody) return;
    recentTbody.innerHTML = "";

    rows.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(r.scan_id)}</td>
        <td>${esc(r.patient_name)}</td>
        <td>${r.label === "Fractured"
          ? '<span class="badge-fracture">Fractured</span>'
          : '<span class="badge-normal">Normal</span>'}</td>
        <td>${r.confidence ? (r.confidence * 100).toFixed(2) + "%" : "—"}</td>
        <td>${r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}</td>
      `;
      recentTbody.appendChild(tr);
    });
  }

  // --- Search ---
  globalSearch?.addEventListener("input", () => {
    const q = globalSearch.value.toLowerCase();
    renderRows(
      allRows.filter(r =>
        (r.scan_id || "").toLowerCase().includes(q) ||
        (r.patient_name || "").toLowerCase().includes(q)
      )
    );
  });

  // --- Upload ---
  uploadForm?.addEventListener("submit", async e => {
    e.preventDefault();

    if (!patientName.value || !fileInput.files.length) {
      alert("Please enter patient name and select X-ray");
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.innerText = "Analyzing...";

    const fd = new FormData();
    fd.append("patient_name", patientName.value);
    fd.append("file", fileInput.files[0]);

    try {
      const r = await fetch("/predict", { method: "POST", body: fd });
      if (!r.ok) throw new Error("Prediction failed");

      const j = await r.json();
      if (previewImg && j.image_path) previewImg.src = j.image_path;

      await loadStats();
      await loadRecent();

      alert(`Prediction: ${j.label}`);
    } catch (e) {
      alert(e.message);
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.innerText = "Upload & Predict";
      uploadForm.reset();
    }
  });

  // --- Init ---
  window.addEventListener("load", () => {
    loadStats();
    loadRecent();
  });

})();
