// =========================================================================
// ARCHIVO: admin.js (VERSIÓN NOMI - ESTABILIDAD TOTAL + GRÁFICO LIMPIO)
// =========================================================================

const API_URL = "/api/proxy";
const $ = id => document.getElementById(id);
const safeListen = (id, event, callback) => { const el = $(id); if (el) el.addEventListener(event, callback); };

let listaAgendaGlobal = []; 
let listaServiciosGlobal = []; 
let listaProfesionalesGlobal = [];
let listaClientesGlobal = [];

// Autocompletado de cliente en "Nueva Reserva Manual" (datalist nativo).
// Primer match gana (claves unicas) y las correcciones manuales del telefono se respetan.
let mapaClientesXNombre = new Map();
let ultimoTelefonoAutofill = null;
let gastosGlobal = [];
let categoriasGastosGlobal = [];
let dashboardTurnosFiltrados = []; 

let dashboardChart = null; 
let ultimoConteoServicios = null;
let currentPageAgenda = 1; 
let itemsPerPageAgenda = 10;
let currentPageDash = 1;
const itemsPerPageDash = 10;

// FINANZAS · paginación del listado de caja. Estado PROPIO, sin compartir con
// Agenda ni Dashboard. Copia el patrón ACTIVO de Agenda Lista (`admin.js:1450`,
// que usa `itemsPerPageAgendaLocal`); `itemsPerPageAgenda` de más arriba quedó
// muerto y no se lee en ningún lado, así que no se toca. El clamp vive en
// `aplicarFiltrosFinanzas()` y los eventos solo deciden si resetean.
let paginaFinanzasActual = 1;
let itemsPorPaginaFinanzas = 10;

// CRM · Directorio de Clientes. Estado PROPIO, sin compartir con Finanzas ni
// Agenda: son paginadores de listas distintas y acoplar los clocks haría que un
// filtro de gastos moviera la página del directorio. El clamp vive en
// `renderClientesList()` y los eventos solo deciden si resetean. "Todas" usa el
// mismo centinela 9999 que Finanzas para no inventar un segundo mecanismo.
let paginaClientesActual = 1;
let itemsPorPaginaClientes = 10;
// Espejo del conjunto YA filtrado, para que el guard de "Siguiente" calcule el
// total sin volver a derivarlo del slice. Es un caché de lectura: la autoridad
// sigue siendo `listaClientesGlobal`, que nunca se pagina.
window.clientesFiltradosActual = [];

let currentDashFilter = 'mes'; 
let currentAgendaFilter = 'mes'; 
let tableDayFilter = 'todo'; 
// ---------------------------------------------------------------------------
// MODO DE LA AGENDA (Lista / Kanban) — se persiste por separado de la sección
// ---------------------------------------------------------------------------
// El Kanban es el modo default: es la vista con la que se trabaja la ocupación
// real por profesional. La Lista queda como opción secundaria, y para volver a
// ella hay que elegirla explícitamente, así que esa preferencia se guarda aparte
// de la sección principal (poder estar en "Agenda → Lista" es un estado distinto
// de "Agenda → Kanban" y antes se perdía al refrescar).
//
// Los valores son exactamente los que ya usa `modoVistaAgenda` en el resto del
// archivo; no se inventa un tercer estado. Un valor guardado que no sea de esta
// lista se descarta y se usa el default.
const CLAVE_MODO_AGENDA = 'nomi_agenda_view';
const MODOS_AGENDA_VALIDOS = ['kanban', 'lista'];
const MODO_AGENDA_POR_DEFECTO = 'kanban';

let modoVistaAgenda = MODO_AGENDA_POR_DEFECTO;
let fechaKanban = '';
window.modoVistaAgenda = modoVistaAgenda;

const getToken = () => localStorage.getItem('aw_admin_auth_token') || localStorage.getItem('aw_admin_token');
const tokenParam = () => `token=${encodeURIComponent(getToken())}`;

let currentBase64Add = null; 
let currentBase64Edit = null;
let currentBase64ProfAdd = null;
let currentBase64ProfEdit = null;

// BUZÓN DE CONSULTAS: estado del chat asíncrono del admin
let chatIdActual = null;
let adminChatInterval = null;

// MARCA BLANCA: estado dinámico leído de configuracion_marca (defaults con conducta actual).
let zonaHorariaMarca = 'America/Argentina/Buenos_Aires';
let monedaMarca = 'ARS';
let horaAperturaMarca = '09:00';
let horaCierreMarca = '19:00';

// Formatea un número según la moneda configurada por la marca (default ARS)
function formatearMonedaAdmin(valor) {
    const num = Math.round(valor || 0);
    try {
        const localeMap = { ARS: 'es-AR', USD: 'en-US', CLP: 'es-CL', MXN: 'es-MX' };
        return new Intl.NumberFormat(localeMap[monedaMarca] || 'es-AR', { style: 'currency', currency: monedaMarca, maximumFractionDigits: 0 }).format(num);
    } catch(e) {
        return "$" + num.toLocaleString('es-AR');
    }
}

function mostrarSkeletons(containerId, tipo = 'row', cantidad = 4) {
    const container = $(containerId);
    if(!container) return;
    let html = '';
    const claseCss = tipo === 'card' ? 'skeleton sk-card' : 'skeleton sk-row';
    for(let i = 0; i < cantidad; i++) {
        html += tipo === 'table' ? `<tr><td colspan="4"><div class="skeleton sk-row"></div></td></tr>` : `<div class="${claseCss}"></div>`;
    }
    container.innerHTML = html;
}

const comprimirImagen = (file) => {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      reject(new Error('El archivo no es una imagen válida.'));
      return;
    }
    const reader = new FileReader(); reader.readAsDataURL(file);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.onload = event => {
      const img = new Image(); img.src = event.target.result;
      img.onerror = () => reject(new Error('El archivo está corrupto o no es una imagen.'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
          const MAX_WIDTH = 800; const MAX_HEIGHT = 800;
          let width = img.width; let height = img.height;
          if (width > height && width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
          else if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
          canvas.width = width; canvas.height = height; ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/webp', 0.8));
        } catch (err) { reject(err); }
      };
    };
  });
};

const handleDropzoneGenerico = async (inputId, dropzoneId, callbackBase64) => {
  const file = $(inputId).files[0]; if (!file) return;
  try {
    const base64 = await comprimirImagen(file);
    callbackBase64(base64);
    const dropzone = $(dropzoneId); dropzone.classList.add("has-image"); 
    dropzone.innerHTML = `<img src="${base64}" /><span style="display:flex; align-items:center; gap:6px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Imagen lista</span>`;
  } catch (err) { console.error("Error comprimiendo imagen:", err); mostrarToast(err.message || "Imagen inválida", "error"); }
};

safeListen("add-img-file", "change", () => handleDropzoneGenerico("add-img-file", "dropzone-add", (b64) => currentBase64Add = b64));
safeListen("edit-img-file", "change", () => handleDropzoneGenerico("edit-img-file", "dropzone-edit", (b64) => currentBase64Edit = b64));
safeListen("add-prof-img-file", "change", () => handleDropzoneGenerico("add-prof-img-file", "dropzone-add-prof", (b64) => currentBase64ProfAdd = b64));
safeListen("edit-prof-img-file", "change", () => handleDropzoneGenerico("edit-prof-img-file", "dropzone-edit-prof", (b64) => currentBase64ProfEdit = b64));

safeListen("aw-inbox-send", "click", () => enviarMensajeAdmin());
(safeListen("aw-inbox-input", "keydown", (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensajeAdmin(); } }));

document.addEventListener('DOMContentLoaded', () => { if (getToken()) { prepararArranqueAdmin(); if($("login-view")) $("login-view").classList.add("hidden"); if($("dashboard-view")) $("dashboard-view").classList.remove("hidden"); inicializarAdmin(); } });
function aplicarBrandingPreLogin() {
    const aplicar = (conf) => {
        if (!conf) return;
        if (conf.logo_login_url && $("logo-login")) $("logo-login").src = conf.logo_login_url;
        if (conf.isotipo_url && $("favicon-principal")) $("favicon-principal").href = conf.isotipo_url;
        if (conf.icono_acceso_url && $("apple-touch-principal")) $("apple-touch-principal").href = conf.icono_acceso_url;
    };
    fetch(`${API_URL}?accion=obtener_marca`)
        .then(res => (res && res.ok) ? res.json() : null)
        .then(json => aplicar(json && json.success ? json.data : null))
        .catch(() => {});
}
document.addEventListener('DOMContentLoaded', () => { if (!getToken()) aplicarBrandingPreLogin(); });
safeListen("login-form", "submit", async (e) => { e.preventDefault(); const btn = $("btn-login"); btn.textContent = "Verificando..."; try { const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "login", password: $("admin-pass").value.trim() }) }); const json = await res.json(); if (json.success) { localStorage.setItem('aw_admin_auth_token', json.data.token); location.reload(); } else { $("login-error").textContent = "Clave incorrecta"; $("login-error").classList.remove("hidden"); } } catch (err) { $("login-error").textContent = "Error"; $("login-error").classList.remove("hidden"); } finally { btn.textContent = "Ingresar"; } });
safeListen("btn-logout", "click", () => { localStorage.removeItem('aw_admin_auth_token'); localStorage.removeItem('aw_admin_token'); limpiarVistaAdminGuardada(); limpiarModoAgendaGuardado(); location.reload(); });

// =========================================================================
// NAVEGACIÓN PRINCIPAL DEL ADMIN
// -----------------------------------------------------------------------
// Antes esta lógica vivía entera dentro del listener de cada .nav-item. Se
// extrajo a una función porque el restore post-refresh necesita exactamente el
// mismo camino: si el restore togglera clases a mano se saltaría los efectos por
// sección (cupones, finanzas, poller de consultas) y la vista restaurada
// aparecería vacía.
//
// Se persiste SOLO la sección principal, que siempre es un `data-target` del
// nav. Nunca un modal: ningún id de SweetAlert2 pasa por acá, así que un refresh
// no puede reabrir un modal, una confirmación ni un overlay transitorio.
// sessionStorage (y no localStorage) porque el requerimiento es "volver a esta
// sección tras recargar, en esta pestaña": es por pestaña y no fuerza la misma
// sección en sesiones futuras.
// =========================================================================
const CLAVE_VISTA_ADMIN = 'nomi_admin_view';

// Vista de fallback: el Panel, que es la que el propio HTML declara activa
// (`admin.html`: `view-dashboard` con `.admin-view.active` y su `.nav-item
// active`). Es un valor único, no una lista: si se iterara una lista de
// defaults, el último aplicado ganaría y el fallback dejaría de ser el Panel.
const VISTA_ADMIN_POR_DEFECTO = 'view-dashboard';

// Un `data-target` es restaurable solo si tiene botón en el nav Y sección en el
// DOM. Las dos comprobaciones son necesarias: el markup puede cambiar y dejar un
// valor guardado huérfano.
const esVistaAdminValida = (target) => {
  if (!target || typeof target !== 'string') return false;
  return !!document.querySelector(`.nav-item[data-target="${target}"]`) && !!$(target);
};

const guardarVistaAdmin = (target) => { try { sessionStorage.setItem(CLAVE_VISTA_ADMIN, target); } catch (e) { /* modo privado / storage bloqueado */ } };
const leerVistaAdminGuardada = () => { try { return sessionStorage.getItem(CLAVE_VISTA_ADMIN); } catch (e) { return null; } };
const limpiarVistaAdminGuardada = () => { try { sessionStorage.removeItem(CLAVE_VISTA_ADMIN); } catch (e) { /* sin storage */ } };

const guardarModoAgenda = (modo) => { if (MODOS_AGENDA_VALIDOS.includes(modo)) { try { sessionStorage.setItem(CLAVE_MODO_AGENDA, modo); } catch (e) { /* sin storage */ } } };
const limpiarModoAgendaGuardado = () => { try { sessionStorage.removeItem(CLAVE_MODO_AGENDA); } catch (e) { /* sin storage */ } };

// Devuelve el modo guardado solo si es uno de los válidos. Cualquier otra cosa
// (null, un valor viejo, basura) devuelve null y el llamador usa el default.
const leerModoAgendaGuardado = () => {
  const v = leerModoAgendaCrudo();
  return MODOS_AGENDA_VALIDOS.includes(v) ? v : null;
};
const leerModoAgendaCrudo = () => { try { return sessionStorage.getItem(CLAVE_MODO_AGENDA); } catch (e) { return null; } };

// El toggle de tema es una sola instancia y se mueve al .view-header de la vista
// activa: antes flotaba fijo en la esquina y, con el Kanban ocupando todo el alto
// disponible, se superponía al board y al extremo del scrollbar horizontal. No se
// duplica el control ni se toca su estado: se mueve el mismo nodo, con el mismo
// id, el mismo onclick inline y el mismo localStorage.
function aplicarBotonTemaAlHeader(target) {
  const btn = $("btn-modo-vision");
  if (!btn) return;
  const header = document.querySelector(`#${target} .view-header`);
  if (!header) return;
  const ultimo = header.lastElementChild;
  // Agenda, Servicios, Equipo, Clientes y Finanzas cierran el header con un div de
  // acciones: el control entra ahí, al lado de los otros botones. Las otras cuatro
  // (Panel, Cupones, Consultas, Marca) cierran con el botón o con un span/p, y ahí
  // va como hermano dentro del header, nunca anidado dentro de otro botón.
  const destino = (ultimo && ultimo.tagName === "DIV") ? ultimo : header;
  if (btn.parentNode !== destino) destino.appendChild(btn);
}

// SOLO clases: ni fetch, ni render, ni timers. Es la mitad "visual" de la
// navegación, y existe separada de `activarVistaAdmin` para poder preparar la
// vista guardada antes de que el Admin sea visible sin disparar los efectos
// (cupones, finanzas, poller de consultas) antes de tiempo.
function aplicarVistaAdminVisual(target) {
  document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(`.nav-item[data-target="${target}"]`).forEach(b => b.classList.add("active"));
  const navActivoMovil = document.querySelector(`.mobile-bottom-nav .nav-item[data-target="${target}"]`);
  if (navActivoMovil && navActivoMovil.scrollIntoView) navActivoMovil.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  document.querySelectorAll(".admin-view").forEach(v => { v.classList.remove("active"); v.classList.add("hidden"); });
  $(target).classList.remove("hidden");
  $(target).classList.add("active");
  aplicarBotonTemaAlHeader(target);
}

// Efectos de la sección. Separado del visual a propósito: en el arranque se
// corren acá adentro de inicializarAdmin(), cuando los catálogos ya están
// cargados, y no antes.
function ejecutarEfectosVistaAdmin(target) {
  if (!esVistaAdminValida(target)) return;
  if (target === 'view-cupones') cargarCupones();
  if (target === 'view-finanzas') cargarFinanzas();
  if (target === 'admin-chat-view') { cargarChatsActivosAdmin(); iniciarPollerChatsAdmin(); } else { detenerPollerChatsAdmin(); }
}

// `persistir: false` para el restore: la vista ya está guardada y no hay que
// reescribirla (además evita escribir un valor que todavía no se validó).
function activarVistaAdmin(target, persistir = true) {
  if (!esVistaAdminValida(target)) return false;
  if (persistir) guardarVistaAdmin(target);
  aplicarVistaAdminVisual(target);
  ejecutarEfectosVistaAdmin(target);
  return true;
}

document.querySelectorAll(".nav-item[data-target]").forEach(btn => {
  btn.addEventListener("click", () => { activarVistaAdmin(btn.dataset.target); });
});

// Estado visual del selector Lista/Kanban. Usa los mismos controles de siempre
// (`#btn-toggle-agenda-vista`, `#kanban-day-nav`, `.kanban-lista-header`,
// `#agenda-pagination-controls`): no se agrega un selector nuevo. La etiqueta del
// botón dice la acción siguiente ("Ver Lista" estando en Kanban), igual que antes.
function aplicarModoAgendaVisual(modo) {
  const kanban = modo === 'kanban';
  const btn = $("btn-toggle-agenda-vista");
  const nav = $("kanban-day-nav");
  const headerCols = document.querySelector('.kanban-lista-header');
  const pagCtrl = $("agenda-pagination-controls");
  if (btn) { btn.textContent = kanban ? 'Ver Lista' : 'Ver Kanban'; btn.setAttribute('aria-label', kanban ? 'Ver la Agenda en Lista' : 'Ver la Agenda en Kanban'); }
  if (nav) nav.style.display = kanban ? 'flex' : 'none';
  if (headerCols) headerCols.style.display = kanban ? 'none' : '';
  if (pagCtrl) pagCtrl.style.display = kanban ? 'none' : '';
  // El Kanban ahora es el modo default, así que la barra de día queda visible
  // desde el arranque. Sin esto el input de fecha se vería vacío mientras el
  // board muestra hoy. Solo se rellena si está vacío: nunca pisa una fecha que
  // el admin ya eligió.
  const inputFecha = $("kanban-date");
  if (kanban && inputFecha && !inputFecha.value) inputFecha.value = fechaKanban || formatD(getBADate());
}

// Fija el modo SIN renderizar. Es lo que permite que el primer render de la
// agenda ya salga en el modo correcto: si el modo se seteara después de
// cargarAgenda(), la agenda se pintaría en Lista y después habría que repintar
// en Kanban (doble render + flash).
function establecerModoAgenda(modo, persistir = false) {
  const valido = MODOS_AGENDA_VALIDOS.includes(modo) ? modo : MODO_AGENDA_POR_DEFECTO;
  modoVistaAgenda = valido;
  window.modoVistaAgenda = valido;
  if (persistir) guardarModoAgenda(valido);
  aplicarModoAgendaVisual(valido);
  return valido;
}

// Prepara QUÉ se ve antes de que el Admin sea visible, sin disparar ningún
// efecto. Devuelve la vista válida para después correrle los efectos.
function prepararVistaAdminInicial() {
  const guardada = leerVistaAdminGuardada();
  let target = (guardada && esVistaAdminValida(guardada)) ? guardada : null;
  // Un valor guardado que ya no existe en el markup se limpia: si no, se
  // seguiría reintentando en cada refresh.
  if (guardada && !target) limpiarVistaAdminGuardada();
  if (!target) {
    // Sin nada guardado: el Panel, que además es el estado por defecto del HTML.
    if (!esVistaAdminValida(VISTA_ADMIN_POR_DEFECTO)) return null;
    target = VISTA_ADMIN_POR_DEFECTO;
  }
  aplicarVistaAdminVisual(target);
  return target;
}

let _arranqueAdminPreparado = false;
let _vistaAdminInicial = null;
let _modoAgendaInicial = MODO_AGENDA_POR_DEFECTO;

// Orden de arranque del Admin. Tiene que correr ANTES de que se le saque el
// `hidden` a #dashboard-view: si la vista se resolviera después, el Panel se
// pintaría un instante aunque lo guardado fuese Agenda (el flash Panel → Agenda).
// Tampoco dispara efectos acá: solo deja el DOM en el estado correcto para que
// el primer paint ya muestre la sección y el modo de agenda verdadeiros.
function prepararArranqueAdmin() {
  if (_arranqueAdminPreparado) return;
  const modoGuardado = leerModoAgendaGuardado();
  // Un valor guardado que no sea un modo válido se borra, igual que se hace con
  // la vista: si se dejara, se volvería a leer y descartar en cada refresh.
  if (leerModoAgendaCrudo() !== null && !modoGuardado) limpiarModoAgendaGuardado();
  _modoAgendaInicial = establecerModoAgenda(modoGuardado || MODO_AGENDA_POR_DEFECTO);
  _vistaAdminInicial = prepararVistaAdminInicial();
  _arranqueAdminPreparado = true;
}

async function inicializarAdmin() { 
  const BA_TIME = getBADate();
  const strHoy = formatD(BA_TIME);
  if($("add-res-fecha")) $("add-res-fecha").min = strHoy; if($("block-fecha")) $("block-fecha").min = strHoy;

  // La identidad visual (colores, logo) viene de la base y se aplica por JS. Se
  // adelanta a propósito: antes iba última, después de 6 awaited, y en cada
  // carga el Admin se pintaba con el tema hardcodeado del HTML hasta que
  // terminaban todas las consultas. En móvil, con la red más lenta, esa ventana
  // hacía parecer que la interfaz seguía en la versión anterior. Las dependencias
  // de datos de abajo (servicios → profesionales → agenda) no se tocan.
  await cargarConfiguracionMarca();
  const strHoyCfg = formatD(getBADate());
  if($("add-res-fecha")) $("add-res-fecha").min = strHoyCfg; if($("block-fecha")) $("block-fecha").min = strHoyCfg;
  inicializarLivePreviewMarca();
  
  await cargarServicios(); 
  await cargarProfesionales(); 
  await cargarAgenda(); 
  await cargarCategoriasGastos(); 
  await cargarGastos(); 
  await cargarClientes(); 
  
  configurarFiltrosDashboard();
  configurarFiltrosAgenda();
  configurarFiltrosTablaDashboard();

  // Efectos de la sección restaurada, acá y no antes: para entonces los catálogos
  // ya están cargados y la vista ya está visible desde el arranque. Los de
  // Finanzas, Cupones y Consultas piden datos propios, y el poller de Consultas
  // queda corriendo solo si esa es la sección restaurada.
  ejecutarEfectosVistaAdmin(_vistaAdminInicial);
}

const getBADate = (d = new Date()) => new Date(d.toLocaleString("en-US", {timeZone: zonaHorariaMarca}));
const formatD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function formatearFecha(cadena) { return cadena ? new Date(cadena + "T00:00:00").toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: 'short' }) : ""; }

function getRangoFechas(filtro, desdeId, hastaId) {
    const hoy = getBADate(); const strHoy = formatD(hoy);
    if (filtro === 'hoy') return { i: strHoy, f: strHoy };
    if (filtro === 'semana') {
        const diaSemana = hoy.getDay() === 0 ? 6 : hoy.getDay() - 1; 
        const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - diaSemana);
        const domingo = new Date(lunes); domingo.setDate(lunes.getDate() + 6);
        return { i: formatD(lunes), f: formatD(domingo) };
    }
    if (filtro === 'mes') {
        return { i: formatD(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), f: formatD(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)) };
    }
    if (filtro === 'custom') {
        const desde = $('dash-filtro-desde')?.value || formatD(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
        const hasta = $('dash-filtro-hasta')?.value || formatD(hoy);
        return { i: desde, f: hasta };
    }
    return { i: '1970-01-01', f: '2100-12-31' };
}

// DASHBOARD
function configurarFiltrosDashboard() {
    document.querySelectorAll('.filter-dash-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-dash-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
            e.target.classList.add('active'); e.target.setAttribute('aria-pressed', 'true');
            currentDashFilter = e.target.dataset.rango;
            aplicarFiltrosDashboard();
        });
    });
}

function configurarFiltrosTablaDashboard() {
    document.querySelectorAll('.t-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.t-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            tableDayFilter = e.target.dataset.dias;
            currentPageDash = 1; 
            renderDashboardTable();
        });
    });
}
safeListen('dash-btn-custom', 'click', () => {
    const desde = $('dash-filtro-desde')?.value;
    const hasta = $('dash-filtro-hasta')?.value;
    if (!desde && !hasta) { mostrarToast("Seleccioná al menos una fecha", "warning"); return; }
    if (desde && hasta && desde > hasta) { mostrarToast("La fecha 'desde' no puede ser posterior a 'hasta'", "warning"); return; }
    currentDashFilter = 'custom';
    document.querySelectorAll('.filter-dash-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    aplicarFiltrosDashboard();
});

function aplicarFiltrosDashboard() {
    const r = getRangoFechas(currentDashFilter, 'dash-desde', 'dash-hasta');
    dashboardTurnosFiltrados = listaAgendaGlobal.filter(item => item.fecha_turno >= r.i && item.fecha_turno <= r.f);
    
    let turnosValidos = 0; let ingresos = 0; let ingresosPorServicio = {}; const conteoServicios = {};
    dashboardTurnosFiltrados.forEach(item => {
        const estadoTurno = item.estado_turno || "Agendada";
        if (estadoTurno !== "Cancelada" && estadoTurno !== "Bloqueada") {
            turnosValidos++;
            const nombreServicio = item.servicio.split(" (")[0];
            conteoServicios[nombreServicio] = (conteoServicios[nombreServicio] || 0) + 1;
            const ingresoReal = parseFloat(item.ingreso_real) || 0;
            if (estadoTurno === "Completada") {
                ingresos += ingresoReal;
                ingresosPorServicio[nombreServicio] = (ingresosPorServicio[nombreServicio] || 0) + ingresoReal;
            }
        }
    });

    if($("metric-turnos-hoy")) $("metric-turnos-hoy").textContent = turnosValidos;
    if($("metric-ingresos")) $("metric-ingresos").textContent = formatearMonedaAdmin(ingresos);

    let egresosTotales = 0;
    if (Array.isArray(gastosGlobal)) {
        gastosGlobal.forEach(g => { if (g.fecha_gasto >= r.i && g.fecha_gasto <= r.f) egresosTotales += parseFloat(g.monto) || 0; });
    }
    const balance = ingresos - egresosTotales;
    if($("metric-egresos")) $("metric-egresos").textContent = formatearMonedaAdmin(egresosTotales);
    if($("metric-balance")) $("metric-balance").textContent = formatearMonedaAdmin(balance);
    let maxCount = 0; let topSvc = "-"; 
    for (const [srv, count] of Object.entries(conteoServicios)) { if (count > maxCount) { maxCount = count; topSvc = srv; } } 
    if($("metric-top-servicio")) $("metric-top-servicio").textContent = topSvc;

    currentPageDash = 1; 
    renderDashboardTable(); 
    actualizarGraficoDashboard(conteoServicios);
}

function renderDashboardTable() {
    const tbodyHoy = $("table-dashboard-hoy"); if(!tbodyHoy) return; tbodyHoy.innerHTML = '';
    const term = $("search-dashboard") ? $("search-dashboard").value.toLowerCase() : "";
    let dataToShow = dashboardTurnosFiltrados;

    if (term) dataToShow = dataToShow.filter(r => (r.cliente||"").toLowerCase().includes(term) || (r.servicio||"").toLowerCase().includes(term) || (r.estado_turno||"").toLowerCase().includes(term) || (r.estado_pago||"").toLowerCase().includes(term));
    dataToShow.sort((a, b) => new Date(`${b.fecha_turno}T${b.hora_turno}`) - new Date(`${a.fecha_turno}T${a.hora_turno}`));

    const totalItems = dataToShow.length;
    const totalPages = Math.ceil(totalItems / itemsPerPageDash) || 1;
    if (currentPageDash > totalPages) currentPageDash = totalPages;
    
    const startIndex = (currentPageDash - 1) * itemsPerPageDash;
    const paginatedData = dataToShow.slice(startIndex, startIndex + itemsPerPageDash);

    if($("dash-page-info")) $("dash-page-info").textContent = `Pág ${currentPageDash} de ${totalPages}`;
    if($("btn-dash-prev")) $("btn-dash-prev").disabled = currentPageDash === 1;
    if($("btn-dash-next")) $("btn-dash-next").disabled = currentPageDash === totalPages || totalPages === 0;

    if (paginatedData.length === 0) {
        tbodyHoy.innerHTML = `<tr><td colspan="4" align="center" style="padding:40px; color:var(--text-muted)">No hay turnos para esta selección.</td></tr>`;
    } else {
        paginatedData.forEach(r => {
            const estadoTurno = r.estado_turno || "Agendada";
            const editable = estadoTurno === "Agendada";
            let badgeClass = estadoTurno === "Cancelada" ? 'inactive' : (estadoTurno === "Bloqueada" ? 'warning' : 'active');
            let estadoCell = `<span class="badge ${badgeClass}" style="font-size:0.65rem; padding:2px 6px; margin-top:4px;">${escapeHtml(estadoTurno)}</span>`;
            if (r.estado_pago) {
                estadoCell += `<span class="badge inactive" style="font-size:0.6rem; font-weight:600; padding:1px 5px; margin-top:4px; margin-left:4px;">${escapeHtml(r.estado_pago)}</span>`;
            }
            if (editable) {
                estadoCell += `<div style="margin-top:6px; display:flex; gap:6px;">
                    <button class="btn-check completado" title="Marcar Completada" onclick="gestionarAsistencia('${r.id_reserva}', '${escapeHtml(r.estado_pago || '')}', 'Completada', '${escapeHtml(r.servicio)}')">✓</button>
                    <button class="btn-check ausente" title="Marcar Ausente" onclick="gestionarAsistencia('${r.id_reserva}', '${escapeHtml(r.estado_pago || '')}', 'Ausente', '${escapeHtml(r.servicio)}')">✕</button>
                </div>`;
            }
            tbodyHoy.innerHTML += `<tr><td><strong>${formatearFecha(r.fecha_turno).split(",")[0]}</strong><br><small style="color:var(--text-muted)">${r.fecha_turno.split("-")[2]}/${r.fecha_turno.split("-")[1]}</small></td><td><strong>${r.hora_turno.substring(0,5)}</strong></td><td><div style="font-weight:500">${r.cliente}</div>${estadoCell}</td><td>${r.servicio.split(" (")[0]}</td></tr>`;
        });
    }
}
safeListen("search-dashboard", "input", () => { currentPageDash = 1; renderDashboardTable(); });
safeListen("btn-dash-prev", "click", () => { if(currentPageDash > 1) { currentPageDash--; renderDashboardTable(); } });
safeListen("btn-dash-next", "click", () => { currentPageDash++; renderDashboardTable(); });

// ---------------------------------------------------------------------------
// BREAKPOINT ÚNICO DEL ADMIN
// ---------------------------------------------------------------------------
// 768px es el mismo corte que usa el CSS (admin.html: `@media (max-width:
// 768px)` para ocultar/mostrar el nav móvil y el layout de las vistas). Se
// centraliza acá para que JS y CSS no puedan quedar desalineados.
const ADMIN_BREAKPOINT_MOVIL = 768;
const esViewportMovilAdmin = () => window.innerWidth <= ADMIN_BREAKPOINT_MOVIL;

// El doughnut del Panel mide el viewport UNA sola vez, al crearse, para decidir
// dónde va la leyenda (abajo en móvil, a la derecha en desktop). Chart.js es
// `responsive: true`, así que el canvas se redimensiona solo, pero la posición de
// la leyenda NO se recalcula: antes de este listener, rotar el teléfono dejaba la
// leyenda de desktop en un layout mobile hasta que ocurriera un evento
// ajeno (cambio de filtro del dashboard o toggle de tema) lo redibujara.
let _resizeChartTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeChartTimer);
  _resizeChartTimer = setTimeout(() => {
    if (ultimoConteoServicios !== null && document.getElementById('dashboard-chart')) {
      actualizarGraficoDashboard(ultimoConteoServicios);
    }
  }, 250);
});

