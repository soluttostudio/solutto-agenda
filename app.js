// =========================================================================
// ARCHIVO: app.js (VERSIÓN NOMI - PAGOS DINÁMICOS Y FIX DE ERRORES)
// =========================================================================

const API_URL = '/api/proxy';

const btnAbrirModal = document.getElementById("btn-abrir-modal");
const triggerText = document.getElementById("trigger-text");
const modalCatalogo = document.getElementById("modal-catalogo");
const btnCerrarModal = document.getElementById("btn-cerrar-modal");

const selectServicio = document.getElementById("select-servicio");
const categoryPillsContainer = document.getElementById("category-pills");
const listaServiciosContainer = document.getElementById("servicios-lista");
const loaderServicios = document.getElementById("loader-servicios");
const searchTratamientos = document.getElementById("search-tratamientos");

const groupProfesional = document.getElementById("group-profesional");
const selectProfesional = document.getElementById("select-profesional");
const groupPago = document.getElementById("group-pago");
const inputFecha = document.getElementById("input-fecha");
const slotsContainer = document.getElementById("slots-container");
const inputHora = document.getElementById("input-hora");
const loaderHorarios = document.getElementById("loader-horarios");
const btnSubmit = document.getElementById("btn-submit");
const reservaForm = document.getElementById("reserva-form");

const btnShowDiscount = document.getElementById("btn-show-discount");
const discountWrapper = document.getElementById("discount-wrapper");
const inputCupon = document.getElementById("input-cupon");
const btnApplyDiscount = document.getElementById("btn-apply-discount");
const discountMessage = document.getElementById("discount-message");

let listaStaffGlobal = []; 
let catalogoServiciosGlobal = {}; 
let categoriaActiva = "Todos"; 
let cuponValidado = null; 
let cuponPorcentajeGlobal = 0; 
let datosTransferenciaGlobal = "Contacta al estudio para enviar el comprobante.";
let estadoMarca = { mp_total_activo: true, mp_sena_activo: true, porcentaje_sena: 25, pago_local_activo: true, transferencia_activa: false, moneda: 'ARS' };

// ── MÓDULO CHAT ASÍNCRONO (Buzón): Estado + memoria del cliente fantasma ──
let nomi_chat_id = null;
let nomi_chat_interval = null;
try { nomi_chat_id = localStorage.getItem('nomi_chat_id'); } catch (e) { nomi_chat_id = null; }

// Formatea un número como moneda según el símbolo/config de la marca (default ARS)
function formatearMonedaMarca(valor) {
    const num = Math.round(valor || 0);
    const moneda = estadoMarca.moneda || 'ARS';
    try {
        const localeMap = { ARS: 'es-AR', USD: 'en-US', CLP: 'es-CL', MXN: 'es-MX' };
        return new Intl.NumberFormat(localeMap[moneda] || 'es-AR', { style: 'currency', currency: moneda, maximumFractionDigits: 0 }).format(num);
    } catch(e) {
        return "$" + num.toLocaleString('es-AR');
    }
}

document.addEventListener("DOMContentLoaded", () => {
  cargarConfiguracionMarca();
  cargarServiciosVisuales();
  initNomiChat();
  
  if (selectServicio) selectServicio.addEventListener('change', handleServicioChange);
  if (inputFecha) inputFecha.addEventListener('change', checkDisponibilidad);
  if (reservaForm) reservaForm.addEventListener('submit', handleReservaSubmit);

  document.querySelectorAll('input[name="tipo_pago"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
          const mpNotice = document.getElementById('mp-notice-box');
          if(mpNotice) {
              mpNotice.style.display = e.target.value.includes('mp_') ? 'block' : 'none';
          }
          actualizarResumenPago();
      });
  });
});

