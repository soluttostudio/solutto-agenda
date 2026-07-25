// ATENCIÓN HUMANO: URL de producción unificada
const API_URL = "https://script.google.com/macros/s/AKfycbywBjNrfKOpmuwDap0ktJag8BqsxR30jVmURvZOU2Vkq6Osus5vZ5dHNYXhvWIQt55_qA/exec";
const SERVICES_URL = API_URL + "?accion=servicios";

let SERVICES = {}; 
let CATEGORIAS = {}; 

const STATE = {
  step: 1,
  servicio: null,
  fecha: "",
  hora: null,
  cliente: "",
  email: "",
  telefono: "",
  loading: false,
  selectedSlotBtn: null,
  eventoId: null
};

const formatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 });
const $ = id => document.getElementById(id);

const els = {
  views: {
    services: $("step-services"),
    datetime: $("step-datetime"),
    form: $("step-form"),
    confirmation: $("step-confirmation")
  },
  servicesGrid: $("services-grid"),
  loaderServices: $("loader-services"),
  servicesError: $("services-error"),
  stepTitle: $("step-title"),
  progressSteps: document.querySelectorAll(".progress-step"),
  progressLines: document.querySelectorAll(".progress-line"),
  dateInput: $("date-input"),
  slotsContainer: $("slots-container"),
  loaderSlots: $("loader-slots"),
  slotsError: $("slots-error"),
  selectedServiceInfo: $("selected-service-info"),
  selectedInfoCard: $("selected-info-card"),
  form: $("booking-form"),
  btnSubmit: $("btn-submit"),
  btnBack: $("btn-back"),
  btnNewBooking: $("btn-new-booking"),
  globalError: $("global-error"),
  confirmationDetails: $("confirmation-details"),
  modalOverlay: $("success-modal-overlay"),
  successModal: $("success-modal"),
  btnFinalizar: $("btn-finalizar"),
  modalDate: $("modal-date"),
  modalTime: $("modal-time"),
  modalService: $("modal-service")
};

function formatPrecio(num, moneda = "USD") {
  const symbol = moneda === "EUR" ? "€" : "$";
  return `${symbol}${num.toLocaleString("es-AR")}`;
}