// GRÁFICO LIMPIO Y LEGIBLE (Paleta Categórica Distinta)
function actualizarGraficoDashboard(conteoServicios) {
    const canvasEl = $("dashboard-chart"); if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d'); if (dashboardChart) dashboardChart.destroy();

    const isMobile = esViewportMovilAdmin();
    const cleanPalette = ['#3841F2', '#FF3488', '#06B6D4', '#F59E0B', '#8B5CF6', '#10B981', '#F43F5E', '#EAB308'];

    ultimoConteoServicios = conteoServicios;
    const cssVar = (n, fb) => (getComputedStyle(document.body).getPropertyValue(n) || '').trim() || fb;
    const cInputBg = cssVar('--input-bg', '#22272c');
    const cCardBg = cssVar('--card-bg', '#2E343A');
    const cTextMuted = cssVar('--text-muted', '#9ba4b5');

    const sortedData = Object.entries(conteoServicios).sort((a, b) => b[1] - a[1]);
    const labels = sortedData.map(item => item[0]);
    const values = sortedData.map(item => item[1]);

    if (values.length === 0) {
        dashboardChart = new Chart(ctx, { type: 'doughnut', data: { labels: ['Sin datos'], datasets: [{ data: [1], backgroundColor: [cInputBg], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, cutout: '65%' } });
        return;
    }
    
    dashboardChart = new Chart(ctx, { 
        type: 'doughnut', 
        data: { 
            labels: labels, 
            datasets: [{ 
                data: values, 
                backgroundColor: cleanPalette, 
                borderWidth: 2, 
                borderColor: cCardBg,
                hoverOffset: 6 
            }] 
        }, 
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            layout: { padding: isMobile ? { bottom: 30, top: 10 } : { right: 20 } },
            plugins: { 
                legend: { 
                    position: isMobile ? 'bottom' : 'right',
                    labels: { color: cTextMuted, font: { family: 'system-ui', size: 12 }, padding: 16, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'circle' } 
                } 
            }, 
            cutout: '65%' 
        } 
    });
}

// CATÁLOGO
async function cargarServicios() {
  try {
    const res = await fetch(`${API_URL}?accion=list-servicios&token=${getToken()}&t=${Date.now()}`);
    const json = await res.json();
    if (json.success && json.data.servicios) {
      listaServiciosGlobal = json.data.servicios;
      // RF-05: orden alfabético por nombre en el catálogo del admin.
      // renderServiciosList() agrupa por categoría y ya ordena las categorías con
      // Object.keys(agrupados).sort(), así que ordenar la lista base implica que cada
      // categoría también queda alfabética. No afecta al resto de consumidores
      // (buscador por nombre, checks de especialidades, find por nombre en el cierre).
      listaServiciosGlobal.sort((a, b) => a.nombre.localeCompare(b.nombre));
      const cats = [...new Set(listaServiciosGlobal.map(s=>s.categoria))];
      const optionsHtml = `<option value="">Seleccionar existente...</option>` + cats.map(c=>`<option value="${c}">${c}</option>`).join('');
      if($("add-cat-select")) $("add-cat-select").innerHTML = optionsHtml; if($("edit-cat-select")) $("edit-cat-select").innerHTML = optionsHtml;
      renderServiciosList();
    }
  } catch(e) { console.error("Error cargando servicios:", e); mostrarToast("Error al cargar el catálogo", "error"); }
}

function renderServiciosList() {
    const container = $("admin-services-container"); if(!container) return; container.innerHTML = "";
    const term = $("search-servicios") ? $("search-servicios").value.toLowerCase() : "";
    const filtrados = listaServiciosGlobal.filter(s => s.nombre.toLowerCase().includes(term) || (s.categoria||"").toLowerCase().includes(term));
    if(filtrados.length === 0) { container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted); grid-column: 1/-1;">No se encontraron servicios.</div>`; return; }
    const agrupados = filtrados.reduce((acc, s) => {
      const cat = s.categoria || 'Otros';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(s);
      return acc;
    }, {});
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    // El ritmo vertical del contenedor es el de `.list-container` (16px): el
    // `gap: 2rem` que había acá peleaba con esa regla y con el `gap: 20px`
    // que el HTML traía en línea. Los grupos NO son filas de una lista, así
    // que no se les aplica el `gap: 6px` de Finanzas.
    Object.keys(agrupados).sort().forEach(cat => {
      const grupo = document.createElement('div');
      grupo.innerHTML = `<h3 style="color: var(--ui-text); font-size: 1.1rem; text-transform: uppercase; border-bottom: 1px solid var(--ui-border); padding-bottom: 0.5rem; margin-bottom: 1rem; margin-top: 0;">${cat}</h3>`;
      const subgrilla = document.createElement('div');
      subgrilla.style.display = 'grid';
      subgrilla.style.gap = '1rem';
      subgrilla.style.gridTemplateColumns = 'repeat(auto-fill, minmax(250px, 1fr))';
      agrupados[cat].forEach(s => {
        const isActivo = s.estado === "Activo"; const bgImg = s.url_imagen ? `background-image: url('${s.url_imagen}');` : `background-color: var(--ui-bg);`;
        subgrilla.innerHTML += `<div class="service-card"><div class="service-img-container" style="background-image: url('${s.url_imagen}'); background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;"><span class="badge ${isActivo ? 'active':'inactive'}" style="position:absolute; top:10px; right:10px; backdrop-filter: blur(4px);">${s.estado}</span></div><div class="service-body"><div><h4 style="margin-bottom: 4px; font-size: 1.1rem; line-height: 1.2; color: var(--panel-text);">${s.nombre}</h4><p style="color: var(--ui-text-muted); font-size: 0.85rem; margin-bottom: 12px; text-transform: uppercase;">${s.categoria}</p></div><div><div style="display:flex; justify-content: space-between; font-size: 0.9rem; align-items:center; margin-bottom: 16px;"><span style="display:flex; align-items:center; gap:4px; color: var(--ui-text);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${s.duracion_minutos} min</span><strong style="color: var(--ui-text);">$${s.precio}</strong></div><div style="display:flex; gap:8px;"><button style="flex:1; background: transparent; color: var(--ui-text); border: 1px solid var(--ui-border);" class="btn btn-secondary btn-sm" onclick="abrirEditarServicio('${s.id_servicio}', '${s.nombre}', '${s.categoria}', ${s.precio}, ${s.duracion_minutos}, '${s.url_imagen||''}')">Editar</button><button style="flex:1; background: transparent; color: ${isActivo ? 'var(--ui-text-muted)' : 'var(--ui-text-muted)'}; border: 1px solid var(--ui-border);" class="btn ${isActivo ? 'btn-danger':'btn-success'} btn-sm" onclick="toggleServicio('${s.id_servicio}')">${isActivo ? 'Desactivar':'Activar'}</button></div></div></div></div>`;
      });
      grupo.appendChild(subgrilla);
      container.appendChild(grupo);
    });
}
safeListen("search-servicios", "input", renderServiciosList);
safeListen("btn-open-add-service", "click", () => { currentBase64Add = null; const dz = $("dropzone-add"); if(dz) { dz.classList.remove("has-image"); dz.innerHTML = `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Clic para subir foto</span>`; } if($("add-img-file")) $("add-img-file").value = ""; if($("add-cat-new")) $("add-cat-new").value = ""; if($("modal-add-service")) $("modal-add-service").classList.remove("hidden"); });
safeListen("btn-close-modal-service", "click", () => { if($("modal-add-service")) $("modal-add-service").classList.add("hidden"); });
safeListen("form-add-service", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-add"); btn.textContent = "Subiendo..."; btn.disabled = true;
  const catFinal = $("add-cat-new").value.trim() || $("add-cat-select").value || 'Otros';
  const payload = { accion: "agregar_servicio", categoria: catFinal, nombre: $("add-nom").value, precio: $("add-pre").value, duracion: $("add-dur").value, token: getToken() };
  if(currentBase64Add) payload.imagen_base64 = currentBase64Add;
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
    const json = await res.json();
    if(json.success) { $("modal-add-service").classList.add("hidden"); $("form-add-service").reset(); cargarServicios(); mostrarToast("Servicio creado", "success"); }
    else { mostrarToast(json.error || "Error al crear servicio", "error"); }
  } catch (err) { console.error("Error creando servicio:", err); mostrarToast("Error de red al crear servicio", "error"); }
  finally { btn.textContent = "Guardar"; btn.disabled = false; }
});
window.abrirEditarServicio = (id, nom, cat, pre, dur, imgUrl) => { if($("edit-svc-id")) $("edit-svc-id").value=id; if($("edit-svc-nom")) $("edit-svc-nom").value=nom; if($("edit-svc-pre")) $("edit-svc-pre").value=pre; if($("edit-svc-dur")) $("edit-svc-dur").value=dur; if($("edit-cat-select")) $("edit-cat-select").value = cat; if($("edit-cat-new")) $("edit-cat-new").value = ""; currentBase64Edit = null; const dz = $("dropzone-edit"); if(dz) { if(imgUrl && imgUrl !== 'undefined' && imgUrl !== '') { dz.classList.add("has-image"); dz.innerHTML = `<img src="${imgUrl}" /><span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Cambiar foto</span>`; } else { dz.classList.remove("has-image"); dz.innerHTML = `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Clic para subir foto</span>`; } } if($("edit-img-file")) $("edit-img-file").value = ""; if($("modal-edit-service")) $("modal-edit-service").classList.remove("hidden"); };
safeListen("btn-close-edit-service", "click", () => { if($("modal-edit-service")) $("modal-edit-service").classList.add("hidden"); });
safeListen("form-edit-service", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-edit"); btn.textContent = "Actualizando..."; btn.disabled = true;
  const catFinal = $("edit-cat-new").value.trim() || $("edit-cat-select").value || 'Otros';
  const payload = { accion: "editar_servicio", id: $("edit-svc-id").value, nombre: $("edit-svc-nom").value, categoria: catFinal, precio: $("edit-svc-pre").value, duracion: $("edit-svc-dur").value, token: getToken() };
  if(currentBase64Edit) payload.imagen_base64 = currentBase64Edit;
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
    const json = await res.json();
    if(json.success) { $("modal-edit-service").classList.add("hidden"); cargarServicios(); mostrarToast("Servicio actualizado", "success"); }
    else { mostrarToast(json.error || "Error al actualizar servicio", "error"); }
  } catch (err) { console.error("Error editando servicio:", err); mostrarToast("Error de red al actualizar", "error"); }
  finally { btn.textContent = "Actualizar"; btn.disabled = false; }
});
window.toggleServicio = async (id) => { const res = await fetch(API_URL, {method: "POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify({accion:"toggle_servicio", id:id, token: getToken()})}); const json = await res.json(); if(json.success) cargarServicios(); };

// AGENDA
async function cargarAgenda() {
  try {
    const res = await fetch(`${API_URL}?accion=list-agenda&token=${getToken()}&t=${Date.now()}`);
    const json = await res.json();
    if (json.success && json.data) {
      const hoy = new Date(); hoy.setHours(0,0,0,0);
      const proximas = [];
      const pasadas = [];
      json.data.forEach(r => {
        const f = new Date(r.fecha_turno + 'T00:00:00');
        if (f >= hoy) proximas.push(r); else pasadas.push(r);
      });
      proximas.sort((a, b) => {
        const df = a.fecha_turno.localeCompare(b.fecha_turno);
        return df !== 0 ? df : a.hora_turno.localeCompare(b.hora_turno);
      });
      pasadas.sort((a, b) => {
        const df = b.fecha_turno.localeCompare(a.fecha_turno);
        return df !== 0 ? df : b.hora_turno.localeCompare(a.hora_turno);
      });
      listaAgendaGlobal = [...proximas, ...pasadas];
      aplicarFiltrosDashboard(); 
      renderAgendaList(); 
    } else if (!json.success) {
      mostrarToast(json.error || "Error al cargar agenda", "error");
    }
  } catch(e) { console.error("Error cargando agenda:", e); mostrarToast("Error al cargar la agenda", "error"); }
}

async function cargarGastos() {
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "obtener_gastos", token: getToken() }) });
    const json = await res.json();
    if (json.success && json.data) gastosGlobal = json.data.gastos || [];
    aplicarFiltrosDashboard();
  } catch(e) { console.error("Error cargando gastos:", e); }
}

async function cargarCategoriasGastos() {
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "obtener_categorias_gastos", token: getToken() }) });
    const json = await res.json();
    if (json.success && json.data) categoriasGastosGlobal = json.data.categorias || [];
  } catch(e) { console.error("Error cargando categorías:", e); }
}

// FINANCEZAS · color del tag en el listado.
// `item.color` YA viene en el movimiento que arma aplicarFiltrosFinanzas:
// para ingresos es el token interno 'var(--success)' y para egresos el
// `color_tag` de la categoría. Solo se acepta un hex o un token `var(--x)`:
// cualquier otra cosa cae en el neutro, para que un color histórico raro no
// pueda inyectar CSS dentro del `style` del tag.
const colorTagFinanzas = (color) => {
    const s = String(color == null ? '' : color).trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^var\(--[a-zA-Z0-9-]+\)$/.test(s)) return s;
    return 'var(--border)';
};

function renderizarTablaGastos(lista) {
    const container = $("finanzas-list-container"); if(!container) return;
    container.innerHTML = "";
    if(lista.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">Todavía no hay gastos registrados.</div>`;
        return;
    }
    lista.forEach(item => {
  const esIngreso = item.tipo === 'ingreso';
  const montoF = formatearMonedaAdmin(item.monto); // Ya incluye el $

  // Columnas numéricas alineadas a la derecha
  const colIngreso = esIngreso ? `<span style="font-weight: 600; color: var(--text-main);">${montoF}</span>` : `<span style="color: var(--text-muted); opacity: 0.4;">-</span>`;
  const colEgreso = !esIngreso ? `<span style="font-weight: 600; color: var(--text-main);">${montoF}</span>` : `<span style="color: var(--text-muted); opacity: 0.4;">-</span>`;

  // El TEXTO del tag se sigue viendo en var(--text-main) (lo fija el CSS
  // acotado a Finanzas, no cambia el valor de antes). El color de la categoría
  // entra solo por fondo y borde vía --fin-tag-color: usarlo en el texto
  // arriesgaría contraste con un color claro elegido por el usuario.
  const tagTinte = colorTagFinanzas(item.color);

  const accionHTML = esIngreso
    ? `<div></div>`
    : `<button class="btn btn-sm" style="border: 1px solid var(--border); color: var(--text-muted); background: transparent; cursor: pointer; padding: 4px 10px; font-size: 0.75rem; border-radius: 4px; transition: all 0.2s ease;" onmouseover="this.style.color='var(--text-main)'; this.style.borderColor='var(--text-main)';" onmouseout="this.style.color='var(--text-muted)'; this.style.borderColor='var(--border)';" onclick="eliminarGasto('${item.id}')">Anular</button>`;

  const escapeTexto = (str) => str ? str.toString().replace(/</g, "&lt;").replace(/>/g, "&gt;") : '';

  // CONCEPTO pasa a una sola línea: tag y descripción en el mismo renglón. El
  // padding vertical de la fila y el gap entre filas viven en el CSS acotado a
  // #finanzas-list-container (admin.html), no en estilos inline.
  container.innerHTML += `
    <div class="data-card finanzas-fila" style="display: grid; grid-template-columns: 120px 2.5fr 1fr 1fr 100px; gap: 15px; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.02);">
      <div style="font-size: 0.85rem; font-weight: 500;">${item.fecha.split("-").reverse().join("/")}</div>
      <div class="finanzas-concepto">
        <span class="finanzas-concepto-tag" style="--fin-tag-color: ${tagTinte};">${escapeHtml(item.titulo)}</span>
        <span class="finanzas-concepto-detalle">${escapeTexto(item.subtitulo)}</span>
      </div>
      <div style="font-size: 0.95rem; text-align: left;">${colIngreso}</div>
      <div style="font-size: 0.95rem; text-align: left;">${colEgreso}</div>
      <div style="text-align: center;">${accionHTML}</div>
    </div>
  `;
    });
}

// Búsqueda por teclado: cambia el conjunto, así que vuelve a la pág 1. Es un
// wrapper y no un reset dentro de aplicarFiltrosFinanzas porque registrar o
// anular un gasto también pasan por ahí y NO deben perder la página.
window.buscarFinanzas = function() {
    paginaFinanzasActual = 1;
    aplicarFiltrosFinanzas();
};

// Rango de fechas: cambia el conjunto por decisión del admin, así que vuelve a
// la primera página (si no, se puede quedar en una página que ya no existe).
window.aplicarRangoFinanzas = function() {
    const inicio = $("filtro-fin-inicio") ? $("filtro-fin-inicio").value : "";
    const fin = $("filtro-fin-fin") ? $("filtro-fin-fin").value : "";
    if (inicio && fin && inicio > fin) { mostrarToast("La fecha 'desde' no puede ser posterior a 'hasta'", "warning"); return; }
    paginaFinanzasActual = 1;
    aplicarFiltrosFinanzas();
};

function aplicarFiltrosFinanzas() {
    const inicio = $("filtro-fin-inicio") ? $("filtro-fin-inicio").value : "";
    const fin = $("filtro-fin-fin") ? $("filtro-fin-fin").value : "";
    const term = $("buscador-finanzas") ? $("buscador-finanzas").value.toLowerCase().trim() : "";

    let ingresosLocal = 0;
    if (Array.isArray(listaAgendaGlobal)) {
        listaAgendaGlobal.forEach(r => {
            const dentroRango = (!inicio || r.fecha_turno >= inicio) && (!fin || r.fecha_turno <= fin);
            if (dentroRango && (r.estado_turno || "") === "Completada") {
                ingresosLocal += parseFloat(r.ingreso_real) || 0;
            }
        });
    }

    let gastosFiltrados = [];
    if (Array.isArray(gastosGlobal)) {
        gastosGlobal.forEach(g => {
            const dentroRango = (!inicio || g.fecha_gasto >= inicio) && (!fin || g.fecha_gasto <= fin);
            if (!dentroRango) return;
            if (term) {
                const nota = (g.nota_descripcion || "").toLowerCase();
                const catNombre = (g.categorias_gastos && g.categorias_gastos.nombre || "").toLowerCase();
                if (!nota.includes(term) && !catNombre.includes(term)) return;
            }
            gastosFiltrados.push(g);
        });
    }
    const egresosLocal = gastosFiltrados.reduce((acc, g) => acc + (parseFloat(g.monto) || 0), 0);
    const balanceLocal = ingresosLocal - egresosLocal;

    if($("fin-metric-ingresos")) $("fin-metric-ingresos").textContent = formatearMonedaAdmin(ingresosLocal);
    if($("fin-metric-egresos")) $("fin-metric-egresos").textContent = formatearMonedaAdmin(egresosLocal);
    if($("fin-metric-balance")) $("fin-metric-balance").textContent = formatearMonedaAdmin(balanceLocal);

  let flujoCaja = [];

  // 1. Mapear Ingresos
  listaAgendaGlobal.forEach(t => {
    // Replicar las validaciones de fecha de los filtros
    if (inicio && t.fecha_turno < inicio) return;
    if (fin && t.fecha_turno > fin) return;
    if ((t.estado_turno || '') !== "Completada") return;
    
    const titulo = t.cliente + ' - ' + (t.servicio ? t.servicio.split(" (")[0] : '');
    // Aplicar buscador también a ingresos
    if (term && !titulo.toLowerCase().includes(term)) return;

    flujoCaja.push({
      tipo: 'ingreso',
      id: t.id_reserva,
      fecha: t.fecha_turno,
      titulo: 'Turno Completado',
      subtitulo: titulo,
      monto: parseFloat(t.ingreso_real) || 0,
      color: 'var(--success)'
    });
  });

  // 2. Mapear Egresos
  gastosGlobal.forEach(g => {
    if (inicio && g.fecha_gasto < inicio) return;
    if (fin && g.fecha_gasto > fin) return;
    
    const nombreCat = g.categorias_gastos ? g.categorias_gastos.nombre : 'Sin Categoría';
    const notaDesc = g.nota_descripcion || '';
    if (term && !nombreCat.toLowerCase().includes(term) && !notaDesc.toLowerCase().includes(term)) return;

    flujoCaja.push({
      tipo: 'egreso',
      id: g.id,
      fecha: g.fecha_gasto,
      titulo: nombreCat,
      subtitulo: notaDesc,
      monto: parseFloat(g.monto) || 0,
      color: g.categorias_gastos ? g.categorias_gastos.color_tag : 'var(--text-muted)'
    });
  });

  // 3. Ordenar cronológicamente (más reciente primero)
  flujoCaja.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    // Dataset COMPLETO filtrado y ordenado. Es lo que usan las métricas de más
    // arriba (que se calcularon antes, sobre el conjunto entero) y lo que lee
    // `exportarFinanzasCSV`. El slice de abajo NUNCA se asigna acá: si se
    // reasignara con la página visible, el CSV exportaría solo 10 filas.
    window.flujoCajaActual = flujoCaja;

    // Paginación. El clamp vive acá y no en los eventos, igual que Agenda
    // (`renderAgendaList`, admin.js:1452): si el conjunto se achicó (filtro,
    // gasto anulado) y la página quedó fuera de rango, se corrige en el render
    // en vez de volver arbitrariamente a la 1.
    const totalPages = Math.max(1, Math.ceil(flujoCaja.length / itemsPorPaginaFinanzas));
    if (paginaFinanzasActual > totalPages) paginaFinanzasActual = totalPages;
    if (paginaFinanzasActual < 1) paginaFinanzasActual = 1;
    const startIndex = (paginaFinanzasActual - 1) * itemsPorPaginaFinanzas;
    const pageSlice = flujoCaja.slice(startIndex, startIndex + itemsPorPaginaFinanzas);

    if($("finanzas-per-page")) $("finanzas-per-page").value = itemsPorPaginaFinanzas >= 9999 ? 'all' : String(itemsPorPaginaFinanzas);
    if($("finanzas-page-info")) $("finanzas-page-info").textContent = `Pág ${paginaFinanzasActual} de ${totalPages}`;
    if($("btn-finanzas-prev")) $("btn-finanzas-prev").disabled = paginaFinanzasActual === 1;
    if($("btn-finanzas-next")) $("btn-finanzas-next").disabled = paginaFinanzasActual === totalPages || totalPages === 0;

    renderizarTablaGastos(pageSlice);
}

async function cargarFinanzas() {
    await cargarGastos();
    aplicarFiltrosFinanzas();
}

window.eliminarGasto = async (id) => {
    const confirmado = await Swal.fire({ title: '¿Anular este registro?', text: 'El registro quedará anulado y no se sumará a los egresos.', icon: 'warning', background: 'var(--card-bg)', color: 'var(--text-main)', showCancelButton: true, confirmButtonText: 'Sí, anular', cancelButtonText: 'Cancelar', confirmButtonColor: 'var(--accent)' });
    if(!confirmado.isConfirmed) return;
    try {
        const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "eliminar_gasto", id: id, token: getToken() }) });
        const json = await res.json();
        if(!json.success) throw new Error(json.error || 'Error al eliminar');
        mostrarToast("Registro anulado", "success");
        await cargarGastos();
        cargarCategoriasGastos();
        aplicarFiltrosFinanzas();
    } catch(err) { mostrarToast(err.message || "Error al eliminar", "error"); }
};

function abrirModalGasto() {
    const opcionesCat = categoriasGastosGlobal.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('') || '<option value="">Sin categorías</option>';
    const strHoy = formatD(getBADate());
    Swal.fire({
        title: 'Registrar Gasto',
        html: `<div style="display:flex;flex-direction:column;gap:12px;text-align:left;">
          <div><label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:6px;">Categoría</label><select id="swal-categoria" style="width:100%;padding:12px;background:var(--bg-color);border:1px solid var(--border);border-radius:10px;color:var(--text-main);font-size:1rem;outline:none;">${opcionesCat}</select></div>
          <input type="text" id="swal-nota" class="swal2-input" placeholder="Nota o descripción (opcional)" style="background: var(--card-bg); color: var(--text-main); border: 1px solid var(--border); font-size: 0.9rem;">
          <div><label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:6px;">Monto</label><input type="number" id="swal-monto" min="0" value="" placeholder="0.00" style="width:100%;padding:12px;background:var(--bg-color);border:1px solid var(--border);border-radius:10px;color:var(--text-main);font-size:1rem;outline:none;"></div>
          <div><label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:6px;">Fecha</label><input type="date" id="swal-fecha" value="${strHoy}" style="width:100%;padding:12px;background:var(--bg-color);border:1px solid var(--border);border-radius:10px;color:var(--text-main);font-size:1rem;outline:none;"></div>
        </div>`,
        background: 'var(--card-bg)',
        color: 'var(--text-main)',
        showCancelButton: true,
        confirmButtonText: 'Guardar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: 'var(--accent)',
        preConfirm: async () => {
            const idCategoria = document.getElementById('swal-categoria').value;
            const monto = parseFloat(document.getElementById('swal-monto').value);
            const fecha = document.getElementById('swal-fecha').value;
            const nota = document.getElementById('swal-nota').value;
            if (!idCategoria) { Swal.showValidationMessage('Selecciona una categoría'); return false; }
            if (!monto || isNaN(monto) || monto <= 0) { Swal.showValidationMessage('Ingresa un monto válido'); return false; }
            if (!fecha) { Swal.showValidationMessage('Ingresa una fecha'); return false; }
            try {
                const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "registrar_gasto", monto: monto, fecha_gasto: fecha, id_categoria: idCategoria, nota_descripcion: nota, token: getToken() }) });
                const json = await res.json();
                if (!json.success) throw new Error(json.error || 'Error al registrar el gasto');
            } catch (err) {
                Swal.showValidationMessage(err.message);
                return false;
            }
        }
    }).then((resultado) => {
        if (resultado.isConfirmed) {
            cargarGastos();
            cargarCategoriasGastos();
            aplicarFiltrosFinanzas();
            mostrarToast("Gasto registrado", "success");
        }
    });
}