async function cargarConfiguracionMarca() {
    try {
        const res = await fetch(`${API_URL}?accion=obtener_marca`);
        const json = await res.json();
        
        if (json.success && json.data) {
            const conf = json.data;
            if (conf.color_acento) {
                document.documentElement.style.setProperty('--accent', conf.color_acento);
                document.documentElement.style.setProperty('--focus-ring', conf.color_acento + '4D'); 
            }
            if (conf.color_fondo) {
                document.documentElement.style.setProperty('--bg-color', conf.color_fondo);
                const metaThemeColor = document.querySelector('meta[name="theme-color"]');
                if (metaThemeColor) metaThemeColor.setAttribute('content', conf.color_fondo);
            }
            if (conf.color_tarjetas) document.documentElement.style.setProperty('--card-bg', conf.color_tarjetas);
            if (conf.color_texto) document.documentElement.style.setProperty('--text-main', conf.color_texto);
            if (conf.color_secundario) document.documentElement.style.setProperty('--brand-pink', conf.color_secundario);
            document.documentElement.style.setProperty('--text-muted', conf.color_texto_secundario || '#9ca3af');
            document.documentElement.style.setProperty('--input-bg', conf.color_fondo_campos || '#22272c');
            document.documentElement.style.setProperty('--success', conf.color_precios || '#10b981');

            estadoMarca.mp_total_activo = conf.mp_total_activo !== false && conf.mp_total_activo !== null;
            estadoMarca.mp_sena_activo = conf.mp_sena_activo !== false && conf.mp_sena_activo !== null;
            estadoMarca.porcentaje_sena = parseInt(conf.porcentaje_sena) || 25;
            estadoMarca.pago_local_activo = conf.pago_local_activo !== false && conf.pago_local_activo !== null;
            estadoMarca.transferencia_activa = !!conf.transferencia_activa;
            estadoMarca.moneda = conf.moneda || 'ARS';
            // ESCUDO MERCADO PAGO: solo se ofrece MP si la moneda de la franquicia es ARS.
            const mpEscudoOK = estadoMarca.moneda === 'ARS';
            
            const logoEl = document.getElementById('logo-principal');
            if (conf.logo_url && logoEl) logoEl.src = conf.logo_url;
            const favEl = document.getElementById('favicon-principal');
            if (conf.isotipo_url && favEl) favEl.href = conf.isotipo_url;
            const appleEl = document.getElementById('apple-touch-principal');
            if (conf.icono_acceso_url && appleEl) appleEl.href = conf.icono_acceso_url;
            else if (conf.isotipo_url && appleEl) appleEl.href = conf.isotipo_url;

            const optMp = document.getElementById('opt-mp');
            const optMpSena = document.getElementById('opt-mp-sena');
            const optMpTtotal = document.getElementById('opt-mp-total');
            const optTransf = document.getElementById('opt-transferencia');
            const optLocal = document.getElementById('opt-local');
            const mpNotice = document.getElementById('mp-notice-box');

            const senaLabel = document.querySelector('.mp-sena-label');
            if (senaLabel) senaLabel.textContent = estadoMarca.porcentaje_sena;

            let mpOn = false;
            if (mpEscudoOK && estadoMarca.mp_total_activo) {
                if (optMpTtotal) optMpTtotal.classList.remove('hidden');
                mpOn = true;
            } else if (optMpTtotal) {
                optMpTtotal.classList.add('hidden');
            }
            if (mpEscudoOK && estadoMarca.mp_sena_activo) {
                if (optMpSena) optMpSena.classList.remove('hidden');
                mpOn = true;
            } else if (optMpSena) {
                optMpSena.classList.add('hidden');
            }
            if (!mpOn) {
                if (optMp) optMp.classList.add('hidden');
                if (mpNotice) mpNotice.classList.add('hidden');
            } else if (optMp) {
                optMp.classList.remove('hidden');
            }
            const localRadio = document.querySelector('input[value="local"]');
            const transfRadio = document.querySelector('input[value="transferencia"]');
            if (!mpOn && localRadio && (estadoMarca.pago_local_activo || !estadoMarca.transferencia_activa)) {
                localRadio.checked = true;
            } else if (!mpOn && transfRadio && estadoMarca.transferencia_activa) {
                transfRadio.checked = true;
            }
            if (estadoMarca.transferencia_activa) {
                if (optTransf) optTransf.classList.remove('hidden');
                datosTransferenciaGlobal = conf.datos_transferencia || datosTransferenciaGlobal;
            }
            if (estadoMarca.pago_local_activo) {
                if (optLocal) optLocal.classList.remove('hidden');
            }

            document.body.style.opacity = '1';
        }
    } catch(e) {
        document.body.style.opacity = '1';
    }
}