function renderServices() {
  els.servicesGrid.innerHTML = "";
  
  Object.entries(CATEGORIAS).forEach(([nombreCategoria, listaServicios], index) => {
    const categoryBlock = document.createElement("div");
    categoryBlock.className = "category-block";
    
    // Botón del acordeón (Cabecera de categoría)
    const headerBtn = document.createElement("button");
    headerBtn.className = "accordion-header";
    // Dejamos el primer acordeón abierto por defecto
    if(index === 0) headerBtn.classList.add("active"); 
    headerBtn.innerHTML = `
      <span>${nombreCategoria}</span>
      <span class="accordion-icon">▼</span>
    `;
    
    // Contenedor animado del acordeón
    const contentDiv = document.createElement("div");
    contentDiv.className = "accordion-content";
    if(index === 0) contentDiv.classList.add("open");

    const innerDiv = document.createElement("div");
    innerDiv.className = "accordion-inner";

    const innerGrid = document.createElement("div");
    innerGrid.className = "services-inner-grid";
    
    listaServicios.forEach(svc => {
      const card = document.createElement("div");
      card.className = "service-card";
      card.dataset.id = svc.id_servicio;
      card.innerHTML = `
        <h3>${svc.nombre}</h3>
        <div class="duration">${svc.duracion_minutos} min</div>
        <div class="price">${formatPrecio(svc.precio, svc.moneda)}</div>
      `;
      card.addEventListener("click", () => selectService(svc.id_servicio, card));
      innerGrid.appendChild(card);
    });
    
    innerDiv.appendChild(innerGrid);
    contentDiv.appendChild(innerDiv);
    
    // Lógica para abrir/cerrar acordeón
    headerBtn.addEventListener("click", () => {
      const isOpen = contentDiv.classList.contains("open");
      
      // Cerramos todos los demás acordeones para mantener el minimalismo
      document.querySelectorAll(".accordion-content").forEach(el => el.classList.remove("open"));
      document.querySelectorAll(".accordion-header").forEach(el => el.classList.remove("active"));

      // Abrimos el que clickeó el usuario (si no estaba ya abierto)
      if (!isOpen) {
        contentDiv.classList.add("open");
        headerBtn.classList.add("active");
        
        // Scroll suave sutil para enfocar la categoría abierta
        setTimeout(() => {
          categoryBlock.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 300);
      }
    });

    categoryBlock.appendChild(headerBtn);
    categoryBlock.appendChild(contentDiv);
    els.servicesGrid.appendChild(categoryBlock);
  });
}

function selectService(id, card) {
  document.querySelectorAll(".service-card").forEach(c => c.classList.remove("selected"));
  card.classList.add("selected");
  STATE.servicio = id;
  updateServiceInfo();
  goToStep(2);
}

function updateServiceInfo() {
  const svc = SERVICES[STATE.servicio];
  if (!svc) return;
  els.selectedServiceInfo.innerHTML = `
    <div class="info-label">Servicio seleccionado</div>
    <div class="info-value">${svc.nombre} &middot; ${formatPrecio(svc.precio, svc.moneda)}</div>
  `;
}

function goToStep(step) {
  STATE.step = step;
  Object.values(els.views).forEach(v => v.classList.remove("active"));
  const viewMap = { 1: "services", 2: "datetime", 3: "form", 4: "confirmation" };
  els.views[viewMap[step]].classList.add("active");

  const titles = {
    1: "Elegí tu servicio",
    2: "Fecha y horario",
    3: "Tus datos",
    4: "Reserva confirmada"
  };
  els.stepTitle.querySelector("h2").textContent = titles[step] || "";

  els.btnBack.classList.toggle("hidden", step <= 1 || step === 4);

  els.progressSteps.forEach((ps, i) => {
    const num = i + 1;
    ps.classList.toggle("active", num === step);
    ps.classList.toggle("done", num < step);
  });
  els.progressLines.forEach((pl, i) => {
    pl.classList.toggle("done", i + 1 < step);
  });

  if (step === 2 && STATE.fecha) fetchSlots();
  if (step === 3) renderSelectedInfoCard();
  if (step === 4) renderConfirmation();

  hideGlobalError();
  
  // Scroll suave al título al cambiar de paso
  window.scrollTo({ top: document.getElementById("step-title").offsetTop - 20, behavior: "smooth" });
}

function renderSelectedInfoCard() {
  const svc = SERVICES[STATE.servicio];
  els.selectedInfoCard.innerHTML = `
    <div class="info-item">
      <div class="info-label">Servicio</div>
      <div class="info-value">${svc.nombre}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Fecha</div>
      <div class="info-value">${formatDate(STATE.fecha)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Horario</div>
      <div class="info-value">${STATE.hora}</div>
    </div>
  `;
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function setMinDate() {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  els.dateInput.min = `${y}-${m}-${d}`;
}

els.dateInput.addEventListener("change", () => {
  STATE.fecha = els.dateInput.value;
  STATE.hora = null;
  if (STATE.selectedSlotBtn) {
    STATE.selectedSlotBtn.classList.remove("selected");
    STATE.selectedSlotBtn = null;
  }
  if (STATE.fecha) {
    fetchSlots();
  } else {
    els.slotsContainer.innerHTML = `<p class="slots-placeholder">Seleccioná una fecha para ver los horarios disponibles.</p>`;
  }
});

async function fetchSlots() {
  if (!API_URL || !STATE.servicio || !STATE.fecha) return;
  STATE.loading = true;
  els.loaderSlots.classList.remove("hidden");
  els.slotsContainer.innerHTML = "";
  els.slotsError.classList.add("hidden");

  try {
    const url = `${API_URL}?servicio=${encodeURIComponent(STATE.servicio)}&fecha=${encodeURIComponent(STATE.fecha)}`;
    const res = await fetch(url);
    const json = await res.json();

    if (json.status === "error") {
      showSlotsError(json.data.mensaje || "Error al consultar disponibilidad.");
      return;
    }

    const disponibles = json.data.disponibles || [];
    if (json.data.mensaje) {
      els.slotsContainer.innerHTML = `<p class="slots-placeholder">${json.data.mensaje}</p>`;
      return;
    }

    if (disponibles.length === 0) {
      els.slotsContainer.innerHTML = `<p class="slots-placeholder">No hay horarios disponibles para esta fecha.</p>`;
      return;
    }

    renderSlots(disponibles);
  } catch (err) {
    showSlotsError("Error de conexión con la agenda.");
  } finally {
    STATE.loading = false;
    els.loaderSlots.classList.add("hidden");
  }
}

function showSlotsError(msg) {
  els.slotsError.textContent = msg;
  els.slotsError.classList.remove("hidden");
  els.slotsContainer.innerHTML = `<p class="slots-placeholder">No se pudieron cargar los horarios.</p>`;
}

function renderSlots(slots) {
  els.slotsContainer.innerHTML = "";
  slots.forEach(h => {
    const btn = document.createElement("button");
    btn.className = "slot-btn";
    btn.textContent = h;
    btn.addEventListener("click", () => {
      if (STATE.selectedSlotBtn) STATE.selectedSlotBtn.classList.remove("selected");
      btn.classList.add("selected");
      STATE.selectedSlotBtn = btn;
      STATE.hora = h;
      setTimeout(() => goToStep(3), 200); 
    });
    els.slotsContainer.appendChild(btn);
  });
}

els.form.addEventListener("submit", async e => {
  e.preventDefault();
  if (!validateForm()) return;
  await submitBooking();
});

function validateForm() {
  let valid = true;
  const cliente = els.form.cliente.value.trim();
  if (!cliente || cliente.length < 2) { showFieldError("cliente", "Campo requerido"); valid = false; } else { clearFieldError("cliente"); }
  
  const email = els.form.email.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFieldError("email", "Email inválido"); valid = false; } else { clearFieldError("email"); }

  const telefono = els.form.telefono.value.trim();
  if (!telefono || telefono.length < 6) { showFieldError("telefono", "Teléfono inválido"); valid = false; } else { clearFieldError("telefono"); }
  return valid;
}

function showFieldError(field, msg) {
  const input = els.form[field];
  input.classList.add("error");
  $(`error-${field}`).textContent = msg;
}

function clearFieldError(field) {
  els.form[field].classList.remove("error");
  $(`error-${field}`).textContent = "";
}

async function submitBooking() {
  const honeypot = els.form.website?.value?.trim();
  if (honeypot) return;

  els.btnSubmit.disabled = true;
  els.btnSubmit.textContent = "Procesando...";
  hideGlobalError();

  const body = JSON.stringify({
    accion: "reservar",
    servicio: STATE.servicio,
    fecha: STATE.fecha,
    hora: STATE.hora,
    cliente: els.form.cliente.value.trim(),
    email: els.form.email.value.trim(),
    telefono: els.form.telefono.value.trim()
  });

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body
    });
    const json = await res.json();

    if (json.status === "success") {
      STATE.eventoId = json.data.evento_id;
      els.btnSubmit.disabled = false;
      els.btnSubmit.textContent = "Confirmar reserva";
      openSuccessModal();
      return;
    } else {
      handlePostError(json);
    }
  } catch (err) {
    showGlobalError("Ocurrió un error. Verificá tu conexión.");
  } finally {
    els.btnSubmit.disabled = false;
    els.btnSubmit.textContent = "Confirmar reserva";
  }
}