// ===========================================================================
// FINANZAS / GASTOS · ALTA MANUAL DE CATEGORÍA
// ===========================================================================
// Las categorías dejan de depender de filas precargadas o de INSERTs en SQL:
// el usuario crea la suya desde Finanzas/Gastos.
//
// El botón vive en el header de la vista y el modal es el NATIVO
// (`modal-overlay` + `modal-card`), el mismo patrón que `modal-add-cupon`:
// no se mete un Swal2 adentro del Swal2 de "Registrar Gasto".
//
// NO expone `id` ni `es_activa`: el estado sale del default true de la tabla.
const COLOR_CATEGORIA_GASTO_DEFAULT = '#9ba4b5'; // default real: esquema_maestro.sql:70

safeListen("btn-nueva-categoria", "click", () => {
    if (!$("modal-add-categoria")) return;
    $("form-add-categoria").reset();
    // El color se restaura SIEMPRE al abrir: si el usuario eligió otro y cerró
    // sin guardar, el próximo alta no debe heredar su elección.
    if ($("add-cat-color")) $("add-cat-color").value = COLOR_CATEGORIA_GASTO_DEFAULT;
    $("modal-add-categoria").classList.remove("hidden");
    if ($("add-cat-nombre")) $("add-cat-nombre").focus();
});

safeListen("btn-close-modal-categoria", "click", () => { if($("modal-add-categoria")) $("modal-add-categoria").classList.add("hidden"); });

safeListen("form-add-categoria", "submit", async (e) => {
    e.preventDefault();
    const btn = $("btn-save-categoria");
    const nombre = ($("add-cat-nombre") ? $("add-cat-nombre").value : "").trim();
    const color = ($("add-cat-color") ? $("add-cat-color").value : "").trim();
    if (!nombre) { mostrarToast("Ingresá un nombre para la categoría", "warning"); if ($("add-cat-nombre")) $("add-cat-nombre").focus(); return; }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) { mostrarToast("El color seleccionado no es válido.", "warning"); return; }
    if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
    try {
        const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "agregar_categoria_gasto", nombre: nombre, color_tag: color, token: getToken() }) });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "No se pudo crear la categoría");
        // Éxito: recién acá se recarga el catálogo. El select de "Registrar
        // Gasto" se arma desde `categoriasGastosGlobal` al abrir el modal
        // (abrirModalGasto), así que con este await la categoría ya está
        // disponible sin recargar la página.
        $("modal-add-categoria").classList.add("hidden");
        $("form-add-categoria").reset();
        if ($("add-cat-color")) $("add-cat-color").value = COLOR_CATEGORIA_GASTO_DEFAULT;
        await cargarCategoriasGastos();
        mostrarToast("Categoría creada", "success");
    } catch (err) {
        // Error: el modal SIGUE ABIERTO y los valores intactos, para corregir
        // sin volver a tipear. acá puede aparecer "Ya existe una categoría con
        // ese nombre." (precheck del backend o 23505 del índice).
        mostrarToast(err.message || "Error al crear la categoría", "error");
    } finally {
        if (btn) { btn.textContent = "Guardar categoría"; btn.disabled = false; }
    }
});

// UX-KANBAN-01: clave del bloque expandido del Kanban.
// Vive fuera del DOM a propósito: renderAgendaKanban() reemplaza
// container.innerHTML por completo, así que el estado tiene que estar en JS
// para que la tarjeta siga expandida tras un re-render (editar, mover, etc.).
// Solo una a la vez (AC-04): guardar una clave, no una lista.
// RF-03: la clave es el blockKey (`id_reserva_interno#indiceBloque`), NO el id de
// reserva. Con la unidad = turno, un turno con varios profesionales pintaba N cards
// que compartían id_reserva y abrir una expandía todas a la vez.
let tarjetaExpandidaKey = null;
// Guardia para que un drag no se interprete como click de expansión: en un
// elemento draggable, un movimiento mínimo de mouse inicia el drag y suprime
// el click. Se setea en dragstart y la consume el primer click posterior.
let dragIniciadoEn = 0;

// =======================================================================
// RF-03 · KANBAN: COMPOSICIÓN -> BLOQUES VISUALES
// -----------------------------------------------------------------------
// Una card = un bloque CONTINUO de ocupación de UN profesional dentro del
// mismo turno. Se agrupan SOLO líneas consecutivas con el mismo
// id_profesional: un profesional que reaparece más adelante genera un bloque
// aparte, porque no hay continuidad de intervalo.
//
// Es el ÚNICO lugar del código donde se decide qué es un bloque. El render, el
// drag, la expansión y el detalle leen lo que devuelve este helper; no hay una
// segunda implementación en otro renderizador.
//
// Legacy (sin `lineas`) devuelve exactamente un bloque con los valores actuales,
// así que su salida no cambia por construcción.
// =======================================================================

// "HH:MM" -> minutos desde medianoche. aMin (dentro de renderAgendaKanban) y
// parseHM (dentro de abrirModalEditarTurno) son locales; el helper de bloques
// necesita uno accesible y no conviene tocar los existentes.
window._minutosHHMM = (t) => {
  const p = String(t === null || t === undefined ? "09:00" : t).split(":").map(Number);
  return ((p[0] || 0) * 60) + (p[1] || 0);
};

// Nombres desde los catálogos YA cargados (cargarServicios/cargarProfesionales se
// resuelven antes que cargarAgenda). Solo el NOMBRE sale del catálogo: precio y
// duración de un turno existente salen siempre de los snapshots de reserva_lineas.
window._nombreServicioDeLinea = (id) => {
  const s = (listaServiciosGlobal || []).find(x => String(x.id_servicio) === String(id));
  return (s && s.nombre) || null;
};
window._nombreProfesionalDeLinea = (id) => {
  const p = (listaProfesionalesGlobal || []).find(x => String(x.id_profesional) === String(id));
  return (p && p.nombre) || null;
};

window._bloquesKanban = (turno) => {
  if (!turno) return [];
  const iniTurno = window._minutosHHMM(turno.hora_turno);
  const idReserva = turno.id_reserva;

  const finalizar = (lista) => {
    // Todos los bloques del turno necesitan saber cuántos son para decidir el drag:
    // el backend mueve el TURNO completo, así que un turno de varios bloques no
    // puede ofrecerse como arrastrable (ver tarjetaGrid).
    lista.forEach(b => { b.nBloques = lista.length; });
    return lista;
  };

  // ---------- LEGACY: una sola card, exactamente como hoy ----------
  if (!Array.isArray(turno.lineas) || turno.lineas.length === 0) {
    const dur = Math.max(parseInt(turno.duracion, 10) || 30, 10);
    return finalizar([{
      turno: turno,
      id_reserva: idReserva,
      blockKey: `${idReserva}#0`,
      id_profesional: turno.id_profesional || null,
      nombre_profesional: turno.profesional || 'Local',
      ini: iniTurno,
      fin: iniTurno + dur,
      dur: dur,
      lineas: [],
      // `texto` conserva el string de cabecera tal cual para que la card legacy se
      // pinte idéntica. `servicio_limpio` es el nombre sin el "(profesional)" que
      // armaba list-agenda, que es lo que ya muestra el detalle expandido.
      texto: turno.servicio || '',
      servicio_limpio: String(turno.servicio || '').split(' (')[0].trim(),
      servicios_n: 1,
      precio: null,
      legacy: true,
      composicion: null
    }]);
  }

  // ---------- RF-03 ----------
  const ordenadas = turno.lineas.slice().sort((a, b) => (parseInt(a.orden, 10) || 0) - (parseInt(b.orden, 10) || 0));

  // Composición completa del turno, en orden y con los snapshots crudos. Se calcula
  // una sola vez y se reparte en todos los bloques: es lo que muestra el detalle
  // expandido, para que un card muestre el turno entero y no solo su porción.
  const composicion = ordenadas.map(l => ({
    orden: l.orden,
    id_servicio: l.id_servicio,
    id_profesional: l.id_profesional,
    nombre_servicio: window._nombreServicioDeLinea(l.id_servicio),
    nombre_profesional: window._nombreProfesionalDeLinea(l.id_profesional),
    duracion_snapshot: l.duracion_snapshot,
    precio_snapshot: l.precio_snapshot
  }));

  // cursor = hora_turno; cada línea arranca cuando termina la anterior.
  let cursor = iniTurno;
  const grupos = [];
  for (let i = 0; i < ordenadas.length; i++) {
    const l = ordenadas[i];
    const dur = Math.max(parseInt(l.duracion_snapshot, 10) || 0, 0);
    const ini = cursor;
    const fin = cursor + dur;
    cursor = fin;
    const claveProf = String(l.id_profesional || '');
    const ultimo = grupos[grupos.length - 1];
    // Consecutividad en la SECUENCIA, no igualdad de profesional: si entre dos
    // líneas del mismo profesional hay una de otro, no se agrupan.
    if (ultimo && ultimo.claveProf === claveProf) {
      ultimo.lineas.push(composicion[i]);
      ultimo.fin = fin;
      ultimo.dur += dur;
    } else {
      grupos.push({ claveProf, id_profesional: l.id_profesional || null, ini, fin, dur, lineas: [composicion[i]] });
    }
  }

  return finalizar(grupos.map((g, idx) => {
    const nombres = g.lineas.map(x => x.nombre_servicio || 'Servicio');
    const precio = g.lineas.reduce((acc, x) => acc + (parseFloat(x.precio_snapshot) || 0), 0);
    return {
      turno: turno,
      id_reserva: idReserva,
      blockKey: `${idReserva}#${idx}`,
      id_profesional: g.id_profesional,
      nombre_profesional: window._nombreProfesionalDeLinea(g.id_profesional) || 'Sin asignar',
      ini: g.ini,
      fin: g.fin,
      dur: g.dur,
      lineas: g.lineas,
      texto: nombres.join(" + "),
      servicio_limpio: nombres.join(" + "),
      servicios_n: g.lineas.length,
      precio: precio,
      legacy: false,
      composicion: composicion
    };
  }));
};

// =======================================================================
// RF-03 · KANBAN: CARGA DE COMPOSICIÓN POR DÍA
// -----------------------------------------------------------------------
// list-agenda sin `fecha` es la agenda completa y no trae líneas; las líneas se
// piden para el día que se está pintando. No hay caché permanente: cada refresco
// de agenda vuelve a pedir composición, así que una mutación (crear, editar,
// mover, cancelar, cambiar fecha) trae datos frescos.
// Solo se coalescen requests simultáneos del MISMO día.
let _lineasKanbanInflight = null; // { fecha, promise }
let _lineasKanbanError = null;   // fecha cuya composición no se pudo leer