btnAbrirModal.addEventListener("click", () => { modalCatalogo.classList.remove("hidden"); document.body.style.overflow = "hidden"; });
btnCerrarModal.addEventListener("click", () => { cerrarModal(); });
function cerrarModal() { modalCatalogo.classList.add("hidden"); document.body.style.overflow = ""; }

btnShowDiscount.addEventListener("click", () => { discountWrapper.classList.toggle("hidden"); btnShowDiscount.style.display = "none"; });

// =========================================================================
// RESUMEN DE PAGO EN EL BOTÓN DE CONFIRMACIÓN
// =========================================================================
// Busca el precio de un servicio por su id dentro del catálogo (por categoría)
function buscarServicioPorId(idServicio) {
    for (const cat in catalogoServiciosGlobal) {
        const encontrado = catalogoServiciosGlobal[cat].find(svc => svc.id_servicio === idServicio);
        if (encontrado) return encontrado;
    }
    return null;
}

// Formatea un número como moneda ARS (sin decimales)
function formatearARS(valor) {
    return formatearMonedaMarca(valor);
}

// Calcula el monto final que se le cobrará al cliente
function calcularMontoServicio() {
    const servicioId = selectServicio.value;
    if (!servicioId) return null;
    const svc = buscarServicioPorId(servicioId);
    if (!svc) return null;

    let monto = parseFloat(svc.precio) || 0;
    if (cuponPorcentajeGlobal > 0) monto = monto - (monto * (cuponPorcentajeGlobal / 100));

    const tipoPago = document.querySelector('input[name="tipo_pago"]:checked')?.value || 'local';
    if (tipoPago === 'mp_sena' || tipoPago === 'sena') monto = monto * ((estadoMarca.porcentaje_sena || 25) / 100);

    return Math.round(monto);
}

// Actualiza el texto del botón principal según el método de pago y el monto
function actualizarResumenPago() {
    const monto = calcularMontoServicio();
    const tipoPago = document.querySelector('input[name="tipo_pago"]:checked')?.value || 'local';
    let etiqueta = 'Confirmar';
    if (tipoPago === 'mp_sena' || tipoPago === 'mp_total') etiqueta = 'Pagar y Confirmar';
    else if (tipoPago === 'transferencia') etiqueta = 'Confirmar y Enviar Comprobante';
    else etiqueta = 'Confirmar Turno';

    // Solo mostramos monto si ya hay una hora seleccionada (reserva lista)
    const hayHora = inputHora.value ? true : false;
    if (hayHora && monto !== null && monto > 0) {
        btnSubmit.textContent = `${etiqueta} · ${formatearARS(monto)}`;
    } else if (hayHora && monto !== null && monto === 0) {
        btnSubmit.textContent = `${etiqueta} · Gratis`;
    } else {
        btnSubmit.textContent = etiqueta;
    }
}