function handlePostError(json) {
  const code = json.code || 400;
  const msg = json.data ? json.data.mensaje : "Ocurrió un error.";
  if (code === 409) {
    showGlobalError("⚠️ " + msg);
    goToStep(2);
  } else {
    showGlobalError(msg);
  }
}

function renderConfirmation() {
  const svc = SERVICES[STATE.servicio];
  els.confirmationDetails.innerHTML = `
    <div class="detail-row"><span class="detail-label">Servicio</span><span class="detail-value">${svc.nombre}</span></div>
    <div class="detail-row"><span class="detail-label">Fecha</span><span class="detail-value">${formatDate(STATE.fecha)}</span></div>
    <div class="detail-row"><span class="detail-label">Horario</span><span class="detail-value">${STATE.hora}</span></div>
    <div class="detail-row"><span class="detail-label">A nombre de</span><span class="detail-value">${els.form.cliente.value.trim()}</span></div>
  `;
}

function showGlobalError(msg) {
  els.globalError.textContent = msg;
  els.globalError.classList.remove("hidden");
}

function hideGlobalError() {
  els.globalError.classList.add("hidden");
}

function openSuccessModal() {
  const svc = SERVICES[STATE.servicio];
  const [y, m, d] = STATE.fecha.split("-");
  const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  
  els.modalDate.textContent = `${dias[dateObj.getDay()]} ${parseInt(d)} de ${meses[dateObj.getMonth()]}`;
  els.modalTime.textContent = STATE.hora;
  els.modalService.textContent = svc.nombre;

  els.modalOverlay.classList.remove("hidden");
}

function closeModal() {
  els.modalOverlay.classList.add("hidden");
  goToStep(4);
}

function resetAll() {
  STATE.servicio = null;
  STATE.fecha = "";
  STATE.hora = null;
  STATE.eventoId = null;
  STATE.selectedSlotBtn = null;
  els.dateInput.value = "";
  els.form.reset();
  document.querySelectorAll(".service-card").forEach(c => c.classList.remove("selected"));
  document.querySelectorAll(".field-error").forEach(e => e.textContent = "");
  document.querySelectorAll(".field input").forEach(i => i.classList.remove("error"));
  hideGlobalError();
  goToStep(1);
}

els.btnFinalizar.addEventListener("click", () => {
  els.btnFinalizar.disabled = true;
  closeModal();
  setTimeout(() => els.btnFinalizar.disabled = false, 300);
});

els.btnBack.addEventListener("click", () => {
  if (STATE.step === 2) goToStep(1);
  else if (STATE.step === 3) {
    STATE.hora = null;
    if (STATE.selectedSlotBtn) STATE.selectedSlotBtn.classList.remove("selected");
    goToStep(2);
  }
});

els.btnNewBooking.addEventListener("click", resetAll);

async function fetchServices() {
  els.loaderServices.classList.remove("hidden");
  try {
    const res = await fetch(SERVICES_URL);
    const json = await res.json();
    const categoriasRecibidas = json.data?.categorias || {};
    if (Object.keys(categoriasRecibidas).length === 0) throw new Error();
    
    CATEGORIAS = categoriasRecibidas;
    SERVICES = {}; 
    Object.values(CATEGORIAS).forEach(lista => lista.forEach(svc => SERVICES[svc.id_servicio] = svc));
    renderServices();
  } catch (err) {
    els.servicesError.textContent = "No hay servicios disponibles temporalmente.";
    els.servicesError.classList.remove("hidden");
  } finally {
    els.loaderServices.classList.add("hidden");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setMinDate();
  fetchServices();
});