window.cargarLineasKanban = (fecha) => {
  const f = String(fecha || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return Promise.resolve();
  if (_lineasKanbanInflight && _lineasKanbanInflight.fecha === f) return _lineasKanbanInflight.promise;

  const p = (async () => {
    try {
      const res = await fetch(`${API_URL}?accion=list-agenda&fecha=${encodeURIComponent(f)}&token=${getToken()}&t=${Date.now()}`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const porId = {};
        json.data.forEach(t => { porId[String(t.id_reserva)] = Array.isArray(t.lineas) ? t.lineas : []; });
        listaAgendaGlobal.forEach(t => {
          if (String(t.fecha_turno || "").slice(0, 10) === f) t.lineas = porId[String(t.id_reserva)] || [];
        });
        _lineasKanbanError = null;
      } else {
        // Fail-closed también en el cliente: se borra lo que hubiera del día para no
        // pintar bloques con una composición vieja y se marca el error, que
        // renderAgendaKanban muestra como estado explícito en vez de cards
        // incorrectas.
        listaAgendaGlobal.forEach(t => { if (String(t.fecha_turno || "").slice(0, 10) === f) t.lineas = []; });
        _lineasKanbanError = f;
        mostrarToast(json.error || "No se pudo leer la composición de los turnos del día", "error");
      }
    } catch (e) {
      console.error("Error cargando la composición de los turnos:", e);
      listaAgendaGlobal.forEach(t => { if (String(t.fecha_turno || "").slice(0, 10) === f) t.lineas = []; });
      _lineasKanbanError = f;
      mostrarToast("No se pudo leer la composición de los turnos del día", "error");
    }
  })();

  _lineasKanbanInflight = { fecha: f, promise: p };
  p.finally(() => {
    if (_lineasKanbanInflight && _lineasKanbanInflight.promise === p) _lineasKanbanInflight = null;
  });
  return p;
};

// Punto de entrada del Kanban cuando hace falta ir a la red. El render se dispara
// recién después de resolver la composición del día, así el board no llega a
// pintarse con datos viejos. Los re-renders internos (expandir/contraer) usan el
// sync, que no vuelve a pegarle al servidor.
window.renderAgendaKanbanConLineas = async () => {
  if (modoVistaAgenda !== 'kanban') return;
  let dia = fechaKanban || formatD(getBADate());
  // Tope de vueltas: si el día no deja de cambiar (navegación disparada), se
  // renderiza igual con lo último resuelto en vez de pedir indefinidamente.
  for (let intento = 0; intento < 5; intento++) {
    await window.cargarLineasKanban(dia);
    const diaVisible = fechaKanban || formatD(getBADate());
    // Si el admin cambió de día mientras esperábamos, este render ya no
    // corresponde: se pide la composición del día que quedó visible. Sin esto se
    // pintaría el día nuevo sin `lineas` y un RF-03 se vería como legacy.
    if (diaVisible !== dia) { dia = diaVisible; continue; }
    renderAgendaKanban();
    return;
  }
};

function renderAgendaKanban() {
  try {
    const container = $("admin-agenda-container"); if (!container) return;
    const dia = fechaKanban || formatD(getBADate());
    if (!$("kanban-date")) return;
    $("kanban-date").value = dia;

    const term = $("search-agenda") ? $("search-agenda").value.toLowerCase() : "";
    let turnosDelDia = listaAgendaGlobal.filter(r => r.fecha_turno === dia);
    turnosDelDia = turnosDelDia.filter(r => (r.estado_turno || "Agendada") !== "Cancelada");
    turnosDelDia = turnosDelDia.filter(r => r.eliminado_logico !== true);
    if (term) {
      turnosDelDia = turnosDelDia.filter(r => (r.cliente || "").toLowerCase().includes(term) || (r.servicio || "").toLowerCase().includes(term));
    }
    if (obtenerFiltroEstadoAgenda()) {
      turnosDelDia = turnosDelDia.filter(r => coincideEstadoAgenda(r.estado_turno));
    }

    const PX_SLOT = 48; // 30 min de grilla
    const PX_MIN = PX_SLOT / 30; // 1.6 px por minuto (cálculos redondos)
    const aMin = (t) => { const [h, m] = String(t || "09:00").split(":").map(Number); return ((h || 0) * 60) + (m || 0); };
    const pad2 = (n) => String(n).padStart(2, "0");
    const toHM = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

    // Fail-closed en pantalla: si la composición del día no se pudo leer, no se
    // dibujan cards que representarían un RF-03 con la sola línea 1. Se dice
    // explícitamente que no se pudo leer, en lugar de mostrar algo falso.
    if (_lineasKanbanError === dia) {
      container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No se pudo leer la composición de los turnos del ${formatearFecha(dia)}.<br>Recargá la agenda para reintentar.</div>`;
      container.dataset.apertura = "";
      container.dataset.cierre = "";
      return;
    }

    // Rango dinámico: apertura→cierre de la marca, expandido si hay turnos fuera.
    let apertura = Math.floor(aMin(horaAperturaMarca) / 60) * 60;
    let cierre   = Math.ceil(aMin(horaCierreMarca) / 60) * 60;
    if (cierre <= apertura) cierre = apertura + 600;

    // RF-03: la unidad de la grilla es el BLOQUE, no el turno. Se calcula una sola
    // vez acá y de ahí en adelante todo el render (tracks, carriles, altura, labels,
    // expansión) trabaja sobre bloques.
    const bloquesDelDia = [];
    turnosDelDia.forEach(r => { window._bloquesKanban(r).forEach(b => bloquesDelDia.push(b)); });
    bloquesDelDia.forEach(b => {
      if (isFinite(b.ini)) { if (b.ini < apertura) apertura = Math.floor(b.ini / 60) * 60; if (b.ini + b.dur > cierre) cierre = Math.ceil((b.ini + b.dur) / 60) * 60; }
    });
    const totalHeight = Math.ceil((cierre - apertura) / 30) * PX_SLOT;

    // 2.2: exponemos la grilla al drop handler (apertura/cierre/snap de 30 min).
    container.dataset.apertura = String(apertura);
    container.dataset.cierre = String(cierre);
    container.dataset.pxSlot = String(PX_SLOT);
    container.dataset.diaKanban = dia;

    // Columnas: staff activo primero; "Sin asignar" al final y solo si tiene turnos.
    // Cada columna se arma con los BLOQUES cuyo id_profesional coincide con ella, así
    // un turno repartido entre varias personas aparece en todas las que corresponde.
    const profsActivos = listaProfesionalesGlobal.filter(p => p.estado === 'Activo');
    const trackCols = [];
    profsActivos.forEach(p => trackCols.push({ profesional: p, nombre: p.nombre, turnos: [] }));
    const sinAsignar = [];
    bloquesDelDia.forEach(b => {
      // String() en ambos lados: id_profesional viene como UUID desde la cabecera
      // (reservas) y desde reserva_lineas, pero el match no debe depender de que
      // uno llegue como string y el otro como otro tipo.
      const col = trackCols.find(c => c.profesional && String(c.profesional.id_profesional) === String(b.id_profesional || ''));
      (col ? col.turnos : sinAsignar).push(b);
    });
    if (sinAsignar.length > 0 || profsActivos.length === 0) {
      trackCols.push({ profesional: null, nombre: "Sin asignar", turnos: sinAsignar });
    }
    trackCols.forEach(c => c.turnos.sort((a, b) => (a.ini - b.ini) || String(a.blockKey).localeCompare(String(b.blockKey))));

    // Carriles: resuelve solapamientos en la misma columna (ej. reserva + BLOQUEADO).
    const asignarCarriles = (bloques) => {
      const lanes = [];
      bloques.forEach(b => {
        const s = b.ini;
        const dur = Math.max(b.dur, 0);
        const e = s + dur;
        let lane = lanes.findIndex(l => l.fin <= s);
        if (lane === -1) { lane = lanes.length; lanes.push({ fin: 0 }); }
        lanes[lane].fin = Math.max(lanes[lane].fin, e);
        b.__lane = lane;
      });
      return Math.max(lanes.length, 1);
    };

    // tarjetaGrid recibe un BLOQUE, no un turno. `b.turno` sigue llevando los datos de
    // cabecera (cliente, estados, contacto) para no cambiar lo que ya se mostraba.
    const tarjetaGrid = (b, nLanes) => {
      const r = b.turno;
      const sMin = b.ini;
      const dur = Math.max(b.dur, 0);
      const top = (sMin - apertura) * PX_MIN;
      const height = Math.max(dur * PX_MIN, PX_SLOT - 2);
      const ancho = 100 / nLanes;
      const start = (b.__lane || 0) * ancho;
      const estadoTurno = r.estado_turno || "Agendada";
      const isBlk = estadoTurno === "Bloqueada";
      const isComp = estadoTurno === "Completada";
      const syncAlert = r.sync_calendar === false ? `<span title="Error Calendar" style="color:var(--danger);">⚠</span>` : '';
      const cls = isBlk ? ' is-blocked' : isComp ? ' is-completed' : '';
      const horaTxt = `${(r.hora_turno || '').substring(0,5)} hs${isBlk ? ' · BLOQUEADO' : ''}`;

      // RF-03 · DRAG: el backend (reasignar_reserva) mueve el TURNO completo: la hora
      // de la cabecera y, en legacy, el profesional global. Ofrecer arrastrar una card
      // de un turno con varios bloques prometería mover solo ese profesional, que es
      // justo lo que el backend no puede hacer. Con más de un bloque no se marca la
      // card como draggable y se explica por qué. Con un solo bloque (legacy, RF-03 de
      // un servicio, RF-03 de varios servicios del mismo profesional) el drag queda
      // exactamente como estaba.
      const multiBloque = b.nBloques > 1;
      const draggable = !multiBloque;
      const avisoMulti = "Este turno tiene varios bloques. Editá el turno para cambiar su horario.";
      const title = multiBloque ? avisoMulti : `[${horaTxt}] ${r.cliente || ''} — ${b.texto} (${dur} min)`;

      const moverBtn = draggable ? `<button type="button" class="kanban-mover-btn" onclick="event.stopPropagation(); abrirModalMoverReserva('${b.id_reserva}');" title="Mover a otro profesional">⇄</button>` : '';
      // RF-02: edición integral del turno (fecha, hora, profesional y datos del cliente) desde la card.
      const editarBtn = `<button type="button" class="kanban-mover-btn kanban-edit-btn" onclick="event.stopPropagation(); abrirModalEditarTurno('${b.id_reserva}');" title="Editar turno" aria-label="Editar turno">✎</button>`;
      // RF-01: los bloqueos no son cancelables (misma regla que la vista de lista, admin.js renderAgendaList).
      const cancelarBtn = isBlk ? '' : `<button type="button" class="kanban-mover-btn kanban-cancel-btn" onclick="event.stopPropagation(); cancelarReserva('${b.id_reserva}');" title="Cancelar turno" aria-label="Cancelar turno">✕</button>`;

      // ---- UX-KANBAN-01: estado expandido ----
      // Solo cambia la ALTURA: top/left/width quedan intactos, así que la
      // geometría de la rejilla y el cálculo de hora del drop no se ven afectados.
      // Al expandir se omite el height inline y la caja la define el contenido.
      // RF-03: la clave es el blockKey, para que abrir un bloque no expanda los demás
      // del mismo turno.
      const isExp = tarjetaExpandidaKey !== null && tarjetaExpandidaKey === b.blockKey;
      const claseCard = `kanban-card${cls}${isExp ? ' is-expanded' : ''}${multiBloque ? ' is-locked' : ''}`;
      const estiloCard = isExp
        ? `top:${top}px; left:${start}%; width:calc(${ancho}% - 4px);`
        : `top:${top}px; height:${height}px; left:${start}%; width:calc(${ancho}% - 4px);`;

      // Datos del detalle: SOLO campos que ya existen en listaAgendaGlobal.
      // No se agrega ninguna llamada al backend (AC-08). Cada fila se omite
      // si el dato no existe, para no inventar ni mostrar placeholders.
      const fila = (etiqueta, valor, extra = '') => (valor
        ? `<div class="kanban-det-fila"><span class="kanban-det-label">${escapeHtml(etiqueta)}</span><span class="kanban-det-valor${extra}" title="${escapeHtml(valor)}">${escapeHtml(valor)}</span></div>`
        : '');

      // RF-03: el detalle expandido muestra la composición REAL del turno, en orden y
      // con los snapshots tal como quedaron persistidos (duración_snapshot y
      // precio_snapshot), nunca recalculados desde el catálogo. El precio del bloque
      // vive acá: la card colapsada conserva la densidad de siempre.
      const filaComp = (etiqueta, valor, extra = '') => (valor === null || valor === undefined || valor === '')
        ? ''
        : `<div class="kanban-det-fila"><span class="kanban-det-label">${escapeHtml(etiqueta)}</span><span class="kanban-det-valor${extra}" title="${escapeHtml(valor)}">${escapeHtml(valor)}</span></div>`;
      const dinero = (v) => (v === null || v === undefined) ? null : formatearMonedaAdmin(v);
      const compRf03 = (!b.legacy && Array.isArray(b.composicion) && b.composicion.length > 0)
        ? `<div class="kanban-det-bloque">
             <div class="kanban-det-subtitulo">Composición del turno · ${b.composicion.length} ${b.composicion.length === 1 ? 'servicio' : 'servicios'}</div>
             ${b.composicion.map((l, i) => `
               <div class="kanban-det-linea">
                 <span class="kanban-det-orden">${i + 1}</span>
                 <div class="kanban-det-linea-body">
                   <div class="kanban-det-linea-nombre" title="${escapeHtml(l.nombre_servicio || 'Servicio')}">${escapeHtml(l.nombre_servicio || 'Servicio')}</div>
                   ${filaComp('Profesional', l.nombre_profesional, ' is-wrap')}
                   ${filaComp('Duración', `${l.duracion_snapshot} min`)}
                   ${filaComp('Precio', dinero(l.precio_snapshot))}
                 </div>
               </div>`).join('')}
             ${fila('Ingreso registrado', dinero(r.ingreso_real))}
           </div>`
        : '';

      // Misma clasificación de badges que la vista de lista (renderAgendaList).
      const badgePago = r.estado_pago
        ? `<span class="badge inactive">${escapeHtml(r.estado_pago)}</span>` : '';
      const detalle = isExp ? `
        <div class="kanban-det">
          <div class="kanban-det-badges">
            <span class="badge ${estadoTurno === 'Cancelada' ? 'inactive' : (estadoTurno === 'Bloqueada' ? 'warning' : 'active')}">${escapeHtml(estadoTurno)}</span>
            ${badgePago}
          </div>
          ${fila('Teléfono', r.telefono || '')}
          ${fila('Email', r.email || '', ' is-wrap')}
          ${b.legacy ? fila('Servicio', b.servicio_limpio) : ''}
          ${b.legacy ? fila('Profesional', r.profesional || '') : ''}
          ${fila('Cuándo', `${formatearFecha(r.fecha_turno)} · ${(r.hora_turno || '').substring(0,5)} hs`)}
          ${compRf03}
          ${multiBloque ? `<div class="kanban-det-hint">${escapeHtml(avisoMulti)}</div>` : ''}
          <div class="kanban-det-hint">Clic para cerrar</div>
        </div>` : '';

      // Contenido colapsado: hora, cliente, servicio/servicios y cantidad+duración.
      // Legacy conserva su línea única exacta; RF-03 separa los nombres del contador
      // para que "Corte clásico + Barba" no se mezcle con "2 servicios · 50 min".
      const svc = b.legacy
        ? `<div class="kanban-svc">${escapeHtml(b.texto)} · ${dur} min</div>`
        : `<div class="kanban-svc" title="${escapeHtml(b.texto)}">${escapeHtml(b.texto)}</div><div class="kanban-svc is-meta">${b.servicios_n} ${b.servicios_n === 1 ? 'servicio' : 'servicios'} · ${dur} min</div>`;

      return `<div class="${claseCard}" draggable="${draggable}" data-block-key="${escapeHtml(b.blockKey)}" data-drag-reserva="${b.id_reserva}" title="${escapeHtml(title)}" role="button" tabindex="0" aria-expanded="${isExp}" aria-label="${escapeHtml(`${r.cliente || 'Turno'} · ${horaTxt} · ${b.texto}`)}" style="${estiloCard}"><div class="kanban-hora${isBlk ? ' is-blk' : ''}">${horaTxt}<span class="kanban-caret" aria-hidden="true">${isExp ? '▴' : '▾'}</span></div><div class="kanban-cliente">${escapeHtml(r.cliente || '')}${syncAlert}</div>${svc}${detalle}${moverBtn}${editarBtn}${cancelarBtn}</div>`;
    };

    const hacerTrack = (c) => {
      const nLanes = asignarCarriles(c.turnos);
      const cards = c.turnos.map(r => tarjetaGrid(r, nLanes)).join('');
      const hint = c.turnos.length === 0 ? `<div class="kanban-empty-hint">Sin turnos</div>` : '';
      const trackProf = (c.profesional && c.profesional.id_profesional) ? c.profesional.id_profesional : '';
      return `<div class="kanban-track"><div class="kanban-track-header"><span class="kanban-prof-nombre">${escapeHtml(c.nombre)}</span><span class="kanban-col-count">${c.turnos.length}</span></div><div class="kanban-track-body" data-track-prof="${trackProf}" style="height:${totalHeight}px;">${cards}${hint}${nowLineHTML}</div></div>`;
    };

    let nowLineHTML = '';
    if (dia === formatD(getBADate())) {
      const now = getBADate();
      const nM = (now.getHours() * 60) + now.getMinutes();
      if (nM >= apertura && nM <= cierre) {
        nowLineHTML = `<div class="kanban-now-line" style="top:${(nM - apertura) * PX_MIN}px;"></div>`;
      }
    }

    let board = `<div class="kanban-grid">`;
    board += `<div class="kanban-gutter"><div class="kanban-gutter-header"></div><div class="kanban-gutter-inner" style="height:${totalHeight}px;">`;
    for (let m = apertura; m <= cierre; m += 30) {
      const major = (m % 60) === 0;
      board += `<div class="kanban-time-label${major ? ' is-hour' : ''}" style="top:${(m - apertura) * PX_MIN}px;">${major ? toHM(m) : '·'}</div>`;
    }
    board += `</div></div>`;
    board += trackCols.map(hacerTrack).join('');
    board += `</div>`;

    if (turnosDelDia.length === 0 && profsActivos.length === 0) {
      board = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No hay turnos para este día.</div>`;
    }
    container.innerHTML = board;
  } catch (e) {
    console.error("Error renderizando kanban:", e);
    // Respaldo por error de render, no una elección del admin: se pasa a Lista
    // para que la agenda siga siendo usable, pero NO se persiste, así el próximo
    // refresh vuelve al modo preferido. Se usa el helper para que el toggle y la
    // barra de día no queden mostrando Kanban sobre una lista.
    establecerModoAgenda('lista', false);
    renderAgendaList();
  }
}

function renderAgendaList() {
  // En Kanban se entra por el wrapper async: hace falta la composición del día para
  // poder pintar los bloques. El board anterior queda en el DOM hasta que llega la
  // nueva, así no se ve un regr flicker con datos viejos.
  if (modoVistaAgenda === 'kanban') { window.renderAgendaKanbanConLineas(); return; }
  const containerAgenda = $("admin-agenda-container"); if(!containerAgenda) return;
  const term = $("search-agenda") ? $("search-agenda").value.toLowerCase() : "";
  let baseList = listaAgendaGlobal.slice().reverse().filter(r => r.eliminado_logico !== true);

  // Filtro por rango de fechas (hoy / mes / todo)
  const rango = getRangoFechas(currentAgendaFilter, null, null);
  if (currentAgendaFilter && currentAgendaFilter !== 'todo') {
    baseList = baseList.filter(item => item.fecha_turno >= rango.i && item.fecha_turno <= rango.f);
  }

  if (term) { baseList = baseList.filter(item => (item.cliente||"").toLowerCase().includes(term) || (item.servicio||"").toLowerCase().includes(term) || (item.estado_turno||"").toLowerCase().includes(term) || (item.estado_pago||"").toLowerCase().includes(term)); }

  // Filtro por estado operativo ("" = todos). Va antes de la captura para que el CSV-export lo respete.
  if (obtenerFiltroEstadoAgenda()) { baseList = baseList.filter(item => coincideEstadoAgenda(item.estado_turno)); }

  window.agendaFiltradaActual = baseList; // Capturamos el array que se está renderizando

  // Paginación
  const perPage = itemsPerPageAgendaLocal;
  const totalPages = Math.max(1, Math.ceil(baseList.length / perPage));
  if (currentPageAgenda > totalPages) currentPageAgenda = totalPages;
  const startIndex = (currentPageAgenda - 1) * perPage;
  const pageSlice = baseList.slice(startIndex, startIndex + perPage);

  if($("agenda-page-info")) $("agenda-page-info").textContent = `Pág ${currentPageAgenda} de ${totalPages}`;
  if($("agenda-per-page")) $("agenda-per-page").value = perPage >= 9999 ? 'all' : String(perPage);
  if($("btn-agenda-prev")) $("btn-agenda-prev").disabled = currentPageAgenda === 1;
  if($("btn-agenda-next")) $("btn-agenda-next").disabled = currentPageAgenda === totalPages || totalPages === 0;

  containerAgenda.innerHTML = pageSlice.length === 0 ? `<div style="text-align:center; padding:40px; color:var(--text-muted);">No hay reservas.</div>` : '';
  pageSlice.forEach(r => {
    const estadoTurno = r.estado_turno || "Agendada";
    const isCanc = estadoTurno === "Cancelada"; const isBlk = estadoTurno === "Bloqueada"; const tel = (r.telefono||"").replace(/\D/g, '');
    const syncAlert = r.sync_calendar === false ? `<span title="Error Calendar" style="color:var(--danger); margin-left:5px;">⚠️</span>` : '';
    const badgePago = r.estado_pago ? `<span class="badge inactive" style="margin-left:5px; font-size:0.7rem; font-weight:600;">${escapeHtml(r.estado_pago)}</span>` : '';
    containerAgenda.innerHTML += `<div class="data-card"><div class="agenda-grid"><div><strong>${formatearFecha(r.fecha_turno)}</strong><br><small style="color:var(--text-muted)">${r.hora_turno.substring(0,5)} hs</small></div><div><div style="font-weight: 500; margin-bottom:4px;">${escapeHtml(r.cliente)}${syncAlert}</div>${tel && !isBlk ? `<a href="https://wa.me/${tel}" target="_blank" class="whatsapp-btn">WhatsApp</a>` : `<span style="color:var(--text-muted); font-size:0.8rem;">${escapeHtml(r.telefono)||'-'}</span>`}</div><div style="font-size:0.85rem; color:var(--text-muted);">${escapeHtml(r.servicio)}</div><div><span class="badge ${isCanc ? 'inactive' : isBlk ? 'warning' : 'active'}">${escapeHtml(estadoTurno)}</span>${badgePago}</div><div style="text-align: right;">${(!isCanc && !isBlk) ? `<button class="btn btn-danger btn-sm" onclick="cancelarReserva('${r.id_reserva}')">CANCELAR</button>` : ''}<button class="btn btn-danger btn-sm" title="Eliminar (oculta, conserva ingresos)" aria-label="Eliminar turno" onclick="eliminarReserva('${r.id_reserva}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6"/></svg></button></div></div></div>`;
  });
}
safeListen("search-agenda", "input", renderAgendaList);

function toggleVistaAgenda() {
  const nuevo = modoVistaAgenda === 'kanban' ? 'lista' : 'kanban';
  // Cambio explícito del admin: se persiste. El default (Kanban) NO se persiste
  // al entrar por primera vez, así "nunca elegí" y "elegí Kanban" se comportan
  // igual y no se distingue nada que sirva.
  establecerModoAgenda(nuevo, true);
  if (nuevo === 'kanban') {
    fechaKanban = fechaKanban || formatD(getBADate());
    // Entra por el wrapper async: la composición del día puede no estar cargada
    // todavía (la vista de lista pide la agenda completa, sin `lineas`).
    window.renderAgendaKanbanConLineas();
  } else {
    renderAgendaList();
  }
}

function moverDiaKanban(deltaDias) {
  const base = fechaKanban ? new Date(fechaKanban + 'T12:00:00') : getBADate();
  base.setDate(base.getDate() + deltaDias);
  fechaKanban = formatD(base);
  // Cambiar de día cambia la composición a resolver: siempre fresco.
  window.renderAgendaKanbanConLineas();
}

safeListen("btn-toggle-agenda-vista", "click", toggleVistaAgenda);
safeListen("btn-kanban-prev", "click", () => moverDiaKanban(-1));
safeListen("btn-kanban-next", "click", () => moverDiaKanban(1));
safeListen("btn-kanban-hoy", "click", () => { fechaKanban = formatD(getBADate()); window.renderAgendaKanbanConLineas(); });
safeListen("kanban-date", "change", (e) => { fechaKanban = e.target.value; window.renderAgendaKanbanConLineas(); });

// FASE 2: Drag & Drop delegado en la grilla
// 2.2: cambio de profesional (columnas) + cambio de horario (vertical, snap 30 min).
{
  const agendaContainer = $("admin-agenda-container");
  const previewEl = document.createElement("div");
  previewEl.className = "kanban-drop-preview";
  let contenedorActual = null;
  let rafScheduled = false;
  let lastDragEvent = null;

  const quitarPreviews = (ctx) => {
    if (ctx === agendaContainer) {
      previewEl.remove();
      contenedorActual = null;
      if (agendaContainer) agendaContainer.querySelectorAll(".kanban-track-body").forEach(t => t.classList.remove("drag-over"));
      return;
    }
    if (ctx && previewEl.parentNode === ctx) previewEl.remove();
    if (ctx && ctx.classList) ctx.classList.remove("drag-over");
    if (ctx && ctx === contenedorActual) contenedorActual = null;
  };

  const pintarPreview = (e, contenedor) => {
    if (!agendaContainer) return;
    const apertura = Number(agendaContainer.dataset.apertura) || 540;
    const pxSlot = Number(agendaContainer.dataset.pxSlot) || 48;
    if (contenedorActual !== contenedor) contenedorActual = contenedor;
    const rect = contenedor.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    let nuevaMin = apertura + Math.round(offsetY / pxSlot) * 30;
    if (nuevaMin < apertura) nuevaMin = apertura;
    const topPx = (nuevaMin - apertura) * (pxSlot / 30);
    if (topPx < 0 || topPx > contenedor.clientHeight) {
      if (previewEl.parentNode === contenedor) previewEl.remove();
      return;
    }
    if (previewEl.parentNode !== contenedor) {
      previewEl.className = "kanban-drop-preview" + (contenedor.classList.contains("kanban-gutter-inner") ? " is-gutter" : "");
      contenedor.appendChild(previewEl);
    }
    previewEl.style.top = topPx + "px";
  };

  const programarPintar = (e) => {
    lastDragEvent = e;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      const ev = lastDragEvent;
      if (!ev) return;
      const trackBodyX = ev.target.closest(".kanban-track-body");
      const gutterX = ev.target.closest(".kanban-gutter");
      const ctx = trackBodyX || (gutterX ? (gutterX.querySelector(".kanban-gutter-inner") || gutterX) : null);
      if (ctx) pintarPreview(ev, ctx);
    });
  };

  const calcularHoraDrop = (e, contenedor) => {
    const apertura = Number(agendaContainer.dataset.apertura);
    const pxSlot = Number(agendaContainer.dataset.pxSlot) || 48;
    const rect = contenedor.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const base = (isFinite(apertura) && apertura >= 0) ? apertura : 540;
    let nuevaMin = base + Math.round(offsetY / pxSlot) * 30;
    if (nuevaMin < base) nuevaMin = base;
    return `${String(Math.floor(nuevaMin / 60)).padStart(2, "0")}:${String(nuevaMin % 60).padStart(2, "0")}`;
  };

  if (agendaContainer) {
    agendaContainer.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".kanban-card");
      if (!card || !card.dataset.dragReserva) return;
      // RF-03: una card de un turno con varios bloques NO es draggable. El backend
      // mueve el turno completo, así que arrastrar una sola pieza sería una
      // interacción que promete algo que no ocurre. El atributo draggable ya viene en
      // false desde tarjetaGrid; este guard es la red por si el navegador igual
      // emite el evento.
      if (card.getAttribute("draggable") === "false") { e.preventDefault(); return; }
      // UX-KANBAN-01: marcar que empezó un drag, para que el click de cierre no
      // se interprete como una selección de tarjeta.
      dragIniciadoEn = Date.now();
      e.dataTransfer.setData("text/plain", card.dataset.dragReserva);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => card.classList.add("is-dragging"));
    });
    agendaContainer.addEventListener("dragend", (e) => {
      const card = e.target.closest(".kanban-card");
      if (card) card.classList.remove("is-dragging");
      agendaContainer.querySelectorAll(".kanban-track-body").forEach(t => t.classList.remove("drag-over"));
      quitarPreviews(agendaContainer);
      rafScheduled = false;
      lastDragEvent = null;
      // Red de seguridad: si el navegador no emite click tras el drag, la
      // bandera no debe quedar bloqueando la próxima expansión.
      setTimeout(() => { dragIniciadoEn = 0; }, 400);
    });
    agendaContainer.addEventListener("dragover", (e) => {
      const trackBody = e.target.closest(".kanban-track-body");
      const gutter = e.target.closest(".kanban-gutter");
      if (!trackBody && !gutter) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      programarPintar(e);
    });
    agendaContainer.addEventListener("dragleave", (e) => {
      const trackBody = e.target.closest(".kanban-track-body");
      const gutter = e.target.closest(".kanban-gutter");
      if (trackBody && !trackBody.contains(e.relatedTarget)) {
        trackBody.classList.remove("drag-over");
        quitarPreviews(trackBody);
      }
      if (gutter && !gutter.contains(e.relatedTarget)) quitarPreviews(gutter.querySelector(".kanban-gutter-inner") || gutter);
    });
    agendaContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      const idReserva = e.dataTransfer.getData("text/plain");
      const trackBody = e.target.closest(".kanban-track-body");
      const gutter = e.target.closest(".kanban-gutter");
      agendaContainer.querySelectorAll(".kanban-track-body").forEach(t => t.classList.remove("drag-over"));
      quitarPreviews(agendaContainer);
      if (!idReserva) return;

      let destinoId;
      let nuevaHora = null;
      if (trackBody) {
        const destino = trackBody.dataset.trackProf || "";
        destinoId = destino === "" ? null : destino;
        nuevaHora = calcularHoraDrop(e, trackBody);
      } else if (gutter) {
        const turno = listaAgendaGlobal.find(r => r.id_reserva === idReserva);
        if (!turno) return;
        destinoId = (turno.id_profesional === null || turno.id_profesional === undefined || turno.id_profesional === '') ? null : String(turno.id_profesional);
        nuevaHora = calcularHoraDrop(e, gutter.querySelector(".kanban-gutter-inner") || gutter);
      } else {
        return;
      }
      abrirModalMoverReserva(idReserva, destinoId, nuevaHora);
    });

    // ---- UX-KANBAN-01: expandir / contraer la tarjeta ----
    // Listener delegado en el mismo container que el drag & drop, así que se
    // registra una sola vez y sigue funcionando tras cada re-render del Kanban.
    // RF-03: la clave es el blockKey (`id_reserva_interno#indiceBloque`), no el id de
    // reserva. Con la unidad = bloque, abrir un bloque NO expande los demás del mismo
    // turno, aunque todos compartan id_reserva_interno.
    const alternarTarjeta = (blockKey) => {
      if (blockKey === null || blockKey === undefined) return;
      tarjetaExpandidaKey = (tarjetaExpandidaKey === blockKey) ? null : blockKey;
      // renderAgendaKanban() reemplaza innerHTML y destruye el elemento que
      // tenía el foco, así que el flujo de teclado se perdía a mitad de camino
      // (Enter expandía y después Escape ya no llegaba al listener). Se guarda el
      // foco si estaba dentro de una tarjeta y se restaura en la nueva.
      const activo = document.activeElement;
      const idActivo = (activo && activo.closest) ? activo.closest('.kanban-card') : null;
      const keyFoco = idActivo ? idActivo.dataset.blockKey : null;
      // El .kanban-grid es parte del board que renderAgendaKanban() reemplaza por
      // innerHTML, así que el scrollport viejo se destruye y el nuevo arranca en 0:
      // por eso expandir o contraer una card teletransportaba el tablero al inicio
      // del día (y perdía la columna con scroll horizontal). Se guarda el scroll del
      // grid actual y se restaura en el nuevo.
      // No hace falta requestAnimationFrame: acá se llama al render directo, sin el
      // wrapper async, así que es sincrónico y el setter de scrollTop fuerza el
      // layout del markup nuevo, que ya trae las alturas fijas en px. Va después del
      // focus() para que la última mutación del DOM sea la del scroll.
      // Solo aplica al expand/collapse: el cambio de día, los filtros y la búsqueda
      // entran por otro llamador y arrancan arriba como siempre.
      const gridPrevio = agendaContainer.querySelector('.kanban-grid');
      const scrollPrevioTop = gridPrevio ? gridPrevio.scrollTop : null;
      const scrollPrevioLeft = gridPrevio ? gridPrevio.scrollLeft : null;
      renderAgendaKanban();
      if (keyFoco !== null && keyFoco !== undefined) {
        const nueva = agendaContainer.querySelector(`.kanban-card[data-block-key="${keyFoco}"]`);
        if (nueva) nueva.focus({ preventScroll: true });
      }
      const gridNuevo = agendaContainer.querySelector('.kanban-grid');
      if (gridNuevo && scrollPrevioTop !== null) {
        gridNuevo.scrollTop = scrollPrevioTop;
        gridNuevo.scrollLeft = scrollPrevioLeft;
      }
    };
    window.alternarTarjetaKanban = alternarTarjeta;

    agendaContainer.addEventListener("click", (e) => {
      // Un drag suprime el click del navegador: si acaba de empezar uno, este
      // click es el final de esa interacción, no una intención de expandir.
      if (dragIniciadoEn && (Date.now() - dragIniciadoEn) < 400) { dragIniciadoEn = 0; return; }
      // Los botones de la tarjeta hacen stopPropagation en su onclick inline, así
      // que no llegan acá. El guard es defensivo para que igual nunca se mezclen.
      if (e.target.closest('.kanban-mover-btn')) return;
      const card = e.target.closest('.kanban-card');
      if (!card || !card.dataset.blockKey) return;
      alternarTarjeta(card.dataset.blockKey);
    });

    // Teclado: la tarjeta es role="button" (no puede ser un <button> real porque
    // ya contiene 3 botones anidados, que es HTML inválido).
    agendaContainer.addEventListener("keydown", (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.target.closest('.kanban-mover-btn')) return;
      const card = e.target.closest('.kanban-card');
      if (!card || !card.dataset.blockKey) return;
      e.preventDefault(); // Space no debe hacer scroll de la página
      alternarTarjeta(card.dataset.blockKey);
    });

    // Escape se escucha a nivel documento a propósito: si el usuario expandió
    // con el mouse, el foco está en <body> y un listener en el container no
    // recibiría la tecla.
    document.addEventListener("keydown", (e) => {
      if (e.key !== 'Escape' || tarjetaExpandidaKey === null) return;
      if (!agendaContainer.contains(document.activeElement) && document.activeElement !== document.body) return;
      e.stopPropagation();
      alternarTarjeta(tarjetaExpandidaKey);
    });

    // Clic en cualquier otro lado del board: contrae. Se escucha en pointerdown
    // para que contraiga antes de que se abra un modal de otro turno.
    agendaContainer.addEventListener("pointerdown", (e) => {
      if (tarjetaExpandidaKey === null) return;
      if (e.target.closest('.kanban-card')) return;
      alternarTarjeta(tarjetaExpandidaKey);
    });
  }
}

const movimientosEnVuelo = new Set();
window.abrirModalMoverReserva = async (idReserva, destinoId, nuevaHora) => {
  try {
    const turno = listaAgendaGlobal.find(r => r.id_reserva === idReserva);
    if (!turno) { mostrarToast("No se encontró el turno", "error"); return; }

    const actualId = (turno.id_profesional === null || turno.id_profesional === undefined || turno.id_profesional === '') ? null : String(turno.id_profesional);
    const nombreActual = actualId === null ? "Sin asignar" : (turno.profesional || "Local");

    const parseHM = (t) => { const partes = String(t || "").split(":").map(Number); return (partes[0] || 0) * 60 + (partes[1] || 0); };
    const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const cont = document.getElementById("admin-agenda-container");
    const aperturaHorario = Number(cont ? cont.dataset.apertura : NaN);
    const cierreHorario = Number(cont ? cont.dataset.cierre : NaN);
    const a = (isFinite(aperturaHorario) && aperturaHorario >= 0) ? aperturaHorario : parseHM(horaAperturaMarca || "09:00");
    const c = (isFinite(cierreHorario) && cierreHorario >= 0) ? cierreHorario : Math.max(parseHM(horaCierreMarca || "19:00"), a + 600);
    const duracionTurno = Math.max(parseInt(turno.duracion, 10) || 30, 10);
    const maxStart = c - duracionTurno;
    const clampHora = (min) => {
      let v = Math.round(min / 30) * 30;
      if (v < a) v = a;
      if (v > maxStart) v = Math.floor(maxStart / 30) * 30;
      if (v < a) v = a;
      return v;
    };

    const horaActualMin = parseHM(turno.hora_turno);
    let nuevaMin = null;
    if (nuevaHora) nuevaMin = clampHora(parseHM(nuevaHora));
    const horaCambia = nuevaMin !== null && nuevaMin !== horaActualMin;

    // Enmienda 2.2: el bloqueo por "mismo profesional" solo aplica si la hora NO cambia.
    const esSelector = destinoId === undefined;
    if (!esSelector) {
      const destNormal = (destinoId === null || destinoId === '') ? null : String(destinoId);
      if (destNormal === actualId && !horaCambia) {
        if (destNormal === null) { mostrarToast("Este turno ya está sin profesional asignado", "info"); return; }
        const nA = listaProfesionalesGlobal.find(p => p.id_profesional === actualId)?.nombre || "ese profesional";
        mostrarToast(`Este turno ya está asignado a ${nA}`, "info"); return;
      }
    }

    const dirDest = esSelector ? null : destinoId;
    const nombreDestino = dirDest === null ? "Sin asignar" : (listaProfesionalesGlobal.find(p => p.id_profesional === dirDest)?.nombre || "Otro profesional");

    let htmlModal;
    if (esSelector) {
      const duracionSel = Math.max(parseInt(turno.duracion, 10) || 30, 10);
      const proOptions = listaProfesionalesGlobal.filter(p => p.estado === 'Activo')
        .map(p => `<option value="${p.id_profesional}" data-label="${escapeHtml(p.nombre)}">${escapeHtml(p.nombre)}</option>`).join('');
      const slotOptions = [`<option value="" data-label="Mantener hora actual">Mantener hora actual</option>`];
      for (let m = a; m <= maxStart; m += 30) {
        slotOptions.push(`<option value="${fmtHM(m)}" data-label="${fmtHM(m)} hs">${fmtHM(m)} hs</option>`);
      }
      htmlModal = `
        <div style="text-align:left; font-size:0.92rem; line-height:1.6; color:var(--text-main);">
          <div style="margin-bottom:10px;"><strong>${escapeHtml(turno.cliente || "")}</strong><br><span style="color:var(--text-muted)">${escapeHtml(turno.servicio || "")} · ${formatearFecha(turno.fecha_turno)} ${(turno.hora_turno || "").substring(0,5)} hs</span></div>
          <div style="margin-bottom:12px;"><span style="color:var(--text-muted);">Actual:</span> <strong>${escapeHtml(nombreActual)}</strong> · ${(turno.hora_turno || "").substring(0,5)} hs</div>
          <div style="margin-bottom:12px;"><span style="color:var(--text-muted);">A:</span> <strong id="swal-resumen-destino">Elegir destino…</strong></div>
          <label style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Mover a</label>
          <select id="swal-destino-prof" onchange="var s=document.getElementById('swal-resumen-destino');if(s)s.textContent='A: '+((this.options[this.selectedIndex]&&this.options[this.selectedIndex].dataset.label)||'Elegir destino…');" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none; color-scheme:inherit;">
            <option value="" disabled selected>Elegir destino…</option>
            ${proOptions}
            <option value="_sin" data-label="Sin asignar">Sin asignar (no bloquea disponibilidad y pasa al calendario general)</option>
          </select>
          <label style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-top:14px;">Nuevo horario</label>
          <select id="swal-nueva-hora" onchange="var s=document.getElementById('swal-resumen-hora');if(s)s.textContent=this.options[this.selectedIndex]&&this.options[this.selectedIndex].value?this.options[this.selectedIndex].value+' hs':'Mantener hora actual';" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none; color-scheme:inherit;">
            ${slotOptions.join('')}
          </select>
          <div style="margin-top:8px; font-size:0.82rem; color:var(--text-muted);">Horario final: <strong id="swal-resumen-hora" style="color:var(--text-main);">Mantener hora actual</strong></div>
          <div style="margin-top:8px;">
            <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-size:0.82rem; color:var(--text-muted);">
              <input type="checkbox" id="swal-enviar-email"> Enviar aviso por email al cliente (marcar solo si el horario quedó definitivo)
            </label>
          </div>
        </div>`;
    } else {
      const horaDestLinea = horaCambia
        ? `<div style="margin-top:6px;"><span style="color:var(--text-muted);">Nuevo horario:</span> <strong style="color:var(--accent);">${fmtHM(nuevaMin)} hs</strong></div>`
        : '';
      htmlModal = `
        <div style="text-align:left; font-size:0.92rem; line-height:1.6; color:var(--text-main);">
          <div style="margin-bottom:10px;"><strong>${escapeHtml(turno.cliente || "")}</strong><br><span style="color:var(--text-muted)">${escapeHtml(turno.servicio || "")} · ${formatearFecha(turno.fecha_turno)} ${(turno.hora_turno || "").substring(0,5)} hs</span></div>
          <div style="margin-bottom:12px;"><span style="color:var(--text-muted);">Actual:</span> <strong>${escapeHtml(nombreActual)}</strong> · ${(turno.hora_turno || "").substring(0,5)} hs</div>
          <div style="margin-bottom:12px;"><span style="color:var(--text-muted);">A:</span> <strong style="color:var(--accent);">${escapeHtml(nombreDestino)}</strong>${horaDestLinea}</div>
          <div style="font-size:0.78rem; color:var(--text-muted);">${horaCambia ? "El horario se actualiza (snap 30 min) y se reasigna el profesional. El evento se reprograma en Google Calendar." : (destinoId === null ? "El horario se mantiene; quedará sin profesional asignado, no bloqueará la disponibilidad de nadie y el evento pasa al calendario general." : "El horario se mantiene; solo cambia el profesional asignado.")}</div>
          <div style="margin-top:8px;">
            <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-size:0.82rem; color:var(--text-muted);">
              <input type="checkbox" id="swal-enviar-email"> Enviar aviso por email al cliente (marcar solo si el horario quedó definitivo)
            </label>
          </div>
        </div>`;
    }

    const nombreConfirmacion = esSelector ? "Confirmar movimiento" : `Mover a ${nombreDestino}`;

    const res = await Swal.fire({
      title: "Mover turno",
      html: htmlModal,
      icon: "question",
      showCancelButton: true,
      confirmButtonText: nombreConfirmacion,
      background: "var(--card-bg)",
      color: "var(--text-main)",
      confirmButtonColor: "var(--accent)",
      preConfirm: () => {
        const enviar = !!document.getElementById("swal-enviar-email")?.checked;
        if (esSelector) {
          const sel = document.getElementById("swal-destino-prof");
          const val = sel ? sel.value : "";
          if (!val) { Swal.showValidationMessage("Tenés que elegir un profesional destino"); return false; }
          const selHora = document.getElementById("swal-nueva-hora");
          const hVal = selHora ? selHora.value : "";
          const minSel = hVal ? clampHora(parseHM(hVal)) : null;
          const destNorm = val === "_sin" ? null : String(val);
          const cambia = minSel !== null && minSel !== horaActualMin;
          if (destNorm === actualId && !cambia) {
            Swal.showValidationMessage(destNorm === null ? "Este turno ya está sin profesional asignado" : `Este turno ya está asignado a ${listaProfesionalesGlobal.find(p => p.id_profesional === destNorm)?.nombre || "ese profesional"}`);
            return false;
          }
          return { destino: destNorm, hora: hVal, email: enviar };
        }
        return { destino: dirDest, hora: (nuevaMin !== null && nuevaMin !== horaActualMin) ? fmtHM(nuevaMin) : "", email: enviar };
      }
    });
    if (!res.isConfirmed) return;
    const flow = res.value;
    const destinoFinal = esSelector ? flow.destino : dirDest;
    let nuevaMinFinal = null;
    if (flow.hora) nuevaMinFinal = clampHora(parseHM(flow.hora));
    const enviarEmail = !!flow.email;
    const horaFinalStr = (nuevaMinFinal !== null && nuevaMinFinal !== horaActualMin) ? fmtHM(nuevaMinFinal) : null;

    const movimientoKey = `${idReserva}|${destinoFinal === null ? '' : destinoFinal}|${horaFinalStr || ''}`;
    if (movimientosEnVuelo.has(movimientoKey)) return;
    movimientosEnVuelo.add(movimientoKey);

    const snapshot = { ...turno };
    const nombreDestinoReal = destinoFinal === null ? "Local" : (listaProfesionalesGlobal.find(p => p.id_profesional === destinoFinal)?.nombre || "Local");
    const baseServicio = (turno.servicio || "").split(" (")[0].trim();
    const nuevoServicio = baseServicio ? `${baseServicio} (${nombreDestinoReal})` : turno.servicio;

    turno.id_profesional = destinoFinal;
    turno.profesional = nombreDestinoReal;
    if (horaFinalStr) turno.hora_turno = horaFinalStr;
    turno.servicio = nuevoServicio;
    renderAgendaKanban();

    const payload = { accion: "reasignar_reserva", id_reserva: idReserva, id_profesional: destinoFinal, enviar_email: enviarEmail, token: getToken() };
    if (horaFinalStr) payload.hora_turno = horaFinalStr;

    (async () => {
      try {
        const upd = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
        const json = await upd.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
        const actual = listaAgendaGlobal.find(r => r.id_reserva === idReserva);
        if (!json.success) {
          if (actual && String(actual.id_profesional || '') === String(destinoFinal || '')) Object.assign(actual, snapshot);
          renderAgendaKanban();
          const errTxt = String(json.error || "Error al mover");
          // RF-03: el backend rechaza cambiar el profesional de un turno con varios
          // servicios. La tarjeta ya volvió a su columna; se explica cómo hacerlo bien.
          if (errTxt.includes("no se puede reasignar globalmente")) {
            Swal.fire({
              title: "El profesional se cambia por servicio",
              text: "Este turno tiene varios servicios y cada uno puede tener su propio profesional. Para cambiarlo, abrí la edición del turno y modificá el profesional de cada servicio.",
              icon: "info",
              background: "var(--card-bg)",
              color: "var(--text-main)"
            });
            return;
          }
          mostrarToast(errTxt, "error");
          return;
        }
        if (actual && json.data) {
          if (json.data.sync_calendar !== undefined) actual.sync_calendar = json.data.sync_calendar;
        }
        renderAgendaKanban();
        if (json.data && json.data.sync_calendar === false) mostrarToast("Turno movido, pero Google no se actualizó", "warning");
        else mostrarToast("Turno movido", "success");
      } catch (err) {
        const actual = listaAgendaGlobal.find(r => r.id_reserva === idReserva);
        if (actual && String(actual.id_profesional || '') === String(destinoFinal || '')) Object.assign(actual, snapshot);
        renderAgendaKanban();
        mostrarToast("Error al mover el turno (sin conexión)", "error");
      } finally {
        movimientosEnVuelo.delete(movimientoKey);
      }
    })();
  } catch(err) { console.error(err); mostrarToast("Error al mover el turno", "error"); }
};