btnApplyDiscount.addEventListener("click", async () => {
    const codigo = inputCupon.value.trim().toUpperCase();
    if (!codigo) return;
    btnApplyDiscount.textContent = "..."; btnApplyDiscount.disabled = true; inputCupon.disabled = true;
    try {
        const res = await fetch(`${API_URL}?accion=validar_cupon&codigo=${codigo}`);
        const json = await res.json();
        if (json.status === "success") {
            cuponValidado = json.data.codigo;
            cuponPorcentajeGlobal = json.data.porcentaje || 0;
            discountMessage.textContent = `¡Felicidades! Cupón aplicado (-${json.data.porcentaje}%)`;
            discountMessage.className = "coupon-msg success"; discountMessage.classList.remove("hidden");
            btnApplyDiscount.textContent = "Aplicado"; btnApplyDiscount.style.background = "var(--success)"; btnApplyDiscount.style.color = "#000";
            actualizarResumenPago();
        } else {
            const msg = json.data?.mensaje || json.mensaje || "Cupón inválido";
            const isExpired = msg.toLowerCase().includes('expirado');
            discountMessage.textContent = msg;
            discountMessage.className = "coupon-msg error"; discountMessage.classList.remove("hidden");
            if (isExpired) discountMessage.style.color = '#fca5a5';
            btnApplyDiscount.textContent = "Aplicar"; btnApplyDiscount.disabled = false; inputCupon.disabled = false;
        }
    } catch (e) {
        discountMessage.textContent = "Error al verificar."; discountMessage.className = "coupon-msg error"; discountMessage.classList.remove("hidden");
        btnApplyDiscount.textContent = "Aplicar"; btnApplyDiscount.disabled = false; inputCupon.disabled = false;
    }
});

async function cargarServiciosVisuales() {
  try {
    const res = await fetch(`${API_URL}?accion=servicios`);
    const json = await res.json();
    if (json.status === "success") {
      catalogoServiciosGlobal = json.data.categorias; 
      // RF-05: el catálogo público llega agrupado en un objeto por categoría, así que
      // el orden alfabético se aplica DENTRO de cada categoría. Así la agrupación de
      // renderizarPills/renderizarCatalogo queda intacta y tanto las cards del catálogo
      // como las opciones del <select> heredan el mismo orden.
      for (const cat in catalogoServiciosGlobal) {
        catalogoServiciosGlobal[cat].sort((a, b) => a.nombre.localeCompare(b.nombre));
      }
      selectServicio.innerHTML = '<option value="">Seleccioná...</option>';
      for (const cat in catalogoServiciosGlobal) {
        catalogoServiciosGlobal[cat].forEach(svc => { const opt = document.createElement("option"); opt.value = svc.id_servicio; opt.textContent = svc.nombre; selectServicio.appendChild(opt); });
      }
      renderizarPills(); renderizarCatalogo(""); 
      loaderServicios.classList.add("hidden"); categoryPillsContainer.classList.remove("hidden"); listaServiciosContainer.classList.remove("hidden"); inputFecha.disabled = false; 
    }
  } catch (error) { loaderServicios.textContent = "Error cargando catálogo."; }
}

function renderizarPills() {
  categoryPillsContainer.innerHTML = '';
  const pillTodos = document.createElement("div"); pillTodos.className = `pill ${categoriaActiva === "Todos" ? "active" : ""}`; pillTodos.textContent = "Todos";
  pillTodos.addEventListener("click", () => { categoriaActiva = "Todos"; searchTratamientos.value = ""; renderizarPills(); renderizarCatalogo(""); });
  categoryPillsContainer.appendChild(pillTodos);

  for (const cat in catalogoServiciosGlobal) {
    const pill = document.createElement("div"); pill.className = `pill ${categoriaActiva === cat ? "active" : ""}`; pill.textContent = cat;
    pill.addEventListener("click", () => { categoriaActiva = cat; searchTratamientos.value = ""; renderizarPills(); renderizarCatalogo(""); });
    categoryPillsContainer.appendChild(pill);
  }
}

