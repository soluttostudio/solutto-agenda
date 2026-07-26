// ATENCIÓN HUMANO: Pega aquí la URL NUEVA que generaste en el paso anterior.
const API_URL = "https://script.google.com/macros/s/AKfycbyVDbQ4Fp7cbkCloc8d9CT_cQ-zXrxo_TbvH83yTkor1dsqr9_ZctbqsmfCCSY_yiYUSQ/exec";

const $ = id => document.getElementById(id);

let reservaParaCancelar = null;
let servicioEnEdicion = null;
let autoRefreshTimer = null; // Temporizador para recarga automática

const viewLogin = $("login-view");
const viewDashboard = $("dashboard-view");
const loader = $("global-loader");
const navItems = document.querySelectorAll(".nav-item[data-target]");
const views = document.querySelectorAll(".admin-view");

// ======== HELPERS DE FORMATEO ========
function formatearFecha(cadena) {
  if (!cadena) return "";
  const d = new Date(cadena);
  if (isNaN(d)) return cadena; 
  const opciones = { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
  let formateada = d.toLocaleDateString('es-AR', opciones);
  return formateada.charAt(0).toUpperCase() + formateada.slice(1); 
}

function formatearHora(cadena) {
  if (!cadena) return "";
  if (!cadena.includes("GMT") && !cadena.includes("Z")) return cadena; 
  const d = new Date(cadena);
  if (isNaN(d)) return cadena;
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

// ======== COMPROBACIÓN DE SESIÓN INICIAL ========
window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('solutto_admin_auth') === 'true') {
    viewLogin.classList.add("hidden");
    viewDashboard.classList.remove("hidden");
    cargarServicios(true); // true = mostrar loader inicial
    iniciarRefrescoAutomatico();
  }
});

// ======== LOGIN / LOGOUT ========
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("btn-login").textContent = "Cargando...";
  try {
    const res = await fetch(`${API_URL}?accion=login&password=${encodeURIComponent($("admin-pass").value)}`);
    const json = await res.json();
    if (json.success) {
      localStorage.setItem('solutto_admin_auth', 'true'); // Guardamos la sesión
      viewLogin.classList.add("hidden");
      viewDashboard.classList.remove("hidden");
      cargarServicios(true); 
      iniciarRefrescoAutomatico();
    } else { 
      $("login-error").classList.remove("hidden"); 
    }
  } catch (err) { alert("Error de conexión"); } 
  finally { $("btn-login").textContent = "Ingresar"; }
});

$("btn-logout").addEventListener("click", () => {
  localStorage.removeItem('solutto_admin_auth'); // Borramos la sesión
  if (autoRefreshTimer) clearInterval(autoRefreshTimer); // Detenemos el refresco automático
  viewDashboard.classList.add("hidden");
  viewLogin.classList.remove("hidden");
  $("admin-pass").value = "";
});

// ======== NAVEGACIÓN ========
navItems.forEach(btn => {
  btn.addEventListener("click", () => {
    navItems.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    views.forEach(v => v.classList.add("hidden"));
    $(btn.dataset.target).classList.remove("hidden");
    
    if (btn.dataset.target === "view-servicios") cargarServicios(true);
    if (btn.dataset.target === "view-agenda") cargarAgenda(true);
  });
});

// ======== REFRESCO AUTOMÁTICO (POLLING) ========
function iniciarRefrescoAutomatico() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  
  // Cada 30 segundos ejecutará esta comprobación
  autoRefreshTimer = setInterval(() => {
    // Solo actualiza si NO hay modales abiertos (para no interrumpir al usuario mientras edita algo)
    if (!estanModalesAbiertos()) {
      if (!$("view-agenda").classList.contains("hidden")) {
        cargarAgenda(false); // false = recarga silenciosa (sin loader)
      } else if (!$("view-servicios").classList.contains("hidden")) {
        cargarServicios(false);
      }
    }
  }, 30000); // 30000 ms = 30 segundos
}

function estanModalesAbiertos() {
  return !$("modal-add-service").classList.contains("hidden") ||
         !$("modal-edit-service").classList.contains("hidden") ||
         !$("modal-block-time").classList.contains("hidden") ||
         !$("modal-cancel-booking").classList.contains("hidden");
}