// WP-P05 / RF-02: edición integral del turno desde la card del Kanban.
// Permite cambiar fecha, hora, profesional y datos de contacto del cliente.
// Reutiliza la acción `reasignar_reserva`: es la que ya valida y sincroniza con
// Google Calendar, y ahora acepta también fecha_turno, cliente, email y telefono.
// La validación definitiva siempre es la del servidor; el `min` del date input
// solo es una ayuda visual.
// RF-03: gate de promoción legacy. Devuelve true si el turno puede seguir hacia el
// modal de edición; false si hay que detener este intento.
// NO es recursivo: al terminar, el flujo continúa hacia abajo en una sola pasada,
// por lo que no puede volver a dispararse ni entrar en loop.
window.asegurarTurnoRf03 = async (idReserva) => {
  // ---- 1. Detección (solo lectura) -----------------------------------------
  let deteccion;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ accion: "detectar_turno_rf03", id_reserva: idReserva, token: getToken() })
    });
    const json = await res.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
    if (!json.success) { mostrarToast(json.error || "No se pudo leer el turno", "error"); return false; }
    deteccion = json.data || {};
  } catch (err) {
    console.error(err);
    mostrarToast("Error de red al leer el turno", "error");
    return false;
  }

  // ---- 2. Ya promovido: no se molesta al admin con nada extra ---------------
  if (deteccion.promovido === true) return true;

  // ---- 3. Bloqueos: no tienen prestación, no se promueve --------------------
  if (deteccion.estado_turno === "Bloqueada") {
    Swal.fire({
      title: "No se prepara un bloqueo",
      text: "Los bloqueos no tienen una prestación de servicio y no necesitan promoción RF-03.",
      icon: "info",
      background: 'var(--card-bg)', color: 'var(--text-main)'
    });
    return false;
  }

  // ---- 4. Sin servicio o sin profesional: no se inventa nada ----------------
  if (!deteccion.id_servicio) {
    Swal.fire({
      title: "Falta el servicio",
      text: "Este turno no tiene un servicio asignado. No se puede preparar para múltiples servicios sin un servicio original.",
      icon: "warning",
      background: 'var(--card-bg)', color: 'var(--text-main)'
    });
    return false;
  }
  if (!deteccion.id_profesional) {
    Swal.fire({
      title: "Falta el profesional",
      text: "Este turno no tiene un profesional asignado. Asignale un profesional antes de preparar el turno para múltiples servicios.",
      icon: "warning",
      background: 'var(--card-bg)', color: 'var(--text-main)'
    });
    return false;
  }

  // ---- 5. Confirmación del histórico ----------------------------------------
  // Los valores de catálogo y los montos legacy se muestran SOLO como referencia:
  // los inputs arrancan vacíos y nunca se copian desde la referencia.
  const precioActual = deteccion.servicio?.precio_actual;
  const duracionActual = deteccion.servicio?.duracion_actual;
  const refDinero = (v) => (v === null || v === undefined || v === "") ? "sin dato" : formatearMonedaAdmin(v);
  const refFila = (etiqueta, valor) => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;font-size:0.82rem;padding:5px 0;border-bottom:1px solid var(--ui-border);">
          <span style="color:var(--text-muted);">${escapeHtml(etiqueta)}</span>
          <span style="color:var(--text-main);font-weight:600;text-align:right;">${escapeHtml(valor)}</span>
        </div>`;
  const campo = (idCampo, etiqueta, tipo, extra = '') => `
        <label style="display:block;font-size:0.8rem;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-top:14px;">${escapeHtml(etiqueta)}</label>
        <input type="${tipo}" id="${idCampo}" placeholder="—" ${extra} style="width:100%;margin-top:6px;padding:12px;background:var(--ui-bg);border:1px solid var(--ui-border);border-radius:10px;color:var(--panel-text);font-size:0.95rem;outline:none;color-scheme:inherit;" />`;

  const confirmacion = await Swal.fire({
    title: 'Preparar turno para múltiples servicios',
    html: `
        <div style="text-align:left; font-size:0.92rem; line-height:1.6; color:var(--text-main);">
          <div style="margin-bottom:14px;">
            Este turno fue creado antes del modelo de múltiples servicios.
            Para continuar necesitamos confirmar los datos pactados originalmente.
          </div>
          <div style="border:1px solid var(--ui-border);border-radius:10px;padding:12px 14px;background:var(--ui-bg);">
            <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);font-weight:700;margin-bottom:4px;">Referencia actual / histórica no verificada</div>
            ${refFila("Servicio", deteccion.servicio?.nombre || "Servicio")}
            ${refFila("Profesional", deteccion.profesional?.nombre || "Local")}
            ${refFila("Precio actual del catálogo", refDinero(precioActual))}
            ${refFila("Duración actual del catálogo", (duracionActual === null || duracionActual === undefined) ? "sin dato" : `${duracionActual} min`)}
            ${refFila("monto_cobrado", refDinero(deteccion.monto_cobrado))}
            ${refFila("ingreso_real", refDinero(deteccion.ingreso_real))}
            ${refFila("estado_pago", deteccion.estado_pago || "sin dato")}
            <div style="font-size:0.76rem;color:var(--text-muted);margin-top:8px;line-height:1.5;">Estos datos son solo de consulta y no se copian a los campos. Se guarda exactamente lo que confirmes.</div>
          </div>
          ${campo("swal-rf03-precio", "Precio base pactado", "number", 'min="0" step="any"')}
          ${campo("swal-rf03-duracion", "Duración pactada (minutos)", "number", 'min="1" step="1"')}
          ${campo("swal-rf03-pagado", "Total efectivamente pagado hasta ahora", "number", 'min="0" step="any"')}
          ${campo("swal-rf03-cupon-codigo", "Código de cupón histórico (opcional)", "text")}
          ${campo("swal-rf03-cupon-pct", "Porcentaje de cupón histórico (opcional, 1-100)", "number", 'min="1" max="100" step="1"')}
        </div>`,
    showCancelButton: true,
    confirmButtonText: 'Confirmar y preparar',
    cancelButtonText: 'Cancelar',
    background: 'var(--card-bg)',
    color: 'var(--text-main)',
    focusConfirm: false,
    didOpen: () => { const el = document.getElementById("swal-rf03-precio"); if (el) el.focus(); },
    preConfirm: () => {
      const leer = (id) => String(document.getElementById(id).value || "").trim();
      const precioRaw = leer("swal-rf03-precio");
      const duracionRaw = leer("swal-rf03-duracion");
      const pagadoRaw = leer("swal-rf03-pagado");
      const cuponCodigoRaw = leer("swal-rf03-cupon-codigo");
      const cuponPctRaw = leer("swal-rf03-cupon-pct");

      if (precioRaw === "" || isNaN(Number(precioRaw))) { Swal.showValidationMessage("Ingresá el precio base pactado."); return false; }
      const precio = Number(precioRaw);
      if (precio < 0) { Swal.showValidationMessage("El precio base pactado no puede ser negativo."); return false; }

      if (duracionRaw === "" || isNaN(Number(duracionRaw))) { Swal.showValidationMessage("Ingresá la duración pactada en minutos."); return false; }
      const duracion = Number(duracionRaw);
      if (!Number.isInteger(duracion) || duracion <= 0) { Swal.showValidationMessage("La duración pactada debe ser un entero mayor a 0."); return false; }

      if (pagadoRaw === "" || isNaN(Number(pagadoRaw))) { Swal.showValidationMessage("Ingresá el total efectivamente pagado."); return false; }
      const pagado = Number(pagadoRaw);
      if (pagado < 0) { Swal.showValidationMessage("El total pagado no puede ser negativo."); return false; }

      const cupon_codigo = cuponCodigoRaw === "" ? null : cuponCodigoRaw;
      const cupon_porcentaje = cuponPctRaw === "" ? null : Number(cuponPctRaw);
      if ((cupon_codigo === null) !== (cupon_porcentaje === null)) {
        Swal.showValidationMessage(cupon_codigo === null ? "Ingresá también el porcentaje del cupón." : "Ingresá también el código del cupón.");
        return false;
      }
      if (cupon_porcentaje !== null && (isNaN(cupon_porcentaje) || !Number.isInteger(cupon_porcentaje) || cupon_porcentaje < 1 || cupon_porcentaje > 100)) {
        Swal.showValidationMessage("El porcentaje del cupón debe ser un entero entre 1 y 100.");
        return false;
      }

      return { precio_base_pactado: precio, duracion_pactada: duracion, total_pagado: pagado, cupon_codigo, cupon_porcentaje };
    }
  });
  if (!confirmacion.isConfirmed) return false;
  const flow = confirmacion.value;

  // ---- 6. Promoción (toda la escritura ocurre dentro de la RPC) --------------
  const claveVuelo = `promover:${idReserva}`;
  if (movimientosEnVuelo.has(claveVuelo)) return false;
  movimientosEnVuelo.add(claveVuelo);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        accion: "promover_turno_rf03", id_reserva: idReserva,
        precio_base_pactado: flow.precio_base_pactado,
        duracion_pactada: flow.duracion_pactada,
        total_pagado: flow.total_pagado,
        cupon_codigo: flow.cupon_codigo,
        cupon_porcentaje: flow.cupon_porcentaje,
        token: getToken()
      })
    });
    const json = await res.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
    if (!json.success) { mostrarToast(json.error || "No se pudo preparar el turno", "error"); return false; }
    // 'ya_promovido' no es un error: otro operador lo promovió antes.
    const yaPromovido = json.data && json.data.estado === "ya_promovido";
    mostrarToast(yaPromovido ? "El turno ya estaba preparado para múltiples servicios" : "Turno preparado para múltiples servicios", yaPromovido ? "info" : "success");
    return true;
  } catch (err) {
    console.error(err);
    mostrarToast("Error de red al preparar el turno", "error");
    return false;
  } finally {
    movimientosEnVuelo.delete(claveVuelo);
  }
};

// =======================================================================
// RF-03: composición multi-servicio del turno en el modal de edición.
// -----------------------------------------------------------------------
// El frontend NUNCA es la autoridad de snapshots ni de dinero: los snapshots
// vienen de reserva_lineas y los totales de la cabecera, ambos leídos por
// backend. Al guardar se envían SOLO id_linea / id_servicio / id_profesional;
// el orden del array es la autoridad de orden y la RPC decide precio,
// duración, descuento y saldo definitivos.
// =======================================================================
window._compTurno = null;

window.cargarComposicionTurno = async (idReserva) => {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ accion: "obtener_composicion_turno_rf03", id_reserva_interno: idReserva, token: getToken() })
  });
  const json = await res.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
  if (!json.success) throw new Error(json.error || "No se pudo leer el turno");
  return json.data || {};
};

window._svcCatalogo = (id) => listaServiciosGlobal.find(s => String(s.id_servicio) === String(id)) || null;
window._profCatalogo = (id) => listaProfesionalesGlobal.find(p => String(p.id_profesional) === String(id)) || null;

// Espejo JS de esProfCalificado() en api/proxy.js: servicios_asignados vacío o
// 'TODOS' habilita para todo; si no, es un CSV de id_servicio (NO de nombres).
// Se usa solo para FILTRAR la lista del select. La RPC vuelve a validarlo.
window._profHabilitadoPara = (prof, idServicio) => {
  if (!prof) return false;
  const asig = String(prof.servicios === null || prof.servicios === undefined ? "" : prof.servicios).trim().toUpperCase();
  if (!asig || asig === "TODOS") return true;
  return asig.split(",").map(t => t.trim().toUpperCase()).includes(String(idServicio || "").trim().toUpperCase());
};

// Línea en blanco para el alta manual. Los snapshots quedan null a propósito:
// antes de guardar, precio y duración son REFERENCIA del catálogo (~).
window._lineaComposicionVacia = () => ({
  id_linea: null,
  id_servicio: null,
  id_profesional: null,
  nombre_servicio: null,
  nombre_profesional: null,
  precio_snapshot: null,
  duracion_snapshot: null,
  _ref_duracion: null,
  _ref_precio: null
});

// Estado de composición para "Nuevo Turno": un turno que todavía no existe.
// Se usa EXACTAMENTE el mismo renderer y los mismos helpers que Editar turno.
window.iniciarComposicionNueva = () => {
  window._compTurno = {
    modo: "crear",
    id_reserva: null,
    es_rf03: true,
    totales: {},
    lineas: [window._lineaComposicionVacia()],
    _original: null
  };
  window.pintarComposicionTurno();
};

window._din = (v) => (v === null || v === undefined || v === "") ? "—" : formatearMonedaAdmin(v);

window.refrescarLineaComposicion = (idx, campo, valor) => {
  const st = window._compTurno;
  if (!st) return;
  const l = st.lineas[idx];
  if (!l) return;
  l[campo] = valor || null;
  if (campo === "id_servicio") {
    const s = window._svcCatalogo(valor);
    l._ref_duracion = s ? s.duracion_minutos : null;
    l._ref_precio = s ? s.precio : null;
    // Se actualiza el nombre para que la línea siga mostrando la etiqueta real.
    l.nombre_servicio = s ? s.nombre : null;
    // Si el profesional que tenía la línea no está habilitado para el servicio
    // nuevo, se limpia para que el admin elija uno válido. No se reasigna solo:
    // la RPC rechazaría la línea y el error llegaría tarde.
    const pActual = window._profCatalogo(l.id_profesional);
    if (l.id_profesional && !window._profHabilitadoPara(pActual, l.id_servicio)) {
      l.id_profesional = null;
      l.nombre_profesional = null;
    }
  }
  if (campo === "id_profesional") {
    const p = window._profCatalogo(valor);
    l.nombre_profesional = p ? p.nombre : null;
  }
  window.pintarComposicionTurno();
};

window.agregarLineaComposicion = () => {
  const st = window._compTurno;
  if (!st) return;
  // En un turno NUEVO cada línea arranca vacía: no hay una línea previa que
  // clonar. En uno existente se clona la última, que es lo que ya se hacía.
  if (st.modo === "crear") {
    st.lineas.push(window._lineaComposicionVacia());
    window.pintarComposicionTurno();
    return;
  }
  const base = st.lineas[st.lineas.length - 1] || st.lineas[0];
  st.lineas.push({
    id_linea: null,
    id_servicio: base ? base.id_servicio : null,
    id_profesional: base ? base.id_profesional : null,
    nombre_servicio: base ? base.nombre_servicio : null,
    nombre_profesional: base ? base.nombre_profesional : null,
    precio_snapshot: null,
    duracion_snapshot: null,
    _ref_duracion: null,
    _ref_precio: null
  });
  window.pintarComposicionTurno();
};

window.eliminarLineaComposicion = (idx) => {
  const st = window._compTurno;
  if (!st) return;
  if (st.lineas.length <= 1) { mostrarToast("El turno tiene que conservar al menos un servicio", "info"); return; }
  st.lineas.splice(idx, 1);
  window.pintarComposicionTurno();
};

window.moverLineaComposicion = (idx, delta) => {
  const st = window._compTurno;
  if (!st) return;
  const j = idx + delta;
  if (j < 0 || j >= st.lineas.length) return;
  const tmp = st.lineas[idx];
  st.lineas[idx] = st.lineas[j];
  st.lineas[j] = tmp;
  window.pintarComposicionTurno();
};

window.pintarComposicionTurno = () => {
  const st = window._compTurno;
  if (!st) return;
  // Un solo renderer para los dos orígenes: "Nuevo Turno" y "Editar turno" solo
  // cambian dónde se pinta y de dónde salen los totales.
  const esCrear = st.modo === "crear";
  const cont = document.getElementById(esCrear ? "add-res-composicion" : "comp-turno-lineas");
  if (!cont) return;
  const total = st.lineas.length;

  const selCss = "flex:1;min-width:0;padding:9px;background:var(--card-bg);border:1px solid var(--ui-border);border-radius:8px;color:var(--panel-text);font-size:0.85rem;outline:none;color-scheme:inherit;";
  const btnCss = "padding:5px 9px;background:transparent;border:1px solid var(--ui-border);border-radius:7px;color:var(--text-main);font-size:0.75rem;cursor:pointer;";

  // Construye las opciones del select: las alternativas válidas como primer
  // bucket + el valor HISTÓRICO de la línea si hoy no está entre ellas. Sin ese
  // agregado, una línea que referencia un servicio o profesional desactivado se
  // mostraría con el primer activo del catálogo (o quedaría sin representar) y al
  // guardar se pisaría el dato real.
  const opciones = (lista, campoId, actualId, nombreActual, etiquetaActual, filtrar) => {
    const validos = lista.filter(x => x.estado === 'Activo' && (!filtrar || filtrar(x)));
    let hayActualEntreValidos = false;
    let opts = '';
    for (const x of validos) {
      const sel = String(x[campoId]) === String(actualId) ? " selected" : "";
      if (sel) hayActualEntreValidos = true;
      opts += `<option value="${escapeHtml(x[campoId])}"${sel}>${escapeHtml(x.nombre)}</option>`;
    }
    const hayActual = actualId !== null && actualId !== undefined && String(actualId) !== "";
    if (hayActual && !hayActualEntreValidos) {
      const actual = lista.find(x => String(x[campoId]) === String(actualId)) || null;
      const nombre = (actual && actual.nombre) || nombreActual || "Valor histórico";
      opts += `<option value="${escapeHtml(actualId)}" selected>${escapeHtml(nombre)} (${escapeHtml(etiquetaActual(actual))})</option>`;
    }
    // Sin valor actual tiene que haber un placeholder marcado. Si no, el navegador
    // marcaría la primera option de la lista y el select aparentaría una elección
    // que el estado no tiene: el admin vería un profesional y se guardaría otro.
    if (!hayActual) opts = '<option value="" selected>Seleccionar...</option>' + opts;
    return opts;
  };

  const etiquetaServicio = () => "inactivo";
  // Se distingue "inactivo" de "activo pero no habilitado para este servicio":
  // son dos situaciones distintas y el admin tiene que poder ver cuál es.
  const etiquetaProfesional = (actual) => (!actual || actual.estado !== 'Activo') ? "inactivo" : "no habilitado para este servicio";

  const filas = st.lineas.map((l, i) => {
    const opcionesSvc = opciones(listaServiciosGlobal, "id_servicio", l.id_servicio, l.nombre_servicio, etiquetaServicio, null);
    const opcionesProf = opciones(listaProfesionalesGlobal, "id_profesional", l.id_profesional, l.nombre_profesional, etiquetaProfesional,
      p => window._profHabilitadoPara(p, l.id_servicio));
    const esNueva = l.id_linea === null || l.id_linea === undefined;
    const durTxt = (l.duracion_snapshot !== null && l.duracion_snapshot !== undefined) ? `${l.duracion_snapshot} min`
      : (l._ref_duracion ? `~${l._ref_duracion} min` : "—");
    const precTxt = (l.precio_snapshot !== null && l.precio_snapshot !== undefined) ? formatearMonedaAdmin(l.precio_snapshot)
      : (l._ref_precio ? `~${formatearMonedaAdmin(l._ref_precio)}` : "—");

    return `
      <div style="border:1px solid var(--ui-border);border-radius:10px;padding:9px 10px;margin-bottom:8px;background:var(--ui-bg);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px;">
          <span style="font-size:0.72rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-muted);">Servicio ${i + 1} de ${total}${esNueva ? " · nuevo" : ""}</span>
          <span style="display:flex;gap:4px;">
            <button type="button" style="${btnCss}${i === 0 ? "opacity:0.35;cursor:default;" : ""}" onclick="moverLineaComposicion(${i},-1)"${i === 0 ? " disabled" : ""}>Subir</button>
            <button type="button" style="${btnCss}${i === total - 1 ? "opacity:0.35;cursor:default;" : ""}" onclick="moverLineaComposicion(${i},1)"${i === total - 1 ? " disabled" : ""}>Bajar</button>
            <button type="button" style="${btnCss}" onclick="eliminarLineaComposicion(${i})"${total <= 1 ? " disabled" : ""}>Quitar</button>
          </span>
        </div>
        <div style="display:flex;gap:8px;">
          <select style="${selCss}" onchange="refrescarLineaComposicion(${i},'id_servicio',this.value)">${opcionesSvc}</select>
          <select style="${selCss}" onchange="refrescarLineaComposicion(${i},'id_profesional',this.value)">${opcionesProf}</select>
        </div>
        <div style="display:flex;gap:14px;margin-top:7px;font-size:0.78rem;color:var(--text-muted);">
          <span>Duración: <strong style="color:var(--text-main);">${durTxt}</strong></span>
          <span>Precio: <strong style="color:var(--text-main);">${precTxt}</strong></span>
          ${esNueva ? '<span style="font-style:italic;">referencia del catálogo; la definición la da el servidor</span>' : ""}
        </div>
      </div>`;
  }).join("");

  cont.innerHTML = filas + `
    <button type="button" onclick="agregarLineaComposicion()" style="width:100%;padding:9px;background:transparent;border:1px dashed var(--ui-border);border-radius:10px;color:var(--text-main);font-size:0.82rem;cursor:pointer;">+ Agregar otro servicio</button>`;

  const totCont = document.getElementById(esCrear ? "add-res-totales" : "comp-turno-totales");
  if (totCont) {
    const fila = (etiqueta, valor) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;font-size:0.82rem;padding:4px 0;">
        <span style="color:var(--text-muted);">${escapeHtml(etiqueta)}</span>
        <span style="color:var(--text-main);font-weight:600;">${escapeHtml(valor)}</span>
      </div>`;

    if (esCrear) {
      // ANTES de guardar no hay servidor: se estima desde el catálogo. Se rotula
      // como estimación para que nadie la tome por un valor pactado. El precio y
      // la duración reales los devuelve la RPC al confirmar.
      const durTotal = st.lineas.reduce((acc, l) => acc + (parseInt(l.duracion_snapshot, 10) || parseInt(l._ref_duracion, 10) || 0), 0);
      const subtotal = st.lineas.reduce((acc, l) => acc + (parseFloat(l.precio_snapshot) || parseFloat(l._ref_precio) || 0), 0);
      totCont.innerHTML =
        fila("Duración total estimada", `${durTotal} min`) +
        fila("Subtotal estimado", window._din(subtotal)) +
        '<div style="font-size:0.72rem;color:var(--text-muted);font-style:italic;padding-top:6px;">Estimación con el catálogo actual. El total pactado lo define el servidor al guardar.</div>';
    } else {
      const t = st.totales || {};
      const durTotal = st.lineas.reduce((acc, l) => acc + (parseInt(l.duracion_snapshot, 10) || parseInt(l._ref_duracion, 10) || 0), 0);
      totCont.innerHTML =
        fila("Duración total", `${durTotal} min`) +
        fila("Subtotal", window._din(t.subtotal_pactado)) +
        fila("Descuento", window._din(t.descuento_aplicado)) +
        fila("Total pactado", window._din(t.total_pactado)) +
        fila("Total pagado", window._din(t.total_pagado)) +
        fila("Saldo pendiente", window._din(t.saldo_pendiente));
    }
  }
};