function renderizarCatalogo(terminoBusqueda) {
  listaServiciosContainer.innerHTML = '';
  const term = terminoBusqueda.toLowerCase().trim(); let hayResultados = false;
  if (term.length > 0 && categoriaActiva !== "Todos") { categoriaActiva = "Todos"; renderizarPills(); }

  for (const cat in catalogoServiciosGlobal) {
    if (categoriaActiva !== "Todos" && categoriaActiva !== cat) continue;
    const serviciosFiltrados = catalogoServiciosGlobal[cat].filter(svc => svc.nombre.toLowerCase().includes(term) || cat.toLowerCase().includes(term));

    if (serviciosFiltrados.length > 0) {
      hayResultados = true;
      serviciosFiltrados.forEach(svc => {
        const bgImg = svc.url_imagen ? `background-image: url('${svc.url_imagen}');` : `background: linear-gradient(135deg, var(--bg-color), var(--card-bg));`;
        const card = document.createElement("div"); card.className = "svc-card"; card.dataset.id = svc.id_servicio;
        card.innerHTML = `<div class="svc-img" style="${bgImg}"></div><div class="svc-info"><div class="svc-name">${svc.nombre}</div><div class="svc-meta"><span class="aw-time">⏱️ ${svc.duracion_minutos} min</span> <span class="aw-dot">•</span> <span class="aw-price">$ ${new Intl.NumberFormat('es-AR', {minimumFractionDigits: 2}).format(svc.precio)}</span></div></div>`;
        card.addEventListener("click", () => {
           selectServicio.value = svc.id_servicio; triggerText.textContent = svc.nombre; triggerText.classList.remove("placeholder"); btnAbrirModal.classList.add("selected");
           cerrarModal(); selectServicio.dispatchEvent(new Event('change')); 
        });
        listaServiciosContainer.appendChild(card);
      });
    }
  }
  if (!hayResultados) listaServiciosContainer.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 20px;">No encontramos "${terminoBusqueda}"</p>`;
}
if (searchTratamientos) searchTratamientos.addEventListener("input", (e) => { renderizarCatalogo(e.target.value); });

function renderProfesionales(servicioId) {
    const container = document.getElementById('profesionales-ui-container');
    if (!container) return;
    selectProfesional.value = '';

    const calificados = listaStaffGlobal.filter(p => {
        const svc = (p.servicios || '').toString().trim().toUpperCase();
        if (svc === 'TODOS' || svc === '' || !svc) return true;
        if (!servicioId) return true;
        return svc.split(',').map(s => s.trim()).includes(String(servicioId).trim().toUpperCase());
    });

    container.innerHTML = '';

    const anyCard = document.createElement('div');
    anyCard.className = 'prof-card active';
    anyCard.dataset.id = '';
    anyCard.innerHTML = `<div class="prof-avatar-fallback" style="font-size:0.75rem;">?</div><div><div class="prof-name">Cualquier especialista</div><div class="prof-tag">El sistema elige al disponible</div></div>`;
    anyCard.onclick = () => { container.querySelectorAll('.prof-card').forEach(c => c.classList.remove('active')); anyCard.classList.add('active'); selectProfesional.value = ''; checkDisponibilidad(); };
    container.appendChild(anyCard);

    calificados.forEach(p => {
        const card = document.createElement('div');
        card.className = 'prof-card';
        card.dataset.id = p.id_profesional;
        const avatarHtml = p.url_imagen
            ? `<img class="prof-avatar" src="${p.url_imagen}" alt="${p.nombre}">`
            : `<div class="prof-avatar-fallback">${(p.nombre||'?')[0]}</div>`;
        card.innerHTML = `${avatarHtml}<div><div class="prof-name">${p.nombre}</div><div class="prof-tag">Especialista</div></div>`;
        card.onclick = () => { container.querySelectorAll('.prof-card').forEach(c => c.classList.remove('active')); card.classList.add('active'); selectProfesional.value = p.id_profesional; checkDisponibilidad(); };
        container.appendChild(card);
    });

    if (calificados.length > 0) { groupProfesional.classList.remove('hidden'); }
    else { groupProfesional.classList.add('hidden'); }
}