// ======== GESTIÓN DE SERVICIOS (Acordeón) ========
// Añadimos parámetro 'mostrarUI' para saber si ponemos la pantalla en negro o lo hacemos de fondo
async function cargarServicios(mostrarUI = true) {
  if (mostrarUI) mostrarLoader();
  try {
    const res = await fetch(`${API_URL}?accion=list-servicios&t=${Date.now()}`);
    const json = await res.json();
    
    if(json.success && json.data.servicios) {
      const categorias = {};
      json.data.servicios.forEach(svc => {
        const cat = svc.categoria || 'Otros';
        if(!categorias[cat]) categorias[cat] = [];
        categorias[cat].push(svc);
      });
      
      // En vez de borrar todo de golpe, creamos un contenedor temporal para que no haya parpadeos visuales
      const tempContainer = document.createElement("div");
      
      for(const cat in categorias) {
        const block = document.createElement("div");
        block.className = "category-block";
        
        const header = document.createElement("button");
        header.className = "accordion-header";
        // Si no se mostraba el UI (es background), por defecto los acordeones nacen abiertos para no colapsárselos al usuario de la nada
        const openClass = mostrarUI ? "" : "active"; 
        const contentClass = mostrarUI ? "" : "open";

        header.innerHTML = `${cat} <span class="accordion-icon">▼</span>`;
        if(!mostrarUI) header.classList.add("active");
        
        const content = document.createElement("div");
        content.className = `accordion-content ${contentClass}`;
        
        const innerWrapper = document.createElement("div");
        innerWrapper.className = "accordion-inner";
        
        const innerGrid = document.createElement("div");
        innerGrid.className = "services-inner-grid";
        
        categorias[cat].forEach(svc => {
          const isActivo = svc.estado.toUpperCase() === "ACTIVO";
          const badgeClass = isActivo ? "active" : "inactive";
          const btnText = isActivo ? "Desactivar" : "Activar";
          const btnClass = isActivo ? "btn-secondary" : "btn-primary";
          
          const card = document.createElement("div");
          card.className = "service-card";
          card.innerHTML = `
            <div class="service-card-info">
              <h3>${svc.nombre} <span class="badge ${badgeClass}" style="margin-left:8px; font-size:0.6rem;">${svc.estado}</span></h3>
              <div class="duration">${svc.duracion_minutos} min</div>
              <div class="price">${svc.precio} ${svc.moneda}</div>
            </div>
            <div class="service-card-actions">
              <button class="btn btn-sm ${btnClass}" style="margin:0;" onclick="toggleEstado('${svc.id_servicio}')">${btnText}</button>
              <button class="btn btn-sm btn-secondary" style="margin:0;" onclick="abrirModalEditar('${svc.id_servicio}', '${svc.nombre.replace(/'/g, "\\'")}', ${svc.precio}, ${svc.duracion_minutos})">Editar</button>
            </div>
          `;
          innerGrid.appendChild(card);
        });
        
        innerWrapper.appendChild(innerGrid);
        content.appendChild(innerWrapper);
        block.appendChild(header);
        block.appendChild(content);
        tempContainer.appendChild(block);
        
        header.addEventListener("click", () => {
          header.classList.toggle("active");
          content.classList.toggle("open");
        });
      }
      
      // Reemplazo limpio del DOM
      const container = $("admin-services-container");
      container.innerHTML = tempContainer.innerHTML;
      
      // Reasignar eventos a los nuevos headers (porque el innerHTML destruye los eventos)
      container.querySelectorAll(".accordion-header").forEach(hdr => {
        hdr.addEventListener("click", function() {
          this.classList.toggle("active");
          this.nextElementSibling.classList.toggle("open");
        });
      });
    }
  } catch(e) { console.error("Error silencioso al cargar servicios"); }
  if (mostrarUI) ocultarLoader();
}

async function toggleEstado(idServicio) {
  mostrarLoader();
  try {
    await fetch(API_URL, { 
      method: "POST", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ accion: "toggle_servicio", id: idServicio }) 
    });
    cargarServicios(true); 
  } catch(e) { alert("Error al actualizar"); ocultarLoader(); }
}

function abrirModalEditar(id, nombre, precio, duracion) {
  servicioEnEdicion = id;
  $("edit-nom-display").textContent = nombre;
  $("edit-pre").value = precio;
  $("edit-dur").value = duracion;
  $("modal-edit-service").classList.remove("hidden");
}

$("btn-close-edit-service").addEventListener("click", () => $("modal-edit-service").classList.add("hidden"));

$("form-edit-service").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("btn-save-edit").textContent = "Guardando...";
  try {
    const res = await fetch(API_URL, { 
      method: "POST", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        accion: "editar_servicio", id: servicioEnEdicion, precio: $("edit-pre").value, duracion: $("edit-dur").value
      })
    });
    const json = await res.json();
    if (json.status === "success") {
      $("modal-edit-service").classList.add("hidden");
      cargarServicios(true); 
    } else {
      alert("Error: " + (json.data ? json.data.mensaje : "Orden rechazada"));
    }
  } catch(e) { alert("Error de conexión"); }
  $("btn-save-edit").textContent = "Guardar Cambios";
});