window.abrirModalEditarTurno = async (idReserva) => {
  try {
    // RF-03: si el turno todavía no tiene composición multi-servicio, se pide
    // confirmar el histórico una única vez antes de abrir la edición. Abajo sigue
    // EXACTAMENTE el cuerpo original del modal.
    const puedeContinuar = await window.asegurarTurnoRf03(idReserva);
    if (!puedeContinuar) return;

    // RF-03: la composición se lee del backend (reserva_lineas + cabecera). Nunca se
    // reconstruye desde el catálogo. Tras una promoción, esta misma lectura ya devuelve
    // la línea 1 real, así que no hace falta un segundo flujo.
    let composicion = null;
    try {
      composicion = await window.cargarComposicionTurno(idReserva);
    } catch (err) {
      console.error(err);
      mostrarToast("No se pudo cargar la composición del turno", "error");
      return;
    }
    const esRf03 = composicion && composicion.es_rf03 === true;
    window._compTurno = {
      modo: "editar",
      id_reserva: idReserva,
      es_rf03: esRf03,
      totales: composicion || {},
      // `nombre_servicio` / `nombre_profesional` se conservan porque una línea existente
      // puede apuntar a un servicio o profesional que hoy está INACTIVO: si no, el select
      // no tendría con qué representar el valor real y se caería al primer activo.
      lineas: esRf03
        ? (composicion.composicion || []).map(l => ({
            id_linea: l.id_linea || null,
            id_servicio: l.id_servicio || null,
            id_profesional: l.id_profesional || null,
            nombre_servicio: l.nombre_servicio || null,
            nombre_profesional: l.nombre_profesional || null,
            precio_snapshot: (l.precio_snapshot === undefined) ? null : l.precio_snapshot,
            duracion_snapshot: (l.duracion_snapshot === undefined) ? null : l.duracion_snapshot,
            _ref_duracion: null,
            _ref_precio: null
          }))
        : [{
            id_linea: null,
            id_servicio: composicion.id_servicio || null,
            id_profesional: composicion.id_profesional || null,
            nombre_servicio: (composicion.servicio && composicion.servicio.nombre) || null,
            nombre_profesional: (composicion.profesional && composicion.profesional.nombre) || null,
            precio_snapshot: null,
            duracion_snapshot: null,
            _ref_duracion: null,
            _ref_precio: null
          }]
    };
    // Fotografía de la composición tal como la devolvió el backend. Sirve para detectar
    // si el admin realmente la modificó, sin depender de mutar los objetos de la vista.
    window._compTurno._original = window._compTurno.lineas
      .map(l => [l.id_linea || null, l.id_servicio || null, l.id_profesional || null]);

    const turno = listaAgendaGlobal.find(r => String(r.id_reserva) === String(idReserva));
    if (!turno) { mostrarToast("No se encontró el turno", "error"); return; }

    const parseHM = (t) => { const partes = String(t || "").split(":").map(Number); return (partes[0] || 0) * 60 + (partes[1] || 0); };
    const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const cont = document.getElementById("admin-agenda-container");
    const aperturaHorario = Number(cont ? cont.dataset.apertura : NaN);
    const cierreHorario = Number(cont ? cont.dataset.cierre : NaN);
    const a = (isFinite(aperturaHorario) && aperturaHorario >= 0) ? aperturaHorario : parseHM(horaAperturaMarca || "09:00");
    const c = (isFinite(cierreHorario) && cierreHorario >= 0) ? cierreHorario : Math.max(parseHM(horaCierreMarca || "19:00"), a + 600);
    const duracionTurno = Math.max(parseInt(turno.duracion, 10) || 30, 10);
    const maxStart = c - duracionTurno;
    const fechaActual = String(turno.fecha_turno || "").slice(0, 10);
    // Dia habil minimo. Se usa la fecha local, igual que el corte de "hoy" de
    // cargarAgenda(); el servidor igual revalida contra la zona de la marca.
    const hoyLocal = new Date(); hoyLocal.setHours(0,0,0,0);
    const fechaMin = `${hoyLocal.getFullYear()}-${String(hoyLocal.getMonth() + 1).padStart(2, "0")}-${String(hoyLocal.getDate()).padStart(2, "0")}`;

    const horaActualStr = String(turno.hora_turno || "").slice(0, 5);
    const slotValues = [];
    for (let m = a; m <= maxStart; m += 30) slotValues.push(fmtHM(m));
    // La hora actual puede no caer en un múltiplo de 30: se agrega como opción
    // para que el select siempre pueda representar el turno tal como está hoy.
    if (horaActualStr && !slotValues.includes(horaActualStr)) {
      slotValues.push(horaActualStr);
      slotValues.sort();
    }
    const slotOptions = slotValues.map(v => `<option value="${v}"${v === horaActualStr ? " selected" : ""}>${v} hs</option>`).join('');
    const actualId = (turno.id_profesional === null || turno.id_profesional === undefined || turno.id_profesional === '') ? null : String(turno.id_profesional);
    const proOptions = listaProfesionalesGlobal.filter(p => p.estado === 'Activo')
      .map(p => `<option value="${p.id_profesional}"${String(p.id_profesional) === actualId ? " selected" : ""}>${escapeHtml(p.nombre)}</option>`).join('');

    const res = await Swal.fire({
      title: 'Editar turno',
      // El ancho y el scrolleo del popup salen de .turno-editar-popup /
      // .turno-editar-body (admin.html). Las acciones nativas de SweetAlert2 se
      // mantienen: no se usan acciones propias, así el footer nunca queda
      // incrustado en el body scrolleable ni se pierde el foco/orden de tabulación.
      customClass: { popup: 'turno-editar-popup' },
      html: `
        <div class="turno-editar-body">
          <div class="turno-editar-head"><strong>${escapeHtml(turno.cliente || "")}</strong><br><span style="color:var(--text-muted)">${escapeHtml(turno.servicio || "")} · ${formatearFecha(turno.fecha_turno)} ${(turno.hora_turno || "").substring(0,5)} hs</span></div>
          <div class="turno-editar-grid">
            <div class="turno-editar-col turno-editar-col-comp">
              <div class="turno-editar-box">
                <div class="turno-editar-box-titulo">Servicios del turno</div>
                <div id="comp-turno-lineas"></div>
                <div class="turno-editar-totales" id="comp-turno-totales"></div>
              </div>
            </div>
            <div class="turno-editar-col">
              <label class="turno-editar-label" for="swal-ed-fecha">Fecha</label>
              <input type="date" id="swal-ed-fecha" value="${fechaActual}" min="${fechaMin}" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none; color-scheme:inherit;" />
              <label class="turno-editar-label is-spaced" for="swal-ed-hora">Hora</label>
              <select id="swal-ed-hora" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none; color-scheme:inherit;">
                ${slotOptions}
              </select>
              ${esRf03 ? `
              <div class="turno-editar-aviso">
                <p>El profesional se cambia por servicio en cada línea de la izquierda.</p>
              </div>` : `
              <label class="turno-editar-label is-spaced" for="swal-ed-prof">Profesional</label>
              <select id="swal-ed-prof" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none; color-scheme:inherit;">
                <option value=""${actualId === null ? " selected" : ""}>Sin asignar (no bloquea disponibilidad y pasa al calendario general)</option>
                ${proOptions}
              </select>`}
              <label class="turno-editar-label is-spaced" for="swal-ed-cliente">Cliente</label>
              <input type="text" id="swal-ed-cliente" value="${escapeHtml(turno.cliente || "")}" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none;" />
              <div class="turno-editar-pairs">
                <div>
                  <label class="turno-editar-label" for="swal-ed-telefono">Teléfono</label>
                  <input type="tel" id="swal-ed-telefono" value="${escapeHtml(turno.telefono || "")}" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none;" />
                </div>
                <div>
                  <label class="turno-editar-label" for="swal-ed-email">Email</label>
                  <input type="email" id="swal-ed-email" value="${escapeHtml(turno.email || "")}" style="width:100%; margin-top:6px; padding:12px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; outline:none;" />
                </div>
              </div>
              <div style="margin-top:12px;">
                <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-size:0.82rem; color:var(--text-muted);">
                  <input type="checkbox" id="swal-ed-enviar-email"> Enviar aviso por email al cliente (marcar solo si el cambio quedó definitivo)
                </label>
              </div>
              <div class="turno-editar-nota">El importe, la seña y el estado de pago no se modifican.</div>
            </div>
          </div>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Guardar cambios',
      cancelButtonText: 'Cancelar',
      background: 'var(--card-bg)',
      color: 'var(--text-main)',
      focusConfirm: false,
      didOpen: () => { window.pintarComposicionTurno(); },
      preConfirm: () => {
        const fecha = String(document.getElementById("swal-ed-fecha").value || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { Swal.showValidationMessage("Seleccioná una fecha válida."); return false; }
        const clienteVal = String(document.getElementById("swal-ed-cliente").value || "").trim();
        if (!clienteVal) { Swal.showValidationMessage("El nombre del cliente no puede quedar vacío."); return false; }
        const emailVal = String(document.getElementById("swal-ed-email").value || "").trim();
        if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailVal)) { Swal.showValidationMessage("Revisá el formato del email."); return false; }

        // RF-03: se envían SOLO los identificadores. El precio y la duración de una línea
        // nueva son referencia visual: no viajan. Snapshots y economía los fija la RPC.
        const st = window._compTurno;
        const lineas = [];
        for (let i = 0; i < st.lineas.length; i++) {
          const l = st.lineas[i];
          if (!l.id_servicio) { Swal.showValidationMessage(`Elegí el servicio de la línea ${i + 1}.`); return false; }
          if (!l.id_profesional) { Swal.showValidationMessage(`Elegí el profesional de la línea ${i + 1}.`); return false; }
          lineas.push({ id_linea: l.id_linea || null, id_servicio: l.id_servicio, id_profesional: l.id_profesional });
        }

        // Guardado parcial: la composición se escribe con una RPC y la fecha/hora con otra.
        // Si un mismo envío cambia las dos cosas y falla la segunda, el turno queda con
        // servicios recalculados para un horario que todavía no se movió (o al revés). En
        // esta fase no hay RPC transaccional que una, así que se pide un cambio por vez.
        // Los datos de contacto sí conviven: no afectan disponibilidad ni composición.
        const firmaActual = JSON.stringify(st.lineas.map(l => [l.id_linea || null, l.id_servicio || null, l.id_profesional || null]));
        const composicionCambia = firmaActual !== JSON.stringify(st._original || []);
        const horaSel = String(document.getElementById("swal-ed-hora").value || "").slice(0, 5);
        const horarioCambia = fecha !== fechaActual || horaSel !== horaActualStr;
        if (composicionCambia && horarioCambia) {
          Swal.showValidationMessage("Guardá primero el cambio de fecha/hora y luego editá los servicios, o viceversa.");
          return false;
        }

        // En RF-03 el selector global de profesional no existe: no se manda id_profesional
        // a reasignar_reserva, así el backend conserva el actual y nunca se desasigna.
        const selProf = document.getElementById("swal-ed-prof");
        return {
          fecha_turno: fecha,
          hora_turno: document.getElementById("swal-ed-hora").value,
          id_profesional: selProf ? (selProf.value || null) : undefined,
          cliente: clienteVal,
          telefono: String(document.getElementById("swal-ed-telefono").value || "").trim(),
          email: emailVal,
          enviar_email: !!document.getElementById("swal-ed-enviar-email").checked,
          lineas
        };
      }
    });
    if (!res.isConfirmed) return;
    const flow = res.value;

    const edicionKey = `edit:${idReserva}`;
    if (movimientosEnVuelo.has(edicionKey)) return;
    movimientosEnVuelo.add(edicionKey);
    const snapshot = { ...turno };

    (async () => {
      try {
        // ---- Paso 1: composición (escritura real vía RPC) ----------------------
        const comp = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({
            accion: "actualizar_composicion_turno_rf03", id_reserva_interno: idReserva,
            lineas: flow.lineas, token: getToken()
          })
        });
        const compJson = await comp.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
        if (!compJson.success) { mostrarToast(compJson.error || "No se pudo guardar la composición", "error"); return; }

        // ---- Paso 2: fecha / hora / contacto ----------------------------------
        // Si solo cambió la composición no se llama reasignar_reserva: el backend
        // responde "ya está asignada a ese profesional" cuando nada del turno cambió.
        const horaSel = String(flow.hora_turno || "").slice(0, 5);
        const datosTurnoCambian =
          flow.fecha_turno !== fechaActual
          || horaSel !== horaActualStr
          || flow.cliente !== String(turno.cliente || "").trim()
          || flow.telefono !== String(turno.telefono || "").trim()
          || flow.email !== String(turno.email || "").trim()
          || (flow.id_profesional !== undefined && String(flow.id_profesional || "") !== actualId);

        if (datosTurnoCambian) {
          const payloadTurno = {
            accion: "reasignar_reserva", id_reserva: idReserva,
            hora_turno: flow.hora_turno, fecha_turno: flow.fecha_turno,
            cliente: flow.cliente, telefono: flow.telefono, email: flow.email,
            enviar_email: flow.enviar_email, token: getToken()
          };
          if (flow.id_profesional !== undefined) payloadTurno.id_profesional = flow.id_profesional;
          const upd = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(payloadTurno)
          });
          const json = await upd.json().catch(() => ({ success: false, error: "Sin respuesta del servidor" }));
          if (!json.success) { mostrarToast(json.error || "Error al guardar", "error"); return; }
          if (json.data && json.data.sync_calendar === false) {
            mostrarToast("Composición guardada, pero Google Calendar no se actualizó", "warning");
          } else {
            mostrarToast("Turno actualizado", "success");
          }
        } else {
          mostrarToast("Composición guardada", "success");
        }

        if (flow.fecha_turno !== fechaActual) await cargarAgenda();
        // Mismo día: no hace falta recargar la agenda completa, pero la composición
        // del turno acaba de cambiar, así que el `lineas` que tiene en memoria quedó
        // viejo. En lista alcanza con repintar; en Kanban hay que volver a leer la
        // composición del día, o la card seguiría mostrando los servicios anteriores.
        else renderAgendaList();

        // ---- Paso 3: se relee y se muestran los totales reales persistidos -----
        try {
          const guardado = await window.cargarComposicionTurno(idReserva);
          const t = guardado || {};
          const filas = (etiqueta, valor) => `
            <div style="display:flex;justify-content:space-between;gap:14px;font-size:0.85rem;padding:4px 0;">
              <span style="color:var(--text-muted);">${escapeHtml(etiqueta)}</span>
              <span style="color:var(--text-main);font-weight:600;">${escapeHtml(valor)}</span>
            </div>`;
          const lineasPersistidas = Array.isArray(guardado.composicion) ? guardado.composicion : [];
          const durTotal = lineasPersistidas.reduce((acc, l) => acc + (parseInt(l.duracion_snapshot, 10) || 0), 0);
          await Swal.fire({
            title: "Composición guardada",
            html: `
              <div style="text-align:left;font-size:0.9rem;line-height:1.6;color:var(--text-main);">
                ${filas("Duración total", `${durTotal} min`)}
                ${filas("Subtotal", window._din(t.subtotal_pactado))}
                ${filas("Descuento", window._din(t.descuento_aplicado))}
                ${filas("Total pactado", window._din(t.total_pactado))}
                ${filas("Total pagado", window._din(t.total_pagado))}
                ${filas("Saldo pendiente", window._din(t.saldo_pendiente))}
                ${t.cupon_codigo_aplicado ? `<div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);">Cupón aplicado: ${escapeHtml(t.cupon_codigo_aplicado)}${t.cupon_porcentaje_aplicado ? ` (${escapeHtml(String(t.cupon_porcentaje_aplicado))}%)` : ""}</div>` : ""}
              </div>`,
            icon: "success",
            background: "var(--card-bg)",
            color: "var(--text-main)"
          });
        } catch (e) { console.error(e); }
      } catch (err) {
        Object.assign(turno, snapshot);
        renderAgendaKanban();
        mostrarToast("Error de red al guardar el turno", "error");
      } finally {
        movimientosEnVuelo.delete(edicionKey);
      }
    })();
  } catch (err) { console.error(err); mostrarToast("Error al editar el turno", "error"); }
};

window.cancelarReserva = async (id) => {
  const confirmado = await Swal.fire({
    title: '¿Cancelar turno?', icon: 'warning', showCancelButton: true,
    background: 'var(--card-bg)', color: 'var(--text-main)'
  });
  if (!confirmado.isConfirmed) return;
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "cancelar_reserva", id_reserva: id, token: getToken() }) });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al cancelar');
    await cargarAgenda();
    Swal.fire({ title: "Cancelado", icon: "success", background: "var(--card-bg)", color: "var(--text-main)" });
  } catch (err) { console.error(err); mostrarToast(err.message || "Error al cancelar", "error"); }
};
window.eliminarReserva = async (id) => {
  const confirmado = await Swal.fire({
    title: '¿Eliminar turno?',
    html: 'El turno se ocultará de la agenda, pero <b>el registro y sus ingresos se conservan</b> en la base de datos.',
    icon: 'warning', background: 'var(--card-bg)', color: 'var(--text-main)',
    showCancelButton: true, confirmButtonText: 'Sí, eliminar', cancelButtonText: 'Cancelar'
  });
  if (!confirmado.isConfirmed) return;
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "eliminar_reserva_admin", id_reserva: id, token: getToken() }) });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al eliminar');
    cargarAgenda();
    mostrarToast("Turno eliminado", "success");
  } catch (err) { mostrarToast(err.message || "Error al eliminar", "error"); }
};

// Cierre de turno: escribe SOLO estado_turno. El estado de pago (estado_pago)
// queda intacto; ya no se concatena el sufijo financiero en el estado operativo.
window.gestionarAsistencia = async (id, estadoPagoActual, accion, nombreServicio_full) => {
    const nombreSvc = (nombreServicio_full || "").split(" (")[0];
    const svcData = listaServiciosGlobal.find(s => s.nombre === nombreSvc);
    const precioSugerido = (accion === 'Completada' && svcData) ? parseFloat(svcData.precio) || 0 : 0;

    const extrasHtml = listaServiciosGlobal
        .filter(s => s.estado === 'Activo' && s.nombre !== nombreSvc)
        .map(s => `<option value="${escapeHtml(s.nombre)}" data-precio="${s.precio}">${escapeHtml(s.nombre)} (+${formatearMonedaAdmin(s.precio)})</option>`)
        .join('');

    const htmlModal = `
        <div style="text-align:left; display:flex; flex-direction:column; gap:16px;">
            <label style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Monto real ingresado en caja ($)</label>
            <input type="number" id="swal-ingreso" value="${precioSugerido}" style="width:100%; padding:14px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:1.1rem; font-weight:600; outline:none; color-scheme:inherit;" />
            <label style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Servicio Extra (Upselling)</label>
            <select id="swal-extra-servicio" style="width:100%; padding:14px; background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:10px; color:var(--panel-text); font-size:0.95rem; font-weight:500; outline:none; color-scheme:inherit;">
                <option value="">Ninguno</option>
                ${extrasHtml}
            </select>
        </div>`;

    const res = await Swal.fire({
        title: 'Cierre de Turno',
        html: htmlModal,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: `Confirmar ${accion.toLowerCase()}`,
        background: 'var(--card-bg)',
        color: 'var(--text-main)',
        confirmButtonColor: 'var(--accent)',
        didOpen: () => {
            const inputIngreso = document.getElementById('swal-ingreso');
            const selectExtra = document.getElementById('swal-extra-servicio');
            if (selectExtra && inputIngreso) {
                selectExtra.addEventListener('change', () => {
                    const opt = selectExtra.selectedOptions[0];
                    const precioExtra = opt ? parseFloat(opt.dataset.precio) || 0 : 0;
                    inputIngreso.value = precioSugerido + precioExtra;
                });
            }
        },
        preConfirm: () => {
            const ingreso = parseFloat(document.getElementById('swal-ingreso')?.value) || 0;
            const selectEl = document.getElementById('swal-extra-servicio');
            const extraNombre = selectEl?.value || '';
            return { ingreso, extraNombre };
        }
    });
    if (!res.isConfirmed) return;
    const { ingreso, extraNombre } = res.value;
    const servicioActualizado = extraNombre ? `${nombreSvc} + ${extraNombre}` : null;
    const upd = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "actualizar_asistencia", id_reserva: id, estado_turno: accion, ingreso_real: ingreso, servicio_actualizado: servicioActualizado, token: getToken() }) });
    const json = await upd.json();
    if (json.success) { cargarAgenda(); aplicarFiltrosDashboard(); mostrarToast(`Turno ${accion.toLowerCase()}`, "success"); }
    else { mostrarToast(json.error || "Error al actualizar", "error"); }
};

// STAFF
async function cargarProfesionales() {
  try {
    const res = await fetch(`${API_URL}?accion=list-profesionales&token=${getToken()}&t=${Date.now()}`);
    const json = await res.json();
    if (json.success && json.data.profesionales) {
      listaProfesionalesGlobal = json.data.profesionales;
      if($("block-prof")) $("block-prof").innerHTML = `<option value="">Cualquier profesional</option>` + listaProfesionalesGlobal.filter(p=>p.estado==='Activo').map(p=>`<option value="${p.id_profesional}">${p.nombre}</option>`).join('');
      renderProfesionalesList();
    }
  } catch(e) { console.error("Error cargando profesionales:", e); mostrarToast("Error al cargar el equipo", "error"); }
}

function renderProfesionalesList() {
    const container = $("admin-profs-container"); if(!container) return; container.innerHTML = "";
    const searchEl = $("search-staff"); const term = searchEl ? searchEl.value.toLowerCase() : "";
    const filtrados = listaProfesionalesGlobal.filter(p => (p.nombre||"").toLowerCase().includes(term));
    if(filtrados.length === 0) { container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No se encontraron profesionales.</div>`; return; }
    filtrados.forEach(p => {
      const isActivo = p.estado === 'Activo';
      const avatarHtml = p.url_imagen
        ? `<img src="${escapeHtml(p.url_imagen)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:1px solid var(--ui-border);flex-shrink:0;">`
        : `<div style="width:40px;height:40px;border-radius:50%;background:var(--ui-bg);border:1px solid var(--ui-border);display:flex;align-items:center;justify-content:center;color:var(--ui-text-muted);font-weight:700;font-size:0.9rem;flex-shrink:0;">${escapeHtml((p.nombre||'?')[0])}</div>`;
      container.innerHTML += `<div class="data-card"><div style="display:flex;align-items:center;gap:1rem;">${avatarHtml}<div><strong>${escapeHtml(p.nombre)}</strong><br><small style="color:var(--text-muted)">Servicios: ${escapeHtml(p.servicios === 'TODOS' ? 'Todos' : 'Específicos')}</small> <span class="badge ${isActivo ? 'active':'inactive'}">${escapeHtml(p.estado)}</span></div></div><div style="display:flex; gap:8px;"><button class="btn btn-secondary btn-sm" onclick="abrirEditarProf('${p.id_profesional}', '${escapeHtml(p.nombre).replace(/'/g,"\\'")}', '${escapeHtml(p.calendar_id).replace(/'/g,"\\'")}', '${escapeHtml(p.servicios).replace(/'/g,"\\'")}', '${escapeHtml(p.url_imagen||'').replace(/'/g,"\\'")}')">Editar</button><button class="btn ${isActivo ? 'btn-danger':'btn-secondary'} btn-sm" onclick="toggleProfesional('${p.id_profesional}')">${isActivo ? 'Desactivar':'Activar'}</button></div></div>`;
    });
}
window.toggleProfesional = async (id) => { const res = await fetch(API_URL, {method: "POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify({accion:"toggle_profesional", id:id, token: getToken()})}); const json = await res.json(); if(json.success) cargarProfesionales(); };

// CLIENTES (CRM)
async function cargarClientes() {
  try {
    const res = await fetch(`${API_URL}?accion=list-clientes&token=${getToken()}&t=${Date.now()}`);
    const json = await res.json();
    if (json.success) { listaClientesGlobal = json.data; renderClientesList(); }
  } catch(e) { console.error("Error cargando clientes:", e); mostrarToast("Error al cargar clientes", "error"); }
}

function renderClientesList() {
    // Se escribe en `#admin-clientes-rows`, NO en el contenedor: el header de
    // columnas es su PRIMER hijo y vive dentro de `#admin-clientes-container`
    // para compartir caja (y por lo tanto el cálculo de los tracks `fr`) con las
    // filas. Si el render vaciara el contenedor, borraría el header en cada
    // repintado. `#admin-clientes-rows` sí es un envoltorio propio y recibe el
    // `innerHTML = ""` como antes.
    const container = $("admin-clientes-rows"); if(!container) return; container.innerHTML = "";
    const searchEl = $("search-clientes"); const term = searchEl ? searchEl.value.toLowerCase() : "";
    const filtrados = listaClientesGlobal.filter(c => (c.nombre||"").toLowerCase().includes(term) || (c.email||"").toLowerCase().includes(term) || (c.telefono||"").toLowerCase().includes(term));

    // ── PAGINACIÓN (mismo patrón que Finanzas, estado independiente) ─────────
    // `listaClientesGlobal` NO se corta ni se reemplaza: la siguen usando
    // `buscarClienteGlobalPorId` y el selector de la línea ~2918. Solo se corta
    // `pageSlice`, que es lo que se dibuja.
    window.clientesFiltradosActual = filtrados;
    const totalPages = Math.max(1, Math.ceil(filtrados.length / itemsPorPaginaClientes));
    if (paginaClientesActual > totalPages) paginaClientesActual = totalPages;
    if (paginaClientesActual < 1) paginaClientesActual = 1;

    // El paginador se sincroniza ANTES del return del empty-state: si no, con 0
    // resultados quedaría mostrando el "Pág X de Y" de la consulta anterior.
    if($("clientes-per-page")) $("clientes-per-page").value = itemsPorPaginaClientes >= 9999 ? 'all' : String(itemsPorPaginaClientes);
    if($("clientes-page-info")) $("clientes-page-info").textContent = `Pág ${paginaClientesActual} de ${totalPages}`;
    if($("btn-clientes-prev")) $("btn-clientes-prev").disabled = paginaClientesActual === 1;
    if($("btn-clientes-next")) $("btn-clientes-next").disabled = paginaClientesActual === totalPages || totalPages === 0;

    if(filtrados.length === 0) { container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No se encontraron clientes.</div>`; return; }

    const startIndex = (paginaClientesActual - 1) * itemsPorPaginaClientes;
    const pageSlice = filtrados.slice(startIndex, startIndex + itemsPorPaginaClientes);
    pageSlice.forEach(c => {
      const tel = (c.telefono||"").replace(/\D/g, ''); const notasSeguras = (c.notas_clinicas || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      // Un dato ausente se muestra como "—" en SU propia celda. No se toca el valor
      // almacenado: `tel` sigue siendo el que decide si hay botón de WhatsApp, y
      // el `onclick` de Ficha usa `c.telefono` crudo, no este texto.
      const telDisplay = tel ? escapeHtml(c.telefono) : '<span style="color:var(--ui-text-muted);">—</span>';
      // NÚMERO y MAIL son celdas separadas en desktop, así que no hay separador
      // "·" entre ellos: cada uno lleva su "—" si el dato falta.
      const emailDisplay = c.email ? escapeHtml(c.email) : '<span style="color:var(--ui-text-muted);">—</span>';
      const waLink = tel ? `<a href="https://wa.me/${tel}" target="_blank" style="background:transparent; color:var(--ui-text); border:1px solid var(--ui-border); padding:4px 10px; border-radius:4px; font-weight:700; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; text-decoration:none; display:inline-flex; align-items:center; gap:6px; transition:all 0.2s; white-space:nowrap;" onmouseover="this.style.borderColor='var(--ui-text)'" onmouseout="this.style.borderColor='var(--ui-border)'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>WhatsApp</a>` : '';
      container.innerHTML += `<div class="data-card cliente-fila"><div class="cliente-campo cliente-nombre">${escapeHtml(c.nombre)}</div><div class="cliente-campo cliente-telefono">${telDisplay}</div><div class="cliente-campo cliente-mail">${emailDisplay}</div><div class="cliente-registro">${formatearFechaRegistroCliente(c.fecha_registro)}</div><div class="cliente-acciones">${waLink}<button class="btn btn-secondary btn-sm" onclick="abrirFichaCliente('${c.id_cliente}', '${escapeHtml(c.nombre).replace(/'/g,"\\'")}', '${escapeHtml(c.telefono).replace(/'/g,"\\'")}', '${notasSeguras}')">Ficha</button><button type="button" class="btn btn-secondary btn-sm" data-client-id="${escapeHtml(c.id_cliente)}">Editar</button></div></div>`;
    });
}

// `fecha_registro` es TIMESTAMPTZ y el listado viene ordenado por ella DESC
// (`list-clientes`). Cortar el ISO a secas mostraría el día siguiente para los
// registros hechos de noche, así que se convierte con la zona horaria de la
// marca —el mismo criterio que `getBADate()—` y se devuelve dd/mm/aaaa sin hora.
// El formateo va por partes y con ceros explícitos porque `toLocaleDateString`
// devuelve "5/10/2026" en es-AR, que no es dd/mm/aaaa. La columna admite NULL
// (tiene default pero no es NOT NULL), de ahí el "-".
function formatearFechaRegistroCliente(valor) {
    if (!valor) return '-';
    const d = new Date(valor);
    if (isNaN(d.getTime())) return '-';
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: zonaHorariaMarca, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = (t) => (p.find(x => x.type === t) || {}).value || '';
    return `${g('day')}/${g('month')}/${g('year')}`;
}

// =========================================================================
// CLIENTES (CRM) · ALTA Y EDICIÓN MANUAL
// -------------------------------------------------------------------------
// Un SOLO modal para los dos modos. El modo se deduce de #cli-id: vacío es
// alta, con uuid es edición. Es la misma convención que la Ficha (#ficha-id).
// El cliente se resuelve por id_cliente contra listaClientesGlobal, así que
// el botón "Editar" solo declara data-client-id y no amplía el patrón frágil
// de onclick que arrastra nombre/teléfono. Las notas NO se tocan: eso sigue
// siendo exclusivo de la Ficha.
// =========================================================================
const buscarClienteGlobalPorId = (id) => (listaClientesGlobal || []).find(c => c && String(c.id_cliente) === String(id)) || null;

window.abrirCliente = (idCliente) => {
    const cliente = idCliente ? buscarClienteGlobalPorId(idCliente) : null;
    if (idCliente && !cliente) { mostrarToast("No se encontró el cliente en el directorio", "error"); return; }
    const enEdicion = !!cliente;
    if ($("cli-id")) $("cli-id").value = enEdicion ? cliente.id_cliente : "";
    // Valores CRUDOS: el teléfono se precarga tal como está almacenado y nunca
    // se normaliza para mostrarlo. Los dígitos solo son clave de identidad.
    if ($("cli-nombre")) $("cli-nombre").value = enEdicion ? (cliente.nombre || "") : "";
    if ($("cli-telefono")) $("cli-telefono").value = enEdicion ? (cliente.telefono || "") : "";
    if ($("cli-email")) $("cli-email").value = enEdicion ? (cliente.email || "") : "";
    if ($("modal-cliente-titulo")) $("modal-cliente-titulo").textContent = enEdicion ? "Editar cliente" : "Agregar cliente";
    if ($("btn-save-cliente")) $("btn-save-cliente").textContent = enEdicion ? "Guardar cambios" : "Guardar cliente";
    if ($("modal-cliente")) $("modal-cliente").classList.remove("hidden");
    if ($("cli-nombre")) $("cli-nombre").focus();
};

safeListen("btn-open-add-cliente", "click", () => window.abrirCliente(null));
safeListen("btn-close-cliente", "click", () => { if($("modal-cliente")) $("modal-cliente").classList.add("hidden"); });

// Un único delegate para todos los botones "Editar" del directorio, igual que el
// delegate de los buscadores: el botón declara el id y el handler resuelve.
document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-client-id]");
    if (!btn) return;
    e.preventDefault();
    window.abrirCliente(btn.dataset.clientId);
});

safeListen("form-cliente", "submit", async (e) => {
    e.preventDefault();
    const modal = $("modal-cliente");
    const btn = $("btn-save-cliente");
    const id = ($("cli-id").value || "").trim();
    const nombre = $("cli-nombre").value.trim();
    const telefono = $("cli-telefono").value.trim();
    const email = $("cli-email").value.trim();
    const cta = id ? "Guardar cambios" : "Guardar cliente";

    if (!nombre) {
        mostrarToast("El nombre del cliente no puede quedar vacío", "warning");
        if ($("cli-nombre")) $("cli-nombre").focus();
        return;
    }

    if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
    try {
        const payload = { accion: id ? "editar_cliente" : "agregar_cliente", nombre, telefono, email, token: getToken() };
        if (id) payload.id_cliente = id;
        const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
        const json = await res.json();
        if (json.success) {
            // El reset es SOLO del camino feliz: en error el formulario no se
            // toca, así el modal abierto conserva lo que el usuario escribió.
            if (modal) modal.classList.add("hidden");
            $("form-cliente").reset();
            if ($("cli-id")) $("cli-id").value = "";
            // SOLO el alta resetea a la pág 1: `agregar_cliente` no manda
            // fecha_registro, así que la BD le pone `now()` y el listado —que
            // viene ordenado por fecha_registro DESC— la deja PRIMERA. Sin este
            // reset, dar de alta estando en la pág 3 escondería al cliente nuevo.
            // Editar no resetea: el PATCH no toca fecha_registro, la posición en
            // el sort no cambia y el clamp natural de `renderClientesList()`
            // ya corrige la página si el conjunto se achicó.
            if (!id) paginaClientesActual = 1;
            await cargarClientes();
            mostrarToast(id ? "Cliente actualizado" : "Cliente agregado", "success");
        }
        else { mostrarToast(json.error || "No se pudo guardar el cliente", "error"); }
    } catch (err) { console.error("Error guardando cliente:", err); mostrarToast("Error de red al guardar", "error"); }
    finally { if (btn) { btn.textContent = cta; btn.disabled = false; } }
});

// AUTOCOMPLETADO DE CLIENTE (NUEVA RESERVA MANUAL) — datalist nativo
// Primer match gana y las correcciones manuales del teléfono se respetan.
// =========================================================================
const normalizarNombreCliente = (nombre) => String(nombre || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function poblarDatalistClientes() {
    const dl = $("lista-clientes-datalist");
    if (!dl) return;
    dl.innerHTML = '';
    mapaClientesXNombre = new Map();
    const clavesUsadas = new Set();
    (listaClientesGlobal || []).forEach(c => {
        if (!c || !c.nombre) return;
        const clave = normalizarNombreCliente(c.nombre);
        if (!clave || clavesUsadas.has(clave)) return;
        clavesUsadas.add(clave);
        const telefono = c.telefono || '';
        const opt = document.createElement('option');
        opt.value = c.nombre;
        opt.label = telefono ? `Tel: ${telefono}` : 'Sin teléfono';
        dl.appendChild(opt);
        mapaClientesXNombre.set(clave, { nombre: c.nombre, telefono });
    });
    ultimoTelefonoAutofill = null;
}

function manejarAutocompletadoCliente() {
    const inputNombre = $("add-res-cliente");
    const inputTelefono = $("add-res-telefono");
    if (!inputNombre || !inputTelefono) return;
    const clave = normalizarNombreCliente(inputNombre.value);
    const clienteMatch = clave ? (mapaClientesXNombre.get(clave) || null) : null;
    const telefonoActual = inputTelefono.value;

    if (clienteMatch) {
        // Solo sobrescribimos si el campo está vacío o si el valor actual es "nuestro" (autollenado).
        if (telefonoActual === '' || telefonoActual === ultimoTelefonoAutofill) {
            inputTelefono.value = clienteMatch.telefono;
            ultimoTelefonoAutofill = clienteMatch.telefono;
        }
    } else {
        // Sin match (nombre editado a medias o cliente nuevo): limpiamos únicamente
        // si el teléfono sigue siendo el que nosotros autollenamos (no una corrección manual).
        if (ultimoTelefonoAutofill !== null && telefonoActual === ultimoTelefonoAutofill) {
            inputTelefono.value = '';
            ultimoTelefonoAutofill = null;
        }
    }
}
safeListen("add-res-cliente", "input", manejarAutocompletadoCliente);

// CUPONES
async function cargarCupones() {
    const containerCupones = $("admin-cupones-container"); if (!containerCupones) return;
    try {
        const res = await fetch(`${API_URL}?accion=list-cupones&token=${getToken()}`);
        const json = await res.json();
        if (json.success && json.data.cupones) {
            containerCupones.innerHTML = '';
            json.data.cupones.forEach(cupon => {
                const badgeClass = cupon.estado === 'Activo' ? 'active' : 'inactive';
                const vencStr = cupon.fecha_vencimiento ? new Date(cupon.fecha_vencimiento + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '<span style="color: var(--ui-text-muted);">Sin límite</span>';
                containerCupones.innerHTML += `<div class="data-card"><div><strong>${cupon.codigo}</strong></div><div style="color: var(--success); font-weight:600;">-${cupon.descuento_porcentaje}%</div><div style="color: var(--text-muted); font-size: 0.85rem;">${vencStr}</div><div style="text-align: right;"><button class="badge ${badgeClass}" onclick="toggleCupon('${cupon.codigo}')" style="cursor: pointer; border: none;">${cupon.estado}</button></div></div>`;
            });
        }
    } catch (e) { console.error("Error cargando cupones:", e); mostrarToast("Error al cargar cupones", "error"); }
}
window.toggleCupon = async function(codigo) {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ accion: 'toggle_cupon', token: getToken(), codigo: codigo }) });
    const json = await res.json(); if (json.success) cargarCupones();
};

// =========================================================================
// HELPERS PREMIUM DE UX (Toast + Escapado Seguro)
// =========================================================================
function mostrarToast(mensaje, icono = 'info') {
  if (typeof Swal !== 'undefined') {
    Swal.fire({ title: mensaje, icon: icono, toast: true, position: 'top-end', showConfirmButton: false, timer: 2500, background: 'var(--card-bg)', color: 'var(--text-main)' });
  } else {
    if(window.alert) window.alert(mensaje);
  }
}

const escapeHtml = (str) => {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
};

// =========================================================================
// FASE 1: HABILITAR MODALES Y FORMULARIOS (CRUD BASE)
// =========================================================================

// --- CUPONES: Crear ---
safeListen("btn-open-add-cupon", "click", () => { if($("modal-add-cupon")) $("modal-add-cupon").classList.remove("hidden"); });
safeListen("btn-close-modal-cupon", "click", () => { if($("modal-add-cupon")) $("modal-add-cupon").classList.add("hidden"); });
safeListen("form-add-cupon", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-cupon"); const codigo = $("add-cupon-codigo").value.trim().toUpperCase();
  const porcentaje = $("add-cupon-porcentaje").value; const vencimiento = $("add-cupon-vencimiento").value || null;
  if (!codigo || !porcentaje) { mostrarToast("Completá código y descuento", "warning"); return; }
  if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "agregar_cupon", codigo: codigo, porcentaje: porcentaje, vencimiento: vencimiento, token: getToken() }) });
    const json = await res.json();
    if (json.success) { $("modal-add-cupon").classList.add("hidden"); $("form-add-cupon").reset(); cargarCupones(); mostrarToast("Cupón creado", "success"); }
    else { mostrarToast(json.error || "Error al crear cupón", "error"); }
  } catch (err) { console.error("Error creando cupón:", err); mostrarToast("Error de red al crear cupón", "error"); }
  finally { if (btn) { btn.textContent = "Crear"; btn.disabled = false; } }
});

// --- PROFESIONALES: Crear ---
safeListen("btn-open-add-prof", "click", () => { currentBase64ProfAdd = null; const dz = $("dropzone-add-prof"); if(dz) { dz.classList.remove("has-image"); dz.innerHTML = `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Clic para subir foto</span>`; } if($("add-prof-img-file")) $("add-prof-img-file").value = ""; poblarChecksServicios("add-prof-servicios", "TODOS"); if($("modal-add-prof")) $("modal-add-prof").classList.remove("hidden"); });
safeListen("btn-close-modal-prof", "click", () => { if($("modal-add-prof")) $("modal-add-prof").classList.add("hidden"); });
safeListen("form-add-prof", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-add-prof");
  const nombre = $("add-prof-nom").value.trim(); const calendar_id = $("add-prof-cal").value.trim();
  const servicios = obtenerServiciosChecksProf("add-prof-servicios");
  if (!nombre || !calendar_id) { mostrarToast("Nombre y Email son obligatorios", "warning"); return; }
  if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
  try {
    const payloadProf = { accion: "agregar_profesional", nombre: nombre, calendar_id: calendar_id, servicios: servicios, token: getToken() };
    if(currentBase64ProfAdd) payloadProf.imagen_base64 = currentBase64ProfAdd;
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payloadProf) });
    const json = await res.json();
    if (json.success) { $("modal-add-prof").classList.add("hidden"); $("form-add-prof").reset(); cargarProfesionales(); mostrarToast("Profesional creado", "success"); }
    else { mostrarToast(json.error || "Error al crear profesional", "error"); }
  } catch (err) { console.error("Error creando profesional:", err); mostrarToast("Error de red al crear profesional", "error"); }
  finally { if (btn) { btn.textContent = "Guardar"; btn.disabled = false; } }
});
// --- PROFESIONALES: Editar ---
safeListen("btn-close-edit-prof", "click", () => { if($("modal-edit-prof")) $("modal-edit-prof").classList.add("hidden"); });
safeListen("form-edit-prof", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-edit-prof");
  const nombre = $("edit-prof-nom").value.trim(); const calendar_id = $("edit-prof-cal").value.trim();
  const servicios = obtenerServiciosChecksProf("edit-prof-servicios"); const id = $("edit-prof-id").value;
  if (!nombre || !calendar_id) { mostrarToast("Nombre y Email son obligatorios", "warning"); return; }
  if (btn) { btn.textContent = "Actualizando..."; btn.disabled = true; }
  try {
    const payloadEditProf = { accion: "editar_profesional", id: id, nombre: nombre, calendar_id: calendar_id, servicios: servicios, token: getToken() };
    if(currentBase64ProfEdit) payloadEditProf.imagen_base64 = currentBase64ProfEdit;
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payloadEditProf) });
    const json = await res.json();
    if (json.success) { $("modal-edit-prof").classList.add("hidden"); cargarProfesionales(); mostrarToast("Profesional actualizado", "success"); }
    else { mostrarToast(json.error || "Error al actualizar profesional", "error"); }
  } catch (err) { console.error("Error editando profesional:", err); mostrarToast("Error de red al actualizar", "error"); }
  finally { if (btn) { btn.textContent = "Actualizar"; btn.disabled = false; } }
});

// Helper: Lee checkboxes de especialidades de un contenedor. Retorna 'TODOS' o lista no vacía.
function obtenerServiciosChecksProf(containerId) {
  const container = $(containerId); if (!container) return 'TODOS';
  const checks = container.querySelectorAll('input[type="checkbox"]:checked');
  const seleccionados = Array.from(checks).map(c => c.value);
  return (seleccionados.length === 0) ? 'TODOS' : seleccionados.join(',');
}

// --- RESERVAS MANUALES: Crear (RF-03 multi-servicio) ---
// El servicio y el profesional ya NO son selects sueltos del formulario: son las
// líneas de la composición, que usa el MISMO estado, renderer y helpers que
// Editar turno. Se manda únicamente id_servicio e id_profesional por línea; los
// snapshots y la economía los fija la RPC crear_turno_admin_rf03.
safeListen("btn-open-add-reserva", "click", () => {
  poblarDatalistClientes();
  window.iniciarComposicionNueva();
  if($("modal-add-reserva")) $("modal-add-reserva").classList.remove("hidden");
});
safeListen("btn-close-reserva", "click", () => { if($("modal-add-reserva")) $("modal-add-reserva").classList.add("hidden"); });
safeListen("form-add-reserva", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-add-reserva");
  const fecha = $("add-res-fecha").value; const hora = $("add-res-hora").value;
  const cliente = $("add-res-cliente").value.trim(); const telefono = $("add-res-telefono").value.trim();
  const estado_pago = $("add-res-pago").value;

  if (!fecha || !hora) { mostrarToast("Completá la fecha y la hora", "warning"); return; }
  if (!cliente || !telefono) { mostrarToast("Completá el cliente y el teléfono", "warning"); return; }

  const st = window._compTurno;
  if (!st || !st.lineas.length) { mostrarToast("El turno tiene que tener al menos un servicio", "warning"); return; }
  const lineas = [];
  for (let i = 0; i < st.lineas.length; i++) {
    const l = st.lineas[i];
    if (!l.id_servicio) { mostrarToast(`Elegí el servicio de la línea ${i + 1}`, "warning"); return; }
    if (!l.id_profesional) { mostrarToast(`Elegí el profesional de la línea ${i + 1}`, "warning"); return; }
    lineas.push({ id_servicio: l.id_servicio, id_profesional: l.id_profesional });
  }

  if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "crear_reserva_admin", lineas: lineas, fecha: fecha, hora: hora, cliente: cliente, telefono: telefono, estado_pago: estado_pago, token: getToken() }) });
    const json = await res.json();
    if (json.success) {
      const g = json.data || {};
      $("modal-add-reserva").classList.add("hidden");
      $("form-add-reserva").reset();
      window._compTurno = null;
      cargarAgenda();
      // Se muestran los valores REALES persistidos por la RPC, nunca los
      // estimados que se veían en el formulario antes de guardar.
      const filas = (etiqueta, valor) =>
        `<div style="display:flex;justify-content:space-between;gap:16px;font-size:0.85rem;padding:3px 0;">
          <span style="color:var(--text-muted);">${escapeHtml(etiqueta)}</span>
          <span style="font-weight:600;">${escapeHtml(valor)}</span>
        </div>`;
      Swal.fire({
        title: "Turno agendado",
        html: `
          <div style="text-align:left;font-size:0.85rem;line-height:1.5;">
            <div style="margin-bottom:8px;color:var(--text-muted);">${escapeHtml(g.id_reserva_interno || "")} · ${escapeHtml(String(g.fecha_turno || ""))} ${escapeHtml(String(g.hora_turno || ""))}</div>
            ${filas("Duración total", `${parseInt(g.duracion_total_min, 10) || 0} min`)}
            ${filas("Subtotal", window._din(g.subtotal_pactado))}
            ${filas("Descuento", window._din(g.descuento_aplicado))}
            ${filas("Total pactado", window._din(g.total_pactado))}
            ${filas("Total pagado", window._din(g.total_pagado))}
            ${filas("Saldo pendiente", window._din(g.saldo_pendiente))}
          </div>`,
        confirmButtonText: "Listo",
        customClass: { popup: 'swal-turno-nuevo' }
      });
    }
    else { mostrarToast(json.error || "Error al agendar turno", "error"); }
  } catch (err) { console.error("Error agendando turno:", err); mostrarToast("Error de red al agendar", "error"); }
  finally { if (btn) { btn.textContent = "Guardar"; btn.disabled = false; } }
});

// --- BLOQUEOS DE HORARIO: Crear ---
safeListen("btn-open-block", "click", () => { if($("modal-block-time")) $("modal-block-time").classList.remove("hidden"); });
safeListen("btn-close-block", "click", () => { if($("modal-block-time")) $("modal-block-time").classList.add("hidden"); });
safeListen("form-block-time", "submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-save-block");
  const fecha = $("block-fecha").value; const hora = $("block-hora").value;
  const profesional = $("block-prof").value || null; const motivo = $("block-motivo").value.trim();
  const duracion = parseInt($("block-duracion").value) || 30;
  if (!fecha || !hora || !motivo) { mostrarToast("Completá fecha, hora y motivo", "warning"); return; }
  if (btn) { btn.textContent = "Bloqueando..."; btn.disabled = true; }
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "bloquear_horario", fecha: fecha, hora_inicio: hora, profesional: profesional, motivo: motivo, duracion: duracion, token: getToken() }) });
    const json = await res.json();
    if (json.success) { $("modal-block-time").classList.add("hidden"); $("form-block-time").reset(); cargarAgenda(); mostrarToast("Horario bloqueado", "success"); }
    else { mostrarToast(json.error || "Error al bloquear horario", "error"); }
  } catch (err) { console.error("Error bloqueando horario:", err); mostrarToast("Error de red al bloquear", "error"); }
  finally { if (btn) { btn.textContent = "Bloquear"; btn.disabled = false; } }
});

// =========================================================================
// FASE 2: FUNCIONES GLOBALES Y FICHAS DE CLIENTE
// =========================================================================

// Pobla el contenedor de checkboxes de especialidades de un profesional.
// seleccionados: cadena 'TODOS' o lista de id_servicio separada por comas.
function poblarChecksServicios(containerId, seleccionados) {
  const container = $(containerId); if (!container) return;
  const marcados = new Set((seleccionados || 'TODOS').toString().split(',').map(s => s.trim()).filter(Boolean));
  container.innerHTML = '';
  if (listaServiciosGlobal.length === 0) { container.innerHTML = '<small style="color:var(--text-muted)">Cargá primero servicios.</small>'; return; }
  const esTodos = marcados.has('TODOS');
  const toggleTodos = document.createElement('label');
  toggleTodos.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;';
  const checkTodos = document.createElement('input'); checkTodos.type = 'checkbox'; checkTodos.value = 'TODOS'; checkTodos.checked = esTodos;
  checkTodos.style.cssText = 'width:18px;height:18px;accent-color:var(--accent);';
  checkTodos.addEventListener('change', () => { if (checkTodos.checked) container.querySelectorAll('input[data-svc]').forEach(c => c.checked = false); });
  toggleTodos.appendChild(checkTodos); toggleTodos.appendChild(document.createTextNode('Todos los servicios'));
  container.appendChild(toggleTodos);
  listaServiciosGlobal.forEach(svc => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.value = svc.id_servicio; chk.dataset.svc = '1';
    chk.style.cssText = 'width:18px;height:18px;accent-color:var(--accent);';
    chk.checked = esTodos ? false : marcados.has(String(svc.id_servicio));
    chk.addEventListener('change', () => { if (chk.checked && checkTodos.checked) { checkTodos.checked = false; } });
    label.appendChild(chk); label.appendChild(document.createTextNode(svc.nombre));
    container.appendChild(label);
  });
}

window.abrirEditarProf = (id, nombre, calendar_id, servicios, urlImagen) => {
  if($("edit-prof-id")) $("edit-prof-id").value = id;
  if($("edit-prof-nom")) $("edit-prof-nom").value = nombre;
  if($("edit-prof-cal")) $("edit-prof-cal").value = calendar_id;
  currentBase64ProfEdit = null;
  const dz = $("dropzone-edit-prof");
  if(dz) {
    if(urlImagen && urlImagen !== 'undefined' && urlImagen !== '') {
      dz.classList.add("has-image"); dz.innerHTML = `<img src="${urlImagen}" /><span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Cambiar foto</span>`;
    } else {
      dz.classList.remove("has-image"); dz.innerHTML = `<span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg> Cambiar foto</span>`;
    }
  }
  if($("edit-prof-img-file")) $("edit-prof-img-file").value = "";
  poblarChecksServicios("edit-prof-servicios", servicios);
  if($("modal-edit-prof")) $("modal-edit-prof").classList.remove("hidden");
};

window.abrirFichaCliente = (id, nombre, telefono, notas) => {
  if($("ficha-id")) $("ficha-id").value = id;
  if($("ficha-nombre")) $("ficha-nombre").textContent = nombre || '';
  if($("ficha-contacto")) $("ficha-contacto").textContent = telefono ? `WhatsApp: ${telefono}` : '';
  if($("ficha-notas")) $("ficha-notas").value = notas || '';
  if($("modal-ficha-cliente")) $("modal-ficha-cliente").classList.remove("hidden");
};

safeListen("btn-close-ficha", "click", () => { if($("modal-ficha-cliente")) $("modal-ficha-cliente").classList.add("hidden"); });
safeListen("form-ficha-cliente", "submit", async (e) => {
  e.preventDefault();
  const btn = $("ficha-save-btn");
  const id = $("ficha-id").value; const notas = $("ficha-notas").value;
  if (btn) { btn.textContent = "Guardando..."; btn.disabled = true; }
  try {
    const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ accion: "guardar_nota_cliente", id_cliente: id, notas: notas, token: getToken() }) });
    const json = await res.json();
    if (json.success) { $("modal-ficha-cliente").classList.add("hidden"); cargarClientes(); mostrarToast("Notas guardadas", "success"); }
    else { mostrarToast(json.error || "Error al guardar notas", "error"); }
  } catch (err) { console.error("Error guardando ficha:", err); mostrarToast("Error de red al guardar", "error"); }
  finally { if (btn) { btn.textContent = "Guardar Ficha"; btn.disabled = false; } }
});

// =========================================================================
// FASE 3: ANÁLISIS CON IA
// =========================================================================
safeListen("btn-analizar-ia", "click", async () => {
  const btn = $("btn-analizar-ia"); if (!btn) return;
  btn.textContent = "Analizando..."; btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}?accion=analizar_ia&token=${getToken()}`);
    const json = await res.json();
    if (!json.success) { mostrarToast(json.error || "Error al analizar", "error"); return; }
    const insights = json.data.insights || '';
    const consejos = insights.split('|||').map(c => c.trim()).filter(Boolean);
    let html = '<div style="text-align:left; display:flex; flex-direction:column; gap:16px; padding:10px 0;">';
    consejos.forEach(c => {
      const safe = escapeHtml(c).replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--success)">$1</strong>');
      html += `<div style="background:var(--input-bg);padding:16px;border-radius:12px;border-left:3px solid var(--accent);font-size:0.95rem;line-height:1.5;">${safe}</div>`;
    });
    html += '</div>';
    Swal.fire({ title: 'Análisis de Negocio', html: html, icon: null, width: 600, background: 'var(--card-bg)', color: 'var(--text-main)', confirmButtonColor: 'var(--accent)' });
  } catch (err) { console.error("Error en análisis IA:", err); mostrarToast("Error de red al conectar con la IA", "error"); }
  finally { btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg> Analizar con IA'; btn.disabled = false; }
});

// =========================================================================
// FASE 4: BÚSQUEDAS, FILTROS AGENDA Y PAGINACIÓN AGENDA
// =========================================================================
// Buscar cambia el conjunto filtrado, así que vuelve a la pág 1 (si no, se
// puede quedar en una página que ya no existe).
safeListen("search-clientes", "input", () => { paginaClientesActual = 1; renderClientesList(); });
safeListen("search-staff", "input", () => { renderProfesionalesList(); });

// CRM · paginación del directorio. Espejo literal del bloque de Finanzas: los
// tres eventos que cambian el conjunto (per-page) resetean a la pág 1, y
// Anterior/Siguiente solo mueven el reloj SIN tocar filtros ni recargar.
safeListen("clientes-per-page", "change", (e) => {
  itemsPorPaginaClientes = e.target.value === 'all' ? 9999 : parseInt(e.target.value, 10);
  paginaClientesActual = 1; renderClientesList();
});
safeListen("btn-clientes-prev", "click", () => { if (paginaClientesActual > 1) { paginaClientesActual--; renderClientesList(); } });
safeListen("btn-clientes-next", "click", () => {
  // El límite sale del conjunto filtrado COMPLETO (espejo), nunca del slice que
  // se está dibujando: si se usara el slice, "Siguiente" nunca avanzaría.
  const total = Math.max(1, Math.ceil(((window.clientesFiltradosActual || []).length) / itemsPorPaginaClientes));
  if (paginaClientesActual < total) { paginaClientesActual++; renderClientesList(); }
});

// --- RF-04: botón "limpiar" de los buscadores ---
// Un solo delegate: cada botón declara su input con data-clear-target y el
// render se resuelve desde este mapa, sin duplicar listeners por módulo.
const RENDER_POR_BUSCADOR = {
  "search-dashboard": () => { currentPageDash = 1; renderDashboardTable(); },
  "search-agenda": () => renderAgendaList(),
  "search-servicios": () => renderServiciosList(),
  "search-staff": () => renderProfesionalesList(),
  "search-clientes": () => { paginaClientesActual = 1; renderClientesList(); },
  // El buscador y su "X" cambian el conjunto, así que vuelven a la pág 1.
  "buscador-finanzas": () => { paginaFinanzasActual = 1; aplicarFiltrosFinanzas(); }
};

function sincronizarBotonLimpiar(input) {
  const wrap = input && input.closest ? input.closest(".search-wrapper") : null;
  if (wrap) wrap.classList.toggle("has-value", String(input.value || "").trim() !== "");
}

function limpiarBusqueda(inputId) {
  const input = $(inputId);
  if (!input) return;
  input.value = "";
  sincronizarBotonLimpiar(input);
  const render = RENDER_POR_BUSCADOR[inputId];
  if (render) render();
  input.focus();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".search-clear");
  if (!btn) return;
  e.preventDefault();
  limpiarBusqueda(btn.dataset.clearTarget);
});

// La "X" solo aparece cuando hay texto: se sincroniza al escribir y al cargar.
document.querySelectorAll(".search-wrapper .search-bar").forEach((input) => {
  sincronizarBotonLimpiar(input);
  input.addEventListener("input", () => sincronizarBotonLimpiar(input));
});

// --- RF-04: filtro de estado de agenda ---
// El select se filtra contra el estado OPERATIVO (estado_turno), no contra el
// financiero. Los <option> del HTML conservan sus valores históricos, así que
// se traducen al vocabulario canónico de estado_turno y el match es exacto:
// "PENDIENTE" es el turno aún no atendido (Agendada), no un estado de pago.
const ESTADO_TURNO_POR_OPCION = {
  "PENDIENTE": "Agendada",
  "COMPLETADO": "Completada",
  "BLOQUEADO": "Bloqueada"
};

function obtenerFiltroEstadoAgenda() {
  const sel = $("filter-agenda-estado");
  if (!sel || !sel.value) return "";
  return ESTADO_TURNO_POR_OPCION[sel.value.toUpperCase()] || "";
}

function coincideEstadoAgenda(estadoTurno) {
  const clave = obtenerFiltroEstadoAgenda();
  if (!clave) return true;
  return (estadoTurno || "Agendada") === clave;
}

// Al cambiar el estado se resetea la página y se re-renderiza. renderAgendaList
// ya despacha a renderAgendaKanban cuando la vista activa es Kanban.
function renderAgendaSegunFiltros() {
  currentPageAgenda = 1;
  renderAgendaList();
}

safeListen("filter-agenda-estado", "change", renderAgendaSegunFiltros);

// --- Filtros de fecha de Agenda ---
// currentAgendaFilter, currentPageAgenda e itemsPerPageAgenda ya están declarados arriba.
function configurarFiltrosAgenda() {
  document.querySelectorAll('.filter-agenda-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-agenda-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      e.target.classList.add('active'); e.target.setAttribute('aria-pressed', 'true');
      currentAgendaFilter = e.target.dataset.rango;
      currentPageAgenda = 1;
      renderAgendaList();
    });
  });
}

// --- Paginación Agenda ---
let itemsPerPageAgendaLocal = 10; // Variable local robusta

safeListen("agenda-per-page", "change", (e) => {
  itemsPerPageAgendaLocal = e.target.value === 'all' ? 9999 : parseInt(e.target.value);
  currentPageAgenda = 1; renderAgendaList();
});
safeListen("btn-agenda-prev", "click", () => { if (currentPageAgenda > 1) { currentPageAgenda--; renderAgendaList(); } });
safeListen("btn-agenda-next", "click", () => { currentPageAgenda++; renderAgendaList(); });

// --- Paginación Finanzas ---
// Mismo comportamiento que la de Agenda, con su propio estado y sus propios
// IDs. El clamp NO va acá: vive en aplicarFiltrosFinanzas, así que Prev/Next
// no necesitan saber cuántas páginas hay y registrar/anular un gasto no puede
// dejar la vista en una página fantasma.
safeListen("finanzas-per-page", "change", (e) => {
  itemsPorPaginaFinanzas = e.target.value === 'all' ? 9999 : parseInt(e.target.value);
  paginaFinanzasActual = 1; aplicarFiltrosFinanzas();
});
safeListen("btn-finanzas-prev", "click", () => { if (paginaFinanzasActual > 1) { paginaFinanzasActual--; aplicarFiltrosFinanzas(); } });
safeListen("btn-finanzas-next", "click", () => {
  // Se compara contra totalPages para no pasar de la última aunque el botón
  // llegara a dispararse con otro estado (Agenda no lo hace: solo usa el
  // atributo `disabled`).
  const total = Math.max(1, Math.ceil((window.flujoCajaActual || []).length / itemsPorPaginaFinanzas));
  if (paginaFinanzasActual < total) { paginaFinanzasActual++; aplicarFiltrosFinanzas(); }
});

// =========================================================================
// NUEVA SECCIÓN MARCA BLANCA Y PAGOS (UX Premium + Contraste Inteligente)
// =========================================================================

// Variables globales para el base64 de logos subidos
let currentBase64Logo = null;
let currentBase64Isotipo = null;
let currentBase64Login = null;
let currentBase64Icono = null;

// Helpers para sincronizar cada par color picker + input de texto
function sincronizarColorPicker(inputColorId, inputTextId) {
    const colorPicker = $(inputColorId); const textInput = $(inputTextId);
    if (!colorPicker || !textInput) return;
    // Al mover el picker, actualiza el texto
    colorPicker.addEventListener('input', () => { 
        textInput.value = colorPicker.value; 
    });
    // Al escribir el texto, valida HEX y actualiza el picker
    textInput.addEventListener('input', () => {
        const val = textInput.value.trim();
        if (/^#([0-9A-Fa-f]{6})$/.test(val)) { colorPicker.value = val; }
    });
}

// 1. Cargar datos desde el Backend a los inputs reales del HTML
async function cargarConfiguracionMarca() {
    try {
        const res = await fetch(`${API_URL}?accion=obtener_marca&${tokenParam()}`);
        const json = await res.json();
        if (json.success && json.data) {
            const conf = json.data;

            // Colores (solo rellenar picker + texto; NO inyectar CSS en el admin)
            if (conf.color_acento) { if($('color-accent')) $('color-accent').value = conf.color_acento; if($('color-accent-text')) $('color-accent-text').value = conf.color_acento; }
            if (conf.color_fondo) { if($('color-bg')) $('color-bg').value = conf.color_fondo; if($('color-bg-text')) $('color-bg-text').value = conf.color_fondo; }
            if (conf.color_tarjetas) { if($('color-card')) $('color-card').value = conf.color_tarjetas; if($('color-card-text')) $('color-card-text').value = conf.color_tarjetas; }
            if (conf.color_texto) { if($('color-text')) $('color-text').value = conf.color_texto; if($('color-text-text')) $('color-text-text').value = conf.color_texto; }
            if (conf.color_secundario) { if($('color-secondary')) $('color-secondary').value = conf.color_secundario; if($('color-secondary-text')) $('color-secondary-text').value = conf.color_secundario; }
            if (conf.color_texto_secundario) { if($('color-text-sec')) $('color-text-sec').value = conf.color_texto_secundario; if($('color-text-sec-text')) $('color-text-sec-text').value = conf.color_texto_secundario; }
            if (conf.color_fondo_campos) { if($('marca-color-campos')) $('marca-color-campos').value = conf.color_fondo_campos; if($('marca-color-campos-text')) $('marca-color-campos-text').value = conf.color_fondo_campos; }
            if (conf.color_precios) { if($('marca-color-precios')) $('marca-color-precios').value = conf.color_precios; if($('marca-color-precios-text')) $('marca-color-precios-text').value = conf.color_precios; }
            
            // Logo (se muestra en el dropzone)
            if (conf.logo_url) { 
                const dz = $('dropzone-marca-logo'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${conf.logo_url}" /><span>Logo actual</span>`; }
                if($('logo-login')) $('logo-login').src = conf.logo_url; 
                if($('logo-sidebar')) $('logo-sidebar').src = conf.logo_url; 
            }
            // Isotipo (se muestra en su dropzone)
            if (conf.isotipo_url) { 
                const dz = $('dropzone-marca-isotipo'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${conf.isotipo_url}" /><span>Isotipo actual</span>`; }
            }
            if (conf.logo_login_url) { 
                const dz = $('dropzone-marca-login'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${conf.logo_login_url}" /><span>Logo Login actual</span>`; }
            }
            if (conf.icono_acceso_url) { 
                const dz = $('dropzone-marca-icono'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${conf.icono_acceso_url}" /><span>Icono actual</span>`; }
            }
            if (conf.logo_login_url && $('logo-login')) $('logo-login').src = conf.logo_login_url;
            if (conf.isotipo_url && $('favicon-principal')) $('favicon-principal').href = conf.isotipo_url;
            if (conf.icono_acceso_url && $('apple-touch-principal')) $('apple-touch-principal').href = conf.icono_acceso_url;
            
            // Modalidades de Cobro (Checkboxes)
            if (conf.pago_local_activo !== undefined && $('marca-pago-local')) $('marca-pago-local').checked = conf.pago_local_activo;
            if (conf.mp_total_activo !== undefined && $('marca-mp-total')) $('marca-mp-total').checked = conf.mp_total_activo !== null && conf.mp_total_activo;
            if (conf.mp_sena_activo !== undefined && $('marca-mp-sena')) $('marca-mp-sena').checked = conf.mp_sena_activo !== null && conf.mp_sena_activo;
            if (conf.transferencia_activa !== undefined && $('marca-transferencia')) { 
                $('marca-transferencia').checked = conf.transferencia_activa; 
                if (conf.transferencia_activa && $('marca-datos-transferencia')) $('marca-datos-transferencia').style.display = 'block'; 
            }
            if (conf.datos_transferencia && $('marca-datos-transferencia')) $('marca-datos-transferencia').value = conf.datos_transferencia;
            if ($('marca-sena-mp')) $('marca-sena-mp').value = (conf.porcentaje_sena !== undefined && conf.porcentaje_sena !== null) ? conf.porcentaje_sena : 25;

            // Operación: Moneda, Zona Horaria y Horarios de Atención
            if (conf.moneda && $('marca_moneda')) $('marca_moneda').value = conf.moneda;
            if (conf.zona_horaria && $('marca_zona')) $('marca_zona').value = conf.zona_horaria;
            if (conf.hora_apertura && $('marca_apertura')) $('marca_apertura').value = String(conf.hora_apertura).slice(0, 5);
            if (conf.hora_cierre && $('marca_cierre')) $('marca_cierre').value = String(conf.hora_cierre).slice(0, 5);
            if (conf.hora_apertura) horaAperturaMarca = String(conf.hora_apertura).slice(0, 5);
            if (conf.hora_cierre) horaCierreMarca = String(conf.hora_cierre).slice(0, 5);

            // REGLA ESTRICTA: dias_laborables es un array JSONB de enteros (0=Dom...6=Sab).
            // Solo se marca el checkbox si Number(value) existe en el array.
            if (conf.dias_laborables && Array.isArray(conf.dias_laborables)) {
                const diasSet = new Set(conf.dias_laborables.map(Number));
                document.querySelectorAll('input[name="dias_laborables"]').forEach(cb => {
                    cb.checked = diasSet.has(Number(cb.value));
                });
            }

            // Actualizar globals para formateo dinámico de moneda y zona horaria en el admin
            if (conf.zona_horaria) zonaHorariaMarca = conf.zona_horaria;
            if (conf.moneda) monedaMarca = conf.moneda;
        }
    } catch(e) { console.error("Error cargando configuración de marca:", e); mostrarToast("Error al cargar la configuración", "error"); }
}

// 2. Live Preview de Colores y Toggle de Transferencia
function inicializarLivePreviewMarca() {
    // Sincronizar cada par de color picker + input de texto
    sincronizarColorPicker('color-accent', 'color-accent-text');
    sincronizarColorPicker('color-bg', 'color-bg-text');
    sincronizarColorPicker('color-card', 'color-card-text');
    sincronizarColorPicker('color-text', 'color-text-text');
    sincronizarColorPicker('color-secondary', 'color-secondary-text');
    sincronizarColorPicker('color-text-sec', 'color-text-sec-text');
    sincronizarColorPicker('marca-color-campos', 'marca-color-campos-text');
    sincronizarColorPicker('marca-color-precios', 'marca-color-precios-text');

    // Mostrar/ocultar textarea de datos de transferencia
    safeListen('marca-transferencia', 'change', (e) => { 
        if($('marca-datos-transferencia')) $('marca-datos-transferencia').style.display = e.target.checked ? 'block' : 'none';
    });

    // Dropzones de logo e isotipo: al elegir archivo se prepara el base64
    safeListen('input-marca-logo', 'change', () => {
        const file = $('input-marca-logo').files[0]; if(!file) return;
        comprimirImagen(file).then(base64 => {
            currentBase64Logo = base64;
            const dz = $('dropzone-marca-logo'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${base64}" /><span>Logo listo</span>`; }
        }).catch(err => { console.error("Error en logo:", err); mostrarToast("Logo inválido", "error"); });
    });
    safeListen('input-marca-isotipo', 'change', () => {
        const file = $('input-marca-isotipo').files[0]; if(!file) return;
        comprimirImagen(file).then(base64 => {
            currentBase64Isotipo = base64;
            const dz = $('dropzone-marca-isotipo'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${base64}" /><span>Isotipo listo</span>`; }
        }).catch(err => { console.error("Error en isotipo:", err); mostrarToast("Isotipo inválido", "error"); });
    });
    safeListen('input-marca-login', 'change', () => {
        const file = $('input-marca-login').files[0]; if(!file) return;
        comprimirImagen(file).then(base64 => {
            currentBase64Login = base64;
            const dz = $('dropzone-marca-login'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${base64}" /><span>Logo Login listo</span>`; }
        }).catch(err => { console.error("Error en logo login:", err); mostrarToast("Logo de login inválido", "error"); });
    });
    safeListen('input-marca-icono', 'change', () => {
        const file = $('input-marca-icono').files[0]; if(!file) return;
        comprimirImagen(file).then(base64 => {
            currentBase64Icono = base64;
            const dz = $('dropzone-marca-icono'); if(dz) { dz.classList.add('has-image'); dz.innerHTML = `<img src="${base64}" /><span>Icono listo</span>`; }
        }).catch(err => { console.error("Error en icono:", err); mostrarToast("Icono inválido", "error"); });
    });
}

// 3. Guardar los cambios (estructura que espera el backend existente)
safeListen("form-marca", "submit", async (e) => {
    e.preventDefault();
    const btn = $("btn-save-marca"); 
    if(!btn) return;
    btn.textContent = 'Guardando...'; btn.disabled = true;
    try {
        const payload = {
            accion: 'guardar_marca', 
            token: getToken(),
            color_acento: $("color-accent").value, 
            color_fondo: $("color-bg").value,
            color_tarjetas: $("color-card").value,
            color_texto: $("color-text").value,
            color_secundario: $("color-secondary").value,
            color_texto_secundario: $("color-text-sec").value,
            color_fondo_campos: $("marca-color-campos").value,
            color_precios: $("marca-color-precios").value,
            porcentaje_sena: parseInt($("marca-sena-mp").value) || 25,
            mp_total_activo: $("marca-mp-total").checked,
            mp_sena_activo: $("marca-mp-sena").checked,
            pago_local_activo: $("marca-pago-local").checked, 
            transferencia_activa: $("marca-transferencia").checked, 
            datos_transferencia: $("marca-datos-transferencia").value,
            moneda: $("marca_moneda").value,
            zona_horaria: $("marca_zona").value,
            hora_apertura: $("marca_apertura").value,
            hora_cierre: $("marca_cierre").value,
            // REGLA ESTRICTA: convertir a Number cada día marcado -> array real de enteros.
            dias_laborables: Array.from(document.querySelectorAll('input[name="dias_laborables"]:checked')).map(cb => Number(cb.value))
        };
        if (currentBase64Logo) payload.logo_base64 = currentBase64Logo;
        if (currentBase64Isotipo) payload.isotipo_base64 = currentBase64Isotipo;
        if (currentBase64Login) payload.logo_login_base64 = currentBase64Login;
        if (currentBase64Icono) payload.icono_acceso_base64 = currentBase64Icono;
        
        const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
        const json = await res.json();
        
        if (json.success) { 
            currentBase64Login = null;
            currentBase64Icono = null;
            Swal.fire({ icon: 'success', title: 'Configuración Guardada', background: 'var(--card-bg)', color: 'var(--text-main)', confirmButtonColor: 'var(--accent)' });
        } else {
            Swal.fire({ icon: 'error', title: 'Error al guardar', text: json.error, background: 'var(--card-bg)', color: 'var(--text-main)' });
        }
    } catch (error) {
        Swal.fire({ icon: 'error', title: 'Error de Red', background: 'var(--card-bg)', color: 'var(--text-main)' });
    } finally { 
        btn.textContent = "Guardar Configuración"; btn.disabled = false; 
    }
});

window.aplicarTemaMacro = function(tema) {
    const paletas = {
        oscuro: { 'color-accent': '#D4D4D4', 'color-bg': '#080808', 'color-card': '#121212', 'marca-color-campos': '#1A1A1A', 'color-text': '#F0F0F0', 'color-secondary': '#262626', 'color-text-sec': '#A3A3A3', 'marca-color-precios': '#E5E5E5' },
        claro: { 'color-accent': '#09090B', 'color-bg': '#F4F4F5', 'color-card': '#FFFFFF', 'marca-color-campos': '#E4E4E7', 'color-text': '#18181B', 'color-secondary': '#F4F4F5', 'color-text-sec': '#71717A', 'marca-color-precios': '#27272A' }
    };
    for (const id in paletas[tema]) {
        const el = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
        if (el) {
            el.value = paletas[tema][id];
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
};

// --- TOGGLE DE UI DEL ADMIN (Local Storage) ---
window.toggleAdminUI = function() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('aw_admin_ui_theme', isLight ? 'light' : 'dark');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', isLight ? '#F4F4F5' : '#1a1d24');
    if (ultimoConteoServicios !== null && document.getElementById('dashboard-chart')) actualizarGraficoDashboard(ultimoConteoServicios);
};

// Inicialización inmediata al leer el script
if (localStorage.getItem('aw_admin_ui_theme') === 'light') {
    document.body.classList.add('light-theme');
    const metaThemeInit = document.querySelector('meta[name="theme-color"]');
    if (metaThemeInit) metaThemeInit.setAttribute('content', '#F4F4F5');
}

// =========================================================================
// BUZÓN DE CONSULTAS (Chat Asíncrono Admin) — aislado bajo aw-inbox-*
// =========================================================================
function formatearHoraInbox(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
}

async function cargarChatsActivosAdmin() {
    const contenedor = $("aw-inbox-items");
    if (!contenedor) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'chats_activos', token: getToken() })
        });
        const json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.chats)) return;
        contenedor.innerHTML = '';
        if (json.data.chats.length === 0) {
            const vacio = document.createElement('div');
            vacio.className = 'aw-inbox-empty';
            vacio.textContent = 'Aún no hay consultas de clientes.';
            contenedor.appendChild(vacio);
            return;
        }
        json.data.chats.forEach(c => {
            const tituloVisual = c.alias_cliente ? c.alias_cliente : 'Visitante #' + c.chat_id.slice(-4).toUpperCase();
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'aw-inbox-item' + (c.chat_id === chatIdActual ? ' active' : '');
            item.dataset.chat = c.chat_id;
            const meta = document.createElement('div');
            meta.className = 'aw-inbox-item-meta';
            const idEl = document.createElement('span');
            idEl.className = 'aw-inbox-item-id';
            idEl.textContent = tituloVisual;
            const timeEl = document.createElement('span');
            timeEl.className = 'aw-inbox-item-time';
            timeEl.textContent = formatearHoraInbox(c.ultimo_mensaje);
            meta.appendChild(idEl);
            meta.appendChild(timeEl);
            item.appendChild(meta);
            item.addEventListener('click', () => abrirChatAdmin(c.chat_id));
            contenedor.appendChild(item);
        });
    } catch (e) { console.error("Error cargando consultas:", e); }
}

async function abrirChatAdmin(chatId) {
    if (!chatId) return;
    chatIdActual = chatId;
    document.querySelectorAll('.aw-inbox-item').forEach(el => el.classList.toggle('active', el.dataset.chat === chatId));
    const headerContenedor = document.getElementById('aw-inbox-history-title');
    if (headerContenedor) {
        headerContenedor.textContent = '';
        headerContenedor.style.display = 'flex';
        headerContenedor.style.alignItems = 'center';
        const spanId = document.createElement('span');
        spanId.textContent = 'ID: ' + chatId.slice(-4).toUpperCase();
        const btnEliminar = document.createElement('button');
        btnEliminar.type = 'button';
        btnEliminar.title = 'Eliminar consulta';
        btnEliminar.style.cssText = 'background:none; border:none; cursor:pointer; color:var(--text-main); font-size:1.2rem; margin-left:auto;';
        btnEliminar.textContent = '\u{1F5D1}\uFE0F';
        btnEliminar.addEventListener('click', () => eliminarChatAdmin(chatId));
        headerContenedor.appendChild(spanId);
        headerContenedor.appendChild(btnEliminar);
    }
    const contenedor = $("aw-inbox-msgs");
    if (!contenedor) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'obtener_mensajes', chat_id: chatId, token: getToken() })
        });
        const json = await res.json();
        if (json.status === 'success' && json.data && Array.isArray(json.data.mensajes)) {
            renderMsgsInbox(json.data.mensajes);
        }
        fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'marcar_leidos', chat_id: chatId, remitente: 'cliente', token: getToken() })
        }).catch(() => {});
        const input = $("aw-inbox-input");
        if (input) input.focus();
    } catch (e) { console.error("Error abriendo consulta:", e); }
}

function renderMsgsInbox(mensajes) {
    const contenedor = $("aw-inbox-msgs");
    if (!contenedor) return;
    contenedor.innerHTML = '';
    if (!mensajes || mensajes.length === 0) {
        const vacio = document.createElement('div');
        vacio.className = 'aw-inbox-empty';
        vacio.textContent = 'Sin mensajes. Escribí la primera respuesta.';
        contenedor.appendChild(vacio);
        return;
    }
    mensajes.forEach(m => contenedor.appendChild(crearBurbujaInbox(m)));
    contenedor.scrollTop = contenedor.scrollHeight;
}

function appendMsgInbox(m) {
    const contenedor = $("aw-inbox-msgs");
    if (!contenedor) return;
    const vacio = contenedor.querySelector('.aw-inbox-empty');
    if (vacio) vacio.remove();
    contenedor.appendChild(crearBurbujaInbox(m));
    contenedor.scrollTop = contenedor.scrollHeight;
}

function crearBurbujaInbox(m) {
    const burbuja = document.createElement('div');
    burbuja.className = 'aw-inbox-msg ' + (m.remitente === 'cliente' ? 'aw-inbox-msg-cliente' : 'aw-inbox-msg-admin');
    const texto = document.createElement('span');
    texto.className = 'aw-inbox-msg-texto';
    texto.textContent = m.mensaje || '';
    burbuja.appendChild(texto);
    if (m.created_at) {
        const hora = document.createElement('span');
        hora.className = 'aw-inbox-msg-time';
        hora.textContent = new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        burbuja.appendChild(hora);
    }
    return burbuja;
}

async function cargarMensajesChatActual() {
    if (!chatIdActual) return;
    const contenedor = $("aw-inbox-msgs");
    if (!contenedor) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'obtener_mensajes', chat_id: chatIdActual, token: getToken() })
        });
        const json = await res.json();
        if (json.status === 'success' && json.data && Array.isArray(json.data.mensajes)) {
            renderMsgsInbox(json.data.mensajes);
        }
        fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'marcar_leidos', chat_id: chatIdActual, remitente: 'cliente', token: getToken() })
        }).catch(() => {});
    } catch (e) { /* silencioso */ }
}

async function enviarMensajeAdmin() {
    const input = $("aw-inbox-input");
    if (!input || !chatIdActual) return;
    const texto = input.value.trim();
    if (!texto) return;
    input.value = '';
    const sendBtn = $("aw-inbox-send");
    if (sendBtn) sendBtn.disabled = true;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ accion: 'enviar_mensaje', chat_id: chatIdActual, remitente: 'admin', mensaje: texto, token: getToken() })
        });
        const json = await res.json();
        if (json.status === 'success' && json.data && Array.isArray(json.data.data) && json.data.data[0]) {
            appendMsgInbox(json.data.data[0]);
        } else {
            cargarMensajesChatActual();
        }
    } catch (e) {
        if (input) input.value = texto;
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.focus();
    }
}

function iniciarPollerChatsAdmin() {
    if (adminChatInterval) return;
    adminChatInterval = setInterval(() => {
        cargarChatsActivosAdmin();
        cargarMensajesChatActual();
    }, 15000);
}

function detenerPollerChatsAdmin() {
    if (adminChatInterval) { clearInterval(adminChatInterval); adminChatInterval = null; }
}

// [INYECCIÓN: Borrado de Chat Admin]
window.eliminarChatAdmin = function(chatId) {
    if (!chatId) return;
    Swal.fire({
        title: '¿Cerrar consulta?',
        text: "Se eliminará definitivamente.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: 'var(--accent, #d33)',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar'
    }).then((result) => {
        if (result.isConfirmed) {
            const token = getToken();
            fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accion: 'eliminar_chat', chat_id: chatId, token: token })
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    document.getElementById('aw-inbox-msgs').innerHTML = ''; // Limpia panel derecho
                    chatIdActual = null;
                    if (typeof cargarChatsActivosAdmin === 'function') cargarChatsActivosAdmin();
                }
            })
            .catch(() => {});
        }
    });
};

// --- MOTOR DE EXPORTACIÓN NATIVO ---
function exportarAExcel(nombreArchivo, filas) {
  if (!filas || filas.length === 0) {
    Swal.fire('Vacío', 'No hay datos para exportar en este rango.', 'info');
    return;
  }
  
  const cabeceras = Object.keys(filas[0]);
  const csvContent = [
    cabeceras.join(";"),
    ...filas.map(fila => 
      cabeceras.map(campo => {
        let valor = fila[campo] !== null && fila[campo] !== undefined ? fila[campo] : '';
        if (typeof valor === 'string') {
          valor = valor.replace(/"/g, '""').replace(/\n/g, ' ').replace(/;/g, ',');
          return `"${valor}"`;
        }
        return valor;
      }).join(";")
    )
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${nombreArchivo}_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportarFinanzasCSV() {
  if (typeof window.flujoCajaActual !== 'undefined' && window.flujoCajaActual.length > 0) {
    const dataExport = window.flujoCajaActual.map(item => ({
      Fecha: item.fecha.split("-").reverse().join("/"),
      Tipo: item.tipo.toUpperCase(),
      Concepto: item.titulo,
      Detalle: item.subtitulo,
      Ingreso: item.tipo === 'ingreso' ? item.monto : 0,
      Egreso: item.tipo === 'egreso' ? item.monto : 0
    }));
    exportarAExcel('LibroCaja', dataExport);
  } else {
    Swal.fire('Atención', 'No hay datos en caja para exportar.', 'warning');
  }
}

function exportarAgendaCSV() {
  const lista = window.agendaFiltradaActual || window.listaAgendaGlobal || [];
  if (lista.length > 0) {
    const dataExport = lista.map(t => ({
      Fecha: t.fecha_turno ? t.fecha_turno.split("-").reverse().join("/") : '',
      Hora: t.hora_turno || '',
      Cliente: t.cliente || '',
      Telefono: t.telefono || '',
      Servicio: t.servicio ? t.servicio.split(" (")[0] : '',
      EstadoTurno: t.estado_turno || 'Agendada',
      EstadoPago: t.estado_pago || '',
      Ingreso: t.ingreso_real || 0
    }));
    exportarAExcel('ReporteAgenda', dataExport);
  } else {
    Swal.fire('Atención', 'No hay turnos para exportar.', 'warning');
  }
}