async function handleServicioChange() {
    const servicioId = selectServicio.value;
    if (!servicioId) { groupProfesional.classList.add('hidden'); groupPago.classList.add('hidden'); checkDisponibilidad(); return; }
    slotsContainer.innerHTML = '<p id="slot-placeholder" style="color: var(--text-muted); font-size: 0.85rem; grid-column: 1 / -1; text-align: center; padding: 10px 0;">Seleccioná una fecha.</p>';
    inputHora.value = ''; btnSubmit.disabled = true; groupPago.classList.remove('hidden'); actualizarResumenPago();
    try {
        const res = await fetch(`${API_URL}?accion=profesionales`); const json = await res.json();
        if (json.status === 'success') {
            listaStaffGlobal = json.data.profesionales || [];
            renderProfesionales(servicioId);
        }
    } catch (e) {}
}

async function checkDisponibilidad() {
    const servicioId = selectServicio.value; const profesionalId = selectProfesional ? selectProfesional.value : ""; const fecha = inputFecha.value;
    inputHora.value = ''; btnSubmit.disabled = true;
    if (!servicioId || !fecha) return;
    slotsContainer.innerHTML = ''; loaderHorarios.classList.remove('hidden');
    try {
        let url = `${API_URL}?servicio=${servicioId}&fecha=${fecha}`; if (profesionalId) url += `&profesional=${profesionalId}`;
        const res = await fetch(url); const json = await res.json(); loaderHorarios.classList.add('hidden');
        
        // FIX QA: Ahora el frontend lee e informa si el backend chocó, en lugar de mentir diciendo "Agenda completa".
        if (json.status === 'success' && json.data && json.data.disponibles && json.data.disponibles.length > 0) {
            json.data.disponibles.forEach(hora => {
                const btn = document.createElement('div'); btn.className = 'slot-btn'; btn.textContent = hora;
                btn.onclick = () => { document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); inputHora.value = hora; btnSubmit.disabled = false; actualizarResumenPago(); };
                slotsContainer.appendChild(btn);
            });
        } else if (json.success === false || json.status === 'error') {
            slotsContainer.innerHTML = `<p style="color: var(--brand-pink); grid-column: 1 / -1; text-align: center; font-size: 0.85rem; padding: 10px;">Error del servidor interno: ${json.error || json.message || 'Desconocido'}</p>`;
        } else { 
            slotsContainer.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1; text-align: center; padding: 10px 0; font-size: 0.85rem;">Agenda completa para este día.</p>'; 
        }
    } catch (e) { 
        loaderHorarios.classList.add('hidden'); 
        slotsContainer.innerHTML = '<p style="color: var(--brand-pink); grid-column: 1 / -1; text-align: center; font-size: 0.85rem;">Error al contactar al servidor.</p>'; 
    }
}

async function handleReservaSubmit(e) {
    e.preventDefault();
    if (!inputHora.value) return;
    btnSubmit.textContent = 'Procesando Reserva...'; btnSubmit.disabled = true;

    const tipo_pago_seleccionado = document.querySelector('input[name="tipo_pago"]:checked')?.value || 'local';

    const payload = {
        accion: 'reservar',
        servicio: selectServicio.value,
        profesional: selectProfesional?.value || '',
        fecha: inputFecha.value,
        hora: inputHora.value,
        tipo_pago: tipo_pago_seleccionado,
        cliente: document.getElementById('input-nombre').value,
        email: document.getElementById('input-email').value,
        telefono: document.getElementById('input-telefono').value,
        cupon: cuponValidado
    };

    try {
        const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const json = await res.json();
        
        if (json.status === 'success') {
            // [INYECCIÓN: Puente de Identidad Chat]
            let puenteIdentidad = Promise.resolve();
            try {
                if (typeof nomi_chat_id !== 'undefined' && nomi_chat_id) {
                    // Busca el input de nombre (adapta el selector si es necesario)
                    let inputNombre = document.getElementById('input-nombre');
                    let nombreCliente = inputNombre ? inputNombre.value : 'Cliente';
                    
                    puenteIdentidad = fetch('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ accion: 'vincular_chat', chat_id: nomi_chat_id, alias: nombreCliente })
                    }).catch(e => console.error("Error silencioso puente chat", e));
                }
            } catch (err) {}
            if (json.data.pago_url === 'success_local') {
                if (tipo_pago_seleccionado === 'transferencia') {
                    Swal.fire({
                        title: '¡Turno Reservado!',
                        html: `<p>Por favor, realiza la transferencia para confirmar tu turno:</p>
                               <div style="background:var(--bg-color); padding:15px; border-radius:8px; margin-top:15px; font-size:0.9rem; text-align:center; font-weight:600; white-space:pre-wrap;">${datosTransferenciaGlobal}</div>
                               <p style="margin-top:15px; font-size:0.8rem; color:var(--text-muted);">Envía el comprobante por WhatsApp al estudio.</p>`,
                        icon: 'success',
                        background: 'var(--card-bg)',
                        color: 'var(--text-main)',
                        confirmButtonText: 'Entendido',
                        confirmButtonColor: 'var(--accent)'
                    }).then(() => { window.location.reload(); });
                } else {
                    Swal.fire({
                        title: '¡Turno Reservado!',
                        text: 'Te esperamos en el estudio. Recuerda ser puntual.',
                        icon: 'success',
                        background: 'var(--card-bg)',
                        color: 'var(--text-main)',
                        confirmButtonText: '¡Genial!',
                        confirmButtonColor: 'var(--accent)'
                    }).then(() => { window.location.reload(); });
                }
            } else if (json.data.pago_url) {
                await puenteIdentidad;
                window.location.href = json.data.pago_url;
            }
        } else {
            Swal.fire({ icon: 'error', title: 'Error', text: json.data?.mensaje || 'No se pudo procesar la reserva', background: 'var(--card-bg)', color: 'var(--text-main)' });
            btnSubmit.disabled = false; actualizarResumenPago();
        }
    } catch (error) {
        Swal.fire({ icon: 'error', title: 'Error de Red', text: 'Problema de conexión con el servidor.', background: 'var(--card-bg)', color: 'var(--text-main)' });
        btnSubmit.disabled = false; actualizarResumenPago();
    }
}

// FIX UI: Forzar renderizado inicial del botón de pago
window.addEventListener('load', () => {
    setTimeout(() => {
        if (typeof actualizarResumenPago === 'function') {
            actualizarResumenPago();
        }
    }, 150); // Delay de seguridad para asegurar renderizado de inputs
});

// =========================================================================
// MÓDULO CHAT ASÍNCRONO (BUZÓN) — Clientes fantasma vía localStorage
// =========================================================================
function initNomiChat() {
    // 1) Asegurar el chat_id en localStorage (UUID o fallback matemático)
    try {
        if (!nomi_chat_id) {
            nomi_chat_id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
            localStorage.setItem('nomi_chat_id', nomi_chat_id);
        }
    } catch (e) {
        nomi_chat_id = 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    // 2) Listeners: FAB, cierre, envío y Enter
    const fab = document.getElementById('nomi-chat-fab');
    const closeBtn = document.getElementById('nomi-chat-close');
    const sendBtn = document.getElementById('nomi-chat-send');
    const input = document.getElementById('nomi-chat-input');

    if (fab) fab.addEventListener('click', toggleNomiChat);
    if (closeBtn) closeBtn.addEventListener('click', toggleNomiChat);
    if (sendBtn) sendBtn.addEventListener('click', enviarMensajeNomi);
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensajeNomi(); }
        });
    }

    // 3) Teclado móvil: mantener el panel visible por encima del teclado
    if (window.visualViewport) {
        const vv = window.visualViewport;
        const ajustarTeclado = () => {
            const widget = document.getElementById('nomi-chat-widget');
            const panel = document.getElementById('nomi-chat-panel');
            if (!widget || !panel || innerWidth > 640) return;
            if (widget.classList.contains('open')) {
                panel.style.bottom = Math.max(0, (innerHeight - vv.height)) + 'px';
            } else {
                panel.style.bottom = '';
            }
        };
        vv.addEventListener('resize', ajustarTeclado);
    }
}

function toggleNomiChat() {
    const widget = document.getElementById('nomi-chat-widget');
    if (!widget) return;
    const abierto = widget.classList.toggle('open');
    const fab = document.getElementById('nomi-chat-fab');
    const panel = document.getElementById('nomi-chat-panel');
    if (fab) fab.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    if (panel) panel.setAttribute('aria-hidden', abierto ? 'false' : 'true');
    if (abierto) {
        cargarMensajesNomi();
        if (nomi_chat_interval) clearInterval(nomi_chat_interval);
        nomi_chat_interval = setInterval(cargarMensajesNomi, 10000);
        const input = document.getElementById('nomi-chat-input');
        if (input) setTimeout(() => { try { input.focus(); } catch (e) {} }, 350);
    } else {
        if (nomi_chat_interval) { clearInterval(nomi_chat_interval); nomi_chat_interval = null; }
    }
}

async function cargarMensajesNomi() {
    if (!nomi_chat_id) return;
    const contenedor = document.getElementById('nomi-chat-messages');
    if (!contenedor) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accion: 'obtener_mensajes', chat_id: nomi_chat_id })
        });
        const json = await res.json();
        // Envelope del backend: { status, code, data: { success, mensajes } }
        if (json.status === 'success' && json.data && Array.isArray(json.data.mensajes)) {
            renderMensajesNomi(json.data.mensajes);
        }
    } catch (e) { /* silencioso: el buzón nunca debe bloquear la reserva */ }
}

async function enviarMensajeNomi() {
    const input = document.getElementById('nomi-chat-input');
    if (!input || !nomi_chat_id) return;
    const texto = input.value.trim();
    if (!texto) return;
    input.value = '';
    const sendBtn = document.getElementById('nomi-chat-send');
    if (sendBtn) sendBtn.disabled = true;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accion: 'enviar_mensaje', chat_id: nomi_chat_id, remitente: 'cliente', mensaje: texto })
        });
        const json = await res.json();
        if (json.status === 'success' && json.data && Array.isArray(json.data.data) && json.data.data[0]) {
            appendMensajeNomi(json.data.data[0]);
        } else {
            cargarMensajesNomi();
        }
    } catch (e) {
        if (input) input.value = texto;
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.focus();
    }
}

function renderMensajesNomi(mensajes) {
    const contenedor = document.getElementById('nomi-chat-messages');
    if (!contenedor) return;
    contenedor.innerHTML = '';
    if (!mensajes || mensajes.length === 0) {
        const vacio = document.createElement('div');
        vacio.id = 'nomi-chat-empty';
        vacio.textContent = 'Aún no hay mensajes. Dejanos tu consulta y te la respondemos a la brevedad.';
        contenedor.appendChild(vacio);
        return;
    }
    mensajes.forEach(m => contenedor.appendChild(crearBurbujaNomi(m)));
    contenedor.scrollTop = contenedor.scrollHeight;
}

function appendMensajeNomi(m) {
    const contenedor = document.getElementById('nomi-chat-messages');
    if (!contenedor) return;
    const vacio = contenedor.querySelector('#nomi-chat-empty');
    if (vacio) vacio.remove();
    contenedor.appendChild(crearBurbujaNomi(m));
    contenedor.scrollTop = contenedor.scrollHeight;
}

function crearBurbujaNomi(m) {
    const burbuja = document.createElement('div');
    burbuja.className = 'nomi-msg ' + (m.remitente === 'cliente' ? 'nomi-msg-cliente' : 'nomi-msg-admin');
    const texto = document.createElement('span');
    texto.className = 'nomi-msg-texto';
    texto.textContent = m.mensaje || '';
    burbuja.appendChild(texto);
    if (m.created_at) {
        const hora = document.createElement('span');
        hora.className = 'nomi-msg-time';
        hora.textContent = new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        burbuja.appendChild(hora);
    }
    return burbuja;
}