$("btn-open-add-service").addEventListener("click", () => $("modal-add-service").classList.remove("hidden"));
$("btn-close-modal-service").addEventListener("click", () => $("modal-add-service").classList.add("hidden"));

$("form-add-service").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("btn-save-service").textContent = "Guardando...";
  try {
    await fetch(API_URL, { 
      method: "POST", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        accion: "agregar_servicio", categoria: $("add-cat").value, nombre: $("add-nom").value, precio: $("add-pre").value, duracion: $("add-dur").value
      })
    });
    $("modal-add-service").classList.add("hidden");
    $("form-add-service").reset();
    cargarServicios(true);
  } catch(e) { alert("Error al guardar"); }
  $("btn-save-service").textContent = "Guardar";
});

// ======== GESTIÓN DE AGENDA ========
async function cargarAgenda(mostrarUI = true) {
  if (mostrarUI) mostrarLoader();
  try {
    const res = await fetch(`${API_URL}?accion=list-agenda&t=${Date.now()}`);
    const json = await res.json();
    
    if(json.success && json.data) {
      const tbody = document.createElement("tbody"); // Usamos document fragment virtual para evitar repintado brusco
      
      json.data.reverse().forEach(reserva => {
        if(!reserva.id_reserva) return; 
        const estadoReal = reserva.estado ? String(reserva.estado) : "Activa";
        const isActiva = estadoReal.toUpperCase() === "ACTIVA";
        const badgeClass = isActiva ? "active" : "inactive";
        
        const fechaLimpia = formatearFecha(reserva.fecha_turno);
        const horaLimpia = formatearHora(reserva.hora_turno);
        
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td data-label="Fecha/Hora"><strong>${fechaLimpia}</strong><br><small style="color:var(--text-muted)">${horaLimpia} hs</small></td>
          <td data-label="Cliente">${reserva.cliente}</td>
          <td data-label="Teléfono">${reserva.telefono}</td>
          <td data-label="Servicio">${reserva.servicio}</td>
          <td data-label="Estado"><span class="badge ${badgeClass}">${estadoReal}</span></td>
          <td data-label="Acción">${isActiva && reserva.evento_id ? `<button class="btn btn-sm btn-danger" onclick="abrirModalCancelar('${reserva.evento_id}')">Eliminar</button>` : ''}</td>
        `;
        tbody.appendChild(tr);
      });
      
      // Inyecta todo de golpe sin parpadeos
      $("table-agenda-body").innerHTML = tbody.innerHTML;
    }
  } catch(e) { console.error("Error silencioso al cargar agenda"); }
  if (mostrarUI) ocultarLoader();
}

$("btn-open-block").addEventListener("click", () => $("modal-block-time").classList.remove("hidden"));
$("btn-close-block").addEventListener("click", () => $("modal-block-time").classList.add("hidden"));
$("form-block-time").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("btn-save-block").textContent = "Bloqueando...";
  try {
    await fetch(API_URL, { 
      method: "POST", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ accion: "bloquear_horario", fecha: $("block-date").value, hora_inicio: $("block-start").value, hora_fin: $("block-end").value, motivo: $("block-reason").value }) 
    });
    $("modal-block-time").classList.add("hidden");
    $("form-block-time").reset();
    cargarAgenda(true);
  } catch(e) { alert("Error al bloquear"); }
  $("btn-save-block").textContent = "Bloquear";
});

function abrirModalCancelar(eventoId) { reservaParaCancelar = eventoId; $("modal-cancel-booking").classList.remove("hidden"); }
$("btn-close-cancel-modal").addEventListener("click", () => { reservaParaCancelar = null; $("modal-cancel-booking").classList.add("hidden"); });
$("btn-confirm-cancel").addEventListener("click", async () => {
  if (!reservaParaCancelar) return;
  $("btn-confirm-cancel").textContent = "Eliminando...";
  try {
    await fetch(API_URL, { 
      method: "POST", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ accion: "cancelar_reserva", id_evento: reservaParaCancelar }) 
    });
    $("modal-cancel-booking").classList.add("hidden");
    cargarAgenda(true);
  } catch(e) { alert("Error"); }
  $("btn-confirm-cancel").textContent = "Sí, Eliminar";
  reservaParaCancelar = null;
});

function mostrarLoader() { loader.classList.remove("hidden"); }
function ocultarLoader() { loader.classList.add("hidden"); }