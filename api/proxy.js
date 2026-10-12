import { loadInstanceContext } from './_capabilities.js';

export default async function handler(req, res) {
  // =========================================================================
  // CONFIGURACIÓN DE INFRAESTRUCTURA POR CLIENTE (Marca Blanca / Single-Tenant)
  // -------------------------------------------------------------------------
  // Cada cliente tiene SU PROPIA instancia (Vercel + Supabase + Mercado Pago).
  // Las credenciales se inyectan EXCLUSIVAMENTE vía variables de entorno
  // (process.env.X) definidas en el proyecto Vercel de cada cliente.
  // NO hay valores por defecto: si falta una credencial vital, el guard
  // fail-fast abajo aborta la inicialización (aislamiento estricto de tenants).
  // Variables obligatorias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  // MP_ACCESS_TOKEN, ORIGIN_URL, SUPABASE_STORAGE_BUCKET.
  // Opcionales: ADMIN_TOKEN, GOOGLE_SCRIPT_URL, GEMINI_API_KEY.
  // =========================================================================
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY;
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

  // GUARD SINGLE-TENANT: Fail-Fast si faltan credenciales vitales
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MP_ACCESS_TOKEN || !process.env.ORIGIN_URL || !SUPABASE_STORAGE_BUCKET) {
      throw new Error("CRÍTICO: Variables de entorno incompletas. El tenant no puede inicializar por seguridad.");
  }
  // =========================================================================

  // FUNCIONES AUXILIARES
  const fetchSupabase = async (path, method = 'GET', body = null) => {
    const options = { method, headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' } };
    if (body) options.body = JSON.stringify(body);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
    if (!r.ok) { const err = await r.text(); throw new Error(`Error BD: ${err}`); }
    const text = await r.text(); return text ? JSON.parse(text) : {};
  };

  const uploadStorage = async (base64Str) => {
    try {
      const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, ""); 
      const buffer = Buffer.from(base64Data, 'base64'); 
      const fileName = `srv_${Date.now()}.webp`;
      const uploadReq = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${fileName}`, { 
        method: 'POST', 
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'image/webp' }, 
        body: buffer 
      });
      if(uploadReq.ok) return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${fileName}`; 
      return '';
    } catch(e) { return ''; }
  };

  const sendJSON = (data, code = 200) => res.status(code).json({ status: code < 400 ? 'success' : 'error', code, data });
  const sendAdmin = (success, data = null, error = null) => res.status(200).json({ success, data, error });

  // FIX QA 5: Monitor de caídas de Google Calendar
  const notificarGoogleScript = async (reservaData) => {
    try { 
        if (GOOGLE_SCRIPT_URL && GOOGLE_SCRIPT_URL.includes("script.google.com")) {
            const req = await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', body: JSON.stringify(reservaData) });
            return req.ok;
        }
        return false;
    } catch(e) { return false; }
  };

  // FASE 2: Sincronización con detección REAL de éxito.
  // El Apps Script responde HTTP 200 incluso en error; el éxito real solo se
  // detecta por json.success === true. No altera la semántica de la función
  // anterior (que se sigue usando en reservar / crear_reserva_admin).
  const moverGoogleEvento = async (payload) => {
    try {
        if (!GOOGLE_SCRIPT_URL || !GOOGLE_SCRIPT_URL.includes("script.google.com")) return { ok: false };
        const req = await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
        const json = await req.json().catch(() => null);
        return { ok: !!(json && json.success === true) };
    } catch(e) { return { ok: false }; }
  };

  // =========================================================================
  // CRM · IDENTIDAD DE TELÉFONO
  // -------------------------------------------------------------------------
  // La identidad de un teléfono son SUS DÍGITOS. '+', espacios, guiones,
  // paréntesis y cualquier otro carácter de presentación se ignoran, de modo
  // que "+54 9 11 5555-1234", "5491155551234" y "54 9 11 5555 1234" son el
  // MISMO teléfono. No hay regla de país, ni prefijo, ni código de área, ni
  // conversión: es normalización puramente sintáctica.
  //
  // Es la MISMA transformación que el frontend ya aplicaba para armar el
  // enlace de WhatsApp; ahora también es la clave de identidad contra la base.
  //
  // Sin dígitos (null, '', 'abc', 'v') NO hay teléfono: ese cliente no tiene
  // identidad por número, no participa de la unicidad y puede repetirse.
  const soloDigitos = (valor) => String(valor == null ? '' : valor).replace(/\D/g, '');

  // Nombre del índice UNIQUE parcial que impose la identidad. El backend lo
  // cita TEXTUALMENTE para distinguir una violación de este índice de
  // cualquier otro error de BD: solo esa se traduce a un mensaje de negocio.
  const CRM_INDICE_TELEFONO = 'idx_clientes_telefono_digitos_uniq';
  const CRM_MSG_TELEFONO_DUPLICADO = 'Este teléfono ya está registrado en otro cliente.';

  // PostgREST reporta la violación de unicidad como
  // { code:"23505", message:"duplicate key value violates unique constraint
  // \"<índice>\"" } dentro del cuerpo de error que fetchSupabase envuelve.
  // Un 23505 de OTRO índice NO es un teléfono duplicado.
  const esColisionTelefonoCRM = (e) => {
    try {
      const crudo = String((e && e.message) || e || '').replace(/^Error BD:\s*/, '');
      const parsed = JSON.parse(crudo);
      return !!parsed
        && String(parsed.code) === '23505'
        && String(parsed.message || '').includes(CRM_INDICE_TELEFONO);
    } catch (_) { return false; }
  };

  // Lookup por identidad normalizada. Única puerta de entrada para resolver un
  // teléfono contra `clientes`, tanto desde el alta/edición manual como desde
  // el alta automática de reservas: las tres caminos hablan el mismo idioma.
  const buscarClientePorTelefonoCRM = async (telefono) => {
    const digitos = soloDigitos(telefono);
    if (!digitos) return null;
    const r = await fetchSupabase('rpc/crm_buscar_cliente_por_telefono', 'POST', { p_telefono: digitos });
    if (!r) return null;
    // Una RPC que devuelve un escalar uuid responde con el valor JSON directo
    // ("a0e...") y no con un array; se aceptan las dos formas para no depender
    // de ese detalle de serialización.
    if (Array.isArray(r)) return r.length > 0 ? r[0] : null;
    return String(r);
  };

  const registrarClienteCRM = async (nombre, telefono, email) => {
    const digitos = soloDigitos(telefono);
    try {
      if (digitos) {
        const idExistente = await buscarClientePorTelefonoCRM(digitos);
        if (idExistente) return idExistente;
      } else {
        // Sin dígitos NO hay identidad de teléfono, pero el histórico puede
        // contener fichas guardadas con '' o con letras. Ahí se conserva el
        // lookup exacto preexistente para no cambiar ese comportamiento: las
        // filas con letras no participan de la unicidad y no se tocan.
        const exist = await fetchSupabase(`clientes?telefono=eq.${encodeURIComponent(telefono == null ? '' : telefono)}&select=id_cliente`);
        if (exist && exist.length > 0) return exist[0].id_cliente;
      }
      const nuevo = await fetchSupabase('clientes', 'POST', { nombre, telefono, email });
      if (nuevo && nuevo.length > 0) return nuevo[0].id_cliente; return null;
    } catch (e) {
      // Carrera resuelta: otra request insertó el mismo teléfono entre el
      // lookup y el INSERT. El UNIQUE es la autoridad final y se traduce en
      // una RESOLUCIÓN (volver a buscar el id ya creado), nunca en un error.
      // Cualquier otro error de BD mantiene el comportamiento seguro actual.
      if (digitos && esColisionTelefonoCRM(e)) {
        try { return await buscarClientePorTelefonoCRM(digitos); } catch (_) { return null; }
      }
      return null;
    }
  };

  // ==========================================================================
  // GASTOS / CATEGORÍAS · IDENTIDAD POR NOMBRE NORMALIZADO
  // ==========================================================================
  // La unicidad de `categorias_gastos.nombre` NO vive en el tipo de la columna:
  // vive en un índice UNIQUE de expresión sobre `lower(trim(nombre))`
  // (sql/categorias_gastos_nombre_unico.sql). "Alquiler", "alquiler" y
  // " Alquiler " son la MISMA categoría.
  //
  // El nombre se guarda con trim() conservando las mayúsculas que eligió el
  // usuario: la capitalización es una decisión de quien crea la categoría y no
  // participa de la identidad.
  //
  // Estas constantes citan TEXTUALMENTE el índice para poder distinguir una
  // violación de este índice de cualquier otro error de BD: solo esa se traduce
  // a un mensaje de negocio.
  const GASTOS_INDICE_CATEGORIA_NOMBRE = 'idx_categorias_gastos_nombre_normalizado_uniq';
  const GASTOS_MSG_CATEGORIA_DUPLICADA = 'Ya existe una categoría con ese nombre.';

  // MISMA transformación que el índice, escrita en JS. Si una de las dos
  // cambiaran, el precheck y el 23505 dejarían de hablar el mismo idioma: el
  // índice rechazaría nombres que el backend creía distintos.
  const claveNombreCategoriaGasto = (valor) => String(valor == null ? '' : valor).trim().toLowerCase();

  const esColisionNombreCategoriaGasto = (e) => {
    try {
      const crudo = String((e && e.message) || e || '').replace(/^Error BD:\s*/, '');
      const parsed = JSON.parse(crudo);
      return !!parsed
        && String(parsed.code) === '23505'
        && String(parsed.message || '').includes(GASTOS_INDICE_CATEGORIA_NOMBRE);
    } catch (_) { return false; }
  };

  // Nivel 3: Coincidencia EXACTA de servicios por profesional.
  // Null, vacío o 'TODOS' => habilitado para todo. Si es CSV, se normaliza
  // (split + trim) y se valida con includes sobre el ARRAY (no sobre el string).
  const esProfCalificado = (asignados, servicio) => {
    // Normalizamos lo que viene de la BD para evitar fallos por 'todos', 'Todos' o espacios extra
    const asignadosNorm = (asignados || '').toString().trim().toUpperCase();
    if (!asignadosNorm || asignadosNorm === 'TODOS') return true;
    
    // Normalizamos el servicio que se está buscando
    const servicioNorm = String(servicio).trim().toUpperCase();
    
    // Mantenemos la lógica de MATCH EXACTO de elementos, pero normalizando el case
    const lista = Array.isArray(asignados) ? asignados : String(asignados).split(',');
    return lista.map(s => String(s).trim().toUpperCase()).includes(servicioNorm);
  };

  // =======================================================================
  // WP-020-3: VALIDACIÓN UNIFICADA DE FECHA
  // -----------------------------------------------------------------------
  // Fuente única de verdad para "esta fecha se puede reservar". Antes vivía
  // solo dentro del endpoint de disponibilidad y los endpoints de escritura
  // (reservar / crear_reserva_admin) la omitían: un POST directo alcanzaba
  // para agendar en un día cerrado o en una fecha ya pasada.
  // Se apoya en la zona horaria de la marca (no en la del servidor Vercel,
  // que es UTC) para que "hoy" sea el día del negocio, no el del infra.
  // =======================================================================
  const ZONA_HORARIA_FALLBACK = "America/Argentina/Buenos_Aires";

  // Fecha de "hoy" (YYYY-MM-DD) según la zona horaria de la marca.
  const fechaHoyEnZona = (zonaTZ) => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: zonaTZ || ZONA_HORARIA_FALLBACK }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Valida que la fecha (a) tenga formato ISO, (b) no esté en el pasado y
  // (c) caiga en un día laborable según configuracion_marca.dias_laborables.
  // Mismo criterio que usa la disponibilidad: getDay() con 0=Dom ... 6=Sáb.
  const esFechaLaborableValida = (fechaStr, marca) => {
    const fecha = String(fechaStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
    if (isNaN(new Date(`${fecha}T12:00:00`).getTime())) return false;

    const cfg = marca || {};
    const hoy = fechaHoyEnZona(cfg.zona_horaria);
    if (fecha < hoy) return false;

    const dias = Array.isArray(cfg.dias_laborables) && cfg.dias_laborables.length > 0
      ? cfg.dias_laborables.map(Number)
      : [1, 2, 3, 4, 5, 6];
    return dias.includes(new Date(`${fecha}T12:00:00`).getDay());
  };

  // Config de marca mínima para validar la fecha. Fail-safe: si la tabla no
  // responde se devuelve {} y esFechaLaborableValida aplica los defaults
  // (zona BA + Lun-Sáb) en lugar de dejar la agenda abierta sin control.
  const obtenerMarcaParaValidarFecha = async () => {
    const cfg = await fetchSupabase('configuracion_marca?select=zona_horaria,dias_laborables').catch(() => null);
    return (cfg && cfg.length > 0) ? cfg[0] : {};
  };

  // CONTROLADOR PRINCIPAL
  try {
    
    if (req.method === 'GET') {
      const accion = req.query.accion || req.query.action || "";

      if (accion === 'obtener_marca') {
        try {
            const conf = await fetchSupabase('configuracion_marca?select=*');
            return sendAdmin(true, conf.length > 0 ? conf[0] : null);
        } catch (e) {
            return sendAdmin(false, null, "Tabla de marca no configurada");
        }
      }

      if (accion === 'obtener_instance_context') {
        if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
        try {
            const ctx = await loadInstanceContext(fetchSupabase);
            return sendAdmin(true, ctx);
        } catch (e) {
            return sendAdmin(false, null, e.message || 'No se pudo cargar instance context');
        }
      }

      if (accion === 'analizar_ia') {
        if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');

        const reservas = await fetchSupabase('reservas?estado_turno=neq.Cancelada&eliminado_logico=is.false&select=fecha_turno,estado_turno,servicios(nombre,precio)');
        const conteo = {};
        let facturacionTotal = 0;

        reservas.forEach(r => {
           const nombre = r.servicios?.nombre || 'Desconocido';
           const precio = parseFloat(r.servicios?.precio || 0);
           conteo[nombre] = (conteo[nombre] || 0) + 1;
           facturacionTotal += precio;
        });

        const dataModelada = { total_reservas_activas: reservas.length, facturacion_estimada_ars: facturacionTotal, demanda_por_servicio: conteo };

        const promptText = `Eres el Director de Operaciones (COO) de un centro de estética premium. Analiza esta data: ${JSON.stringify(dataModelada)}. 
        Redacta exactamente 3 consejos accionables para el dueño.
        Reglas estrictas de formato:
        1. Escribe cada consejo separado únicamente por los caracteres "|||". 
        2. No uses introducciones, saludos ni numeraciones (ni 1., 2., 3.).
        3. Para resaltar una métrica o concepto clave usa doble asterisco (ejemplo: **aumentar 20%**).
        4. Hazlo breve, directo y enfocado en generar dinero o retener clientes.`;

        const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        const aiReq = await fetch(urlGemini, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }) });
        const aiRes = await aiReq.json();

        if (aiRes.error) return sendAdmin(false, null, `Error de Google AI: ${aiRes.error.message}`);
        if (!aiRes.candidates || !aiRes.candidates[0]?.content?.parts?.[0]?.text) return sendAdmin(false, null, 'La IA no devolvió contenido válido.');

        const respuesta = aiRes.candidates[0].content.parts[0].text;
        return sendAdmin(true, { insights: respuesta });
      }

      if (accion === 'validar_cupon') {
        const codigo = req.query.codigo;
        if (!codigo) return sendJSON({ mensaje: "Código vacío" }, 400);

        const cupones = await fetchSupabase(`cupones?codigo=eq.${codigo}&estado=eq.Activo&select=*`);
        if (!cupones || cupones.length === 0) return sendJSON({ mensaje: "Cupón inválido o inactivo" }, 400);
        
        const cupon = cupones[0];
        if (cupon.fecha_vencimiento) {
            const hoy = new Date().toISOString().split('T')[0];
            if (hoy > cupon.fecha_vencimiento) return sendJSON({ mensaje: "El cupón ha expirado" }, 400);
        }

        return sendJSON({ codigo: cupon.codigo, porcentaje: cupon.descuento_porcentaje });
      }

      if (accion === 'servicios') { 
        const data = await fetchSupabase('servicios?estado=eq.Activo&select=*'); 
        const categorias = {}; let total = 0; 
        data.forEach(s => { 
          const cat = s.categoria || 'Otros'; 
          if (!categorias[cat]) categorias[cat] = []; 
          categorias[cat].push({ id_servicio: s.id, nombre: s.nombre, precio: s.precio, duracion_minutos: s.duracion_minutos, url_imagen: s.url_imagen }); 
          total++; 
        }); 
        return sendJSON({ categorias, total }); 
      }
      
      if (accion === 'profesionales') { 
        const data = await fetchSupabase('profesionales?estado=eq.Activo&select=*'); 
        return sendJSON({ profesionales: data.map(p => ({ id_profesional: p.id, nombre: p.nombre, servicios: p.servicios_asignados || 'TODOS' })) }); 
      }

      if (!accion && req.query.servicio) {
        const { servicio, fecha, profesional } = req.query; 
        const s = await fetchSupabase(`servicios?id=eq.${servicio}&select=duracion_minutos`); 
        if (!s.length) return sendJSON({ mensaje: "Servicio no válido" }, 400); 
        const duracion = s[0].duracion_minutos || 30;

        let profsQuery = 'profesionales?estado=eq.Activo&select=id,servicios_asignados'; 
        if (profesional) profsQuery += `&id=eq.${profesional}`;
        const allProfs = await fetchSupabase(profsQuery); 
        const profsCalificados = allProfs.filter(p => esProfCalificado(p.servicios_asignados, servicio)); 
        if (profsCalificados.length === 0) return sendJSON({ disponibles: [], fecha });

        const profIds = profsCalificados.map(p => p.id); 
        
        const reservas = await fetchSupabase(`reservas?fecha_turno=eq.${fecha}&eliminado_logico=is.false&estado_turno=neq.Cancelada&select=id_profesional,hora_turno,estado_turno,estado_pago,fecha_creacion,servicios(duracion_minutos)`);
        
        const parseT = (t) => { const [h,m] = t.split(':'); return parseInt(h)*60 + parseInt(m); }; 
        const formT = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

        const agendasStaff = {}; profIds.forEach(id => agendasStaff[id] = []); 
        const ahora = new Date();
        
        reservas.forEach(r => { 
          if (r.estado_pago === 'Pendiente (MP)' && r.fecha_creacion) {
              const creado = new Date(r.fecha_creacion);
              const minutosPasados = (ahora - creado) / 60000;
              if (minutosPasados > 15) return; 
          }

          if (agendasStaff[r.id_profesional]) { 
            const start = parseT(r.hora_turno); 
            const dur = (r.servicios && r.servicios.duracion_minutos) ? r.servicios.duracion_minutos : 30; 
            agendasStaff[r.id_profesional].push({ start, end: start + dur }); 
          } 
        });

        // MARCA BLANCA: horarios, días y zona horaria desde configuracion_marca.
        // Fallback seguro con la conducta actual (09:00-19:00, Lun-Sáb, BA) si no hay config.
        const cfgMarcaSlots = await fetchSupabase('configuracion_marca?select=zona_horaria,hora_apertura,hora_cierre,dias_laborables');
        const marcaSlots = (cfgMarcaSlots && cfgMarcaSlots.length > 0) ? cfgMarcaSlots[0] : {};
        const zonaTZ = marcaSlots.zona_horaria || "America/Argentina/Buenos_Aires";
        const aperturaParts = (marcaSlots.hora_apertura ? String(marcaSlots.hora_apertura).slice(0,5).split(':') : ['09','00']).map(Number);
        const cierreParts = (marcaSlots.hora_cierre ? String(marcaSlots.hora_cierre).slice(0,5).split(':') : ['19','00']).map(Number);
        const aperturaMin = (aperturaParts[0] || 9) * 60 + (aperturaParts[1] || 0);
        const cierreMin = (cierreParts[0] || 19) * 60 + (cierreParts[1] || 0);
        let diasLaborablesMarca = Array.isArray(marcaSlots.dias_laborables) ? marcaSlots.dias_laborables.map(Number) : [1,2,3,4,5,6];

        const slotsLibres = []; let cursor = aperturaMin; const finJornada = cierreMin; 
        const BA_TIME = new Date(new Date().toLocaleString("en-US", {timeZone: zonaTZ})); 
        const hoy = fechaHoyEnZona(zonaTZ); 
        const nowMinutos = BA_TIME.getHours() * 60 + BA_TIME.getMinutes(); 
        const diaSemana = new Date(fecha + "T12:00:00").getDay();
        const diaLaborable = diasLaborablesMarca.includes(diaSemana);

        while (cursor + duracion <= finJornada) {
          if (!(fecha === hoy && cursor <= nowMinutos) && diaLaborable) {
            let hayAlguienLibre = false;
            for (const pid of profIds) { 
              if (!agendasStaff[pid].some(o => cursor < o.end && (cursor + duracion) > o.start)) { hayAlguienLibre = true; break; } 
            }
            if (hayAlguienLibre) slotsLibres.push(formT(cursor));
          }
          cursor += 30;
        }
        return sendJSON({ disponibles: slotsLibres, fecha });
      }

      if (accion === 'list-servicios') { if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado'); const s = await fetchSupabase('servicios?order=categoria.asc&select=*'); return sendAdmin(true, { servicios: s.map(x => ({ id_servicio: x.id, categoria: x.categoria || 'Otros', nombre: x.nombre, precio: x.precio, duracion_minutos: x.duracion_minutos, estado: x.estado, url_imagen: x.url_imagen })) }); }
      if (accion === 'list-profesionales') { if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado'); const p = await fetchSupabase('profesionales?order=nombre.asc&select=*'); return sendAdmin(true, { profesionales: p.map(x => ({ id_profesional: x.id, nombre: x.nombre, servicios: x.servicios_asignados || 'TODOS', calendar_id: x.calendar_id, estado: x.estado, url_imagen: x.url_imagen || null })) }); }
      
      // FIX QA 5: Inyectamos sync_calendar a la lista que ve la recepcionista
      if (accion === 'list-agenda') { 
          if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado'); 

          // RF-03 · KANBAN: con ?fecha=YYYY-MM-DD el payload se acota a ese día y se
          // adjunta `lineas` (reserva_lineas) para poder dibujar un bloque visual por
          // profesional. SIN `fecha` la consulta y el payload son idénticos a los
          // previos: la vista de lista, el dashboard y los consumidores actuales no
          // cambian. Solo en el camino con `fecha` se lee `id` de reservas, y ese UUID
          // se usa exclusivamente para unir contra reserva_lineas: nunca sale al
          // frontend, que sigue hablando con id_reserva_interno.
          const fechaPedida = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '').trim())
              ? String(req.query.fecha).trim()
              : null;
          const campos = 'id_reserva_interno,fecha_turno,hora_turno,cliente,telefono,email,estado_turno,estado_pago,sync_calendar,ingreso_real,monto_cobrado,id_profesional,eliminado_logico,servicios(nombre,duracion_minutos),profesionales(nombre)';
          const selectAgenda = (fechaPedida ? 'id,' + campos : campos);
          const filtroFecha = fechaPedida ? `&fecha_turno=eq.${encodeURIComponent(fechaPedida)}` : '';
          const reservas = await fetchSupabase(`reservas?order=fecha_turno.desc&select=${selectAgenda}${filtroFecha}`); 
          if (!Array.isArray(reservas)) return sendAdmin(true, []);

          // Composición del día. FAIL-CLOSED: si reserva_lineas no se puede leer NO se
          // degrada a legacy. Un RF-03 dibujado desde la cabecera se mostraría con la
          // duración y el profesional de la LÍNEA 1 solamente, que es justo la
          // representación incompleta que este camino existe para evitar. Ante error se
          // aborta antes de armar la respuesta, igual que en reasignar_reserva.
          let lineasPorReserva = {};
          if (fechaPedida && reservas.length > 0) {
              const idsReserva = reservas.map(r => r.id).filter(Boolean);
              let lineasDia = [];
              if (idsReserva.length > 0) {
                  try {
                      lineasDia = await fetchSupabase(`reserva_lineas?id_reserva=in.(${idsReserva.join(',')})&select=id_reserva,orden,id_servicio,id_profesional,duracion_snapshot,precio_snapshot&order=orden.asc`);
                  } catch (e) {
                      console.error('[list-agenda] no se pudo leer reserva_lineas:', e && e.message ? e.message : e);
                      return sendAdmin(false, null, 'No se pudo verificar la composición de los turnos del día. Reintentá en unos segundos.');
                  }
              }
              if (!Array.isArray(lineasDia)) {
                  console.error('[list-agenda] reserva_lineas devolvió un formato inesperado.');
                  return sendAdmin(false, null, 'No se pudo verificar la composición de los turnos del día. Reintentá en unos segundos.');
              }
              for (const l of lineasDia) {
                  const clave = String(l.id_reserva);
                  if (!lineasPorReserva[clave]) lineasPorReserva[clave] = [];
                  // duracion_snapshot y precio_snapshot viajan TAL CUAL: son la
                  // autoridad histórica RF-03. El frontend no los recalcula desde el
                  // catálogo en ningún punto.
                  lineasPorReserva[clave].push({
                      orden: l.orden,
                      id_servicio: l.id_servicio,
                      id_profesional: l.id_profesional,
                      duracion_snapshot: l.duracion_snapshot,
                      precio_snapshot: l.precio_snapshot
                  });
              }
          }

          return sendAdmin(true, reservas.map(r => {
              const turno = { id_reserva: r.id_reserva_interno, fecha_turno: r.fecha_turno, hora_turno: r.hora_turno, cliente: r.cliente, telefono: r.telefono, email: r.email, servicio: (r.servicios?.nombre || 'Servicio') + " (" + (r.profesionales?.nombre || 'Local') + ")", estado_turno: r.estado_turno || 'Agendada', estado_pago: r.estado_pago, sync_calendar: r.sync_calendar, ingreso_real: r.ingreso_real ?? r.monto_cobrado ?? 0, id_profesional: r.id_profesional || null, profesional: r.profesionales?.nombre || 'Local', duracion: r.servicios?.duracion_minutos ?? 30, eliminado_logico: r.eliminado_logico === true };
              // `lineas` es aditivo y solo existe cuando se pidió una fecha. Un turno sin
              // líneas llega con [] y sigue siendo legacy; uno con líneas es RF-03.
              if (fechaPedida) turno.lineas = lineasPorReserva[String(r.id)] || [];
              return turno;
          })); 
      }
      
      if (accion === 'list-clientes') { if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado'); const clientes = await fetchSupabase('clientes?order=fecha_registro.desc&select=*'); return sendAdmin(true, clientes); }
      if (accion === 'list-cupones') { if (req.query.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado'); const c = await fetchSupabase('cupones?order=codigo.asc&select=*'); return sendAdmin(true, { cupones: c }); }
    } 

    else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; 
      const accion = body.accion || "";

      if (accion === 'reservar') {
        const { servicio, fecha, hora, cliente, email, telefono, tipo_pago, cupon } = body; 
        const s = (await fetchSupabase(`servicios?id=eq.${servicio}&select=*`))[0]; 
        if (!s) return res.status(400).json({ status: "error", data: { mensaje: "Servicio inválido" } });

        // WP-020-3: misma regla de fecha que aplica la disponibilidad. Se valida
        // antes de crear la preferencia de Mercado Pago y antes del chequeo de
        // solapamiento, para no dejar bookings ni cobros sobre una fecha cerrada.
        const marcaFecha = await obtenerMarcaParaValidarFecha();
        if (!esFechaLaborableValida(fecha, marcaFecha)) {
          return res.status(400).json({ success: false, status: "error", error: "La fecha solicitada es pasada o no es un día laborable.", data: { mensaje: "La fecha solicitada es pasada o no es un día laborable." } });
        }

        let monto = parseFloat(s.precio) || 0; 
        let descuentoAplicadoTexto = "";

        if (cupon) {
            const cupObj = await fetchSupabase(`cupones?codigo=eq.${cupon}&estado=eq.Activo&select=*`);
            if (cupObj && cupObj.length > 0) {
                const hoy = new Date().toISOString().split('T')[0];
                if (!cupObj[0].fecha_vencimiento || hoy <= cupObj[0].fecha_vencimiento) {
                    const porcentaje = cupObj[0].descuento_porcentaje;
                    const descuentoTotal = monto * (porcentaje / 100);
                    monto = monto - descuentoTotal;
                    descuentoAplicadoTexto = ` (Cupón: ${cupon} -${porcentaje}%)`;
                }
            }
        }

        if (tipo_pago === 'mp_sena' || tipo_pago === 'sena') {
            const cfgMarca = await fetchSupabase('configuracion_marca?select=porcentaje_sena');
            const pSena = (cfgMarca && cfgMarca.length > 0 && cfgMarca[0].porcentaje_sena) ? parseInt(cfgMarca[0].porcentaje_sena) : 25;
            monto = monto * (pSena / 100);
        } 
        monto = Math.round(monto);
        
        let finalProfId = body.profesional; let profName = "Local"; let calId = "primary";
        const parseT = (t) => { const [h,m] = t.split(':'); return parseInt(h)*60 + parseInt(m); }; 
        const requestedStart = parseT(hora); const requestedEnd = requestedStart + (s.duracion_minutos || 30); 
        const ahora = new Date(); 
        
        if (!finalProfId) {
          const profs = await fetchSupabase(`profesionales?estado=eq.Activo&select=*`); 
          const calificados = profs.filter(p => esProfCalificado(p.servicios_asignados, servicio)); 
          const overlaps = await fetchSupabase(`reservas?fecha_turno=eq.${fecha}&eliminado_logico=is.false&estado_turno=neq.Cancelada&select=id_profesional,hora_turno,estado_turno,estado_pago,fecha_creacion,servicios(duracion_minutos)`); 
          
          let proAsignado = null; 
          for (let p of calificados) { 
            const pRes = overlaps.filter(o => {
                if (o.id_profesional !== p.id) return false;
                if (o.estado_pago === 'Pendiente (MP)' && o.fecha_creacion) {
                    const creado = new Date(o.fecha_creacion);
                    if ((ahora - creado) / 60000 > 15) return false;
                }
                return true;
            }); 
            const ocupado = pRes.some(o => { const start = parseT(o.hora_turno); const end = start + (o.servicios?.duracion_minutos || 30); return requestedStart < end && requestedEnd > start; }); 
            if (!ocupado) { proAsignado = p; break; } 
          }
          if (!proAsignado) return res.status(400).json({ status: "error", data: { mensaje: "Horario ocupado" } }); 
          finalProfId = proAsignado.id; profName = proAsignado.nombre; calId = proAsignado.calendar_id;
        } else {
          const profObj = (await fetchSupabase(`profesionales?id=eq.${finalProfId}&select=*`))[0]; 
          if(profObj) { profName = profObj.nombre; calId = profObj.calendar_id; }
          
          const checkPRes = await fetchSupabase(`reservas?fecha_turno=eq.${fecha}&id_profesional=eq.${finalProfId}&eliminado_logico=is.false&estado_turno=neq.Cancelada&select=hora_turno,estado_turno,estado_pago,fecha_creacion,servicios(duracion_minutos)`);
          const ocupadoDobleCheck = checkPRes.some(o => { 
             if (o.estado_pago === 'Pendiente (MP)' && o.fecha_creacion) {
                 const creado = new Date(o.fecha_creacion);
                 if ((ahora - creado) / 60000 > 15) return false;
             }
             const start = parseT(o.hora_turno); const end = start + (o.servicios?.duracion_minutos || 30); return requestedStart < end && requestedEnd > start; 
          });
          if (ocupadoDobleCheck) return res.status(400).json({ status: "error", data: { mensaje: "Lo sentimos, el turno acaba de ser reservado por otra persona." } });
        }

        const idInterno = "RES-" + Date.now(); 
        const originUrl = req.headers.origin || process.env.ORIGIN_URL;
        let pagoUrl = ""; 
        
        let estadoDB = "Pendiente (MP)";
        if (tipo_pago === 'local') estadoDB = "Confirmado (Pago Local)";
        if (tipo_pago === 'transferencia') estadoDB = "Pendiente (Transfer)";

        if (monto <= 0) {
            monto = 0; 
            estadoDB = "Confirmado (Cupón 100%)";
        }

        if (monto > 0 && estadoDB === "Pendiente (MP)") {
          // ESCUDO MERCADO PAGO (Regla de Negocio): solo ARS genera preferencia.
          // La integración MP opera únicamente con cuentas de Argentina.
          const cfgMoneda = await fetchSupabase('configuracion_marca?select=moneda');
          const monedaMarca = (cfgMoneda && cfgMoneda.length > 0 && cfgMoneda[0].moneda) ? cfgMoneda[0].moneda : 'ARS';
          if (monedaMarca !== 'ARS') return res.status(400).json({ status: "error", data: { mensaje: "Mercado Pago no disponible para esta moneda. Aboná en el estudio o por transferencia." } });
          const mpPayload = { 
              items: [{ 
                  title: `${s.nombre}${descuentoAplicadoTexto} - ${cliente}`, 
                  description: `Turno: ${fecha} a las ${hora}`, 
                  quantity: 1, 
                  currency_id: "ARS", 
                  unit_price: monto 
              }], 
              back_urls: { success: originUrl, failure: originUrl, pending: originUrl }, 
              auto_return: "approved", 
              external_reference: idInterno 
          }; 
          const mpReq = await fetch("https://api.mercadopago.com/checkout/preferences", { method: "POST", headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(mpPayload) }); 
          const mpRes = await mpReq.json(); pagoUrl = mpRes.init_point;
        }

        const idCrm = await registrarClienteCRM(cliente, telefono, email); 

        // CHEQUEO ATOMICO DE ÚLTIMA MILLA (Concurrencia/Nivel 2):
        // Justo antes del insert se revalida el solapamiento en Supabase para
        // abortar cualquier condición de carrera entre peticiones simultáneas.
        const ultimaMilla = await fetchSupabase(`reservas?fecha_turno=eq.${fecha}&id_profesional=eq.${finalProfId}&eliminado_logico=is.false&estado_turno=neq.Cancelada&select=hora_turno,estado_turno,estado_pago,servicios(duracion_minutos)`);
        const solapado = ultimaMilla.some(o => {
            const start = parseT(o.hora_turno);
            const end = start + (o.servicios?.duracion_minutos || 30);
            return requestedStart < end && requestedEnd > start;
        });
        if (solapado) return res.status(409).json({ status: "error", data: { mensaje: "Lo sentimos, este turno acaba de ser reservado por otro usuario. Por favor, elige otro horario." } });

        await fetchSupabase('reservas', 'POST', { id_reserva_interno: idInterno, fecha_turno: fecha, hora_turno: hora, cliente, telefono, email, id_servicio: s.id, id_profesional: finalProfId, monto_cobrado: monto, estado_turno: 'Agendada', estado_pago: estadoDB, id_cliente_crm: idCrm });
        
        // FIX QA 5: Fallback asíncrono para Google Calendar
        notificarGoogleScript({ accion: "notificar_reserva", fecha, hora, duracion: s.duracion_minutos || 30, calendar_id: calId, servicio: `${s.nombre}${descuentoAplicadoTexto}`, cliente, email, telefono, nombreProfesional: profName, id_reserva_interno: idInterno })
        .then(async (success) => {
            if(!success) await fetchSupabase(`reservas?id_reserva_interno=eq.${idInterno}`, 'PATCH', { sync_calendar: false });
        });
        
        if (estadoDB === "Confirmado (Pago Local)" || estadoDB === "Pendiente (Transfer)" || estadoDB === "Confirmado (Cupón 100%)") {
            return sendJSON({ mensaje: "Turno reservado", pago_url: "success_local" });
        } else {
            return sendJSON({ mensaje: "Redirigiendo...", pago_url: pagoUrl });
        }
      }

      if (accion === 'enviar_mensaje') {
          const { chat_id, remitente, mensaje } = body;
          if (!chat_id || !remitente || !mensaje) return sendJSON({ mensaje: "Faltan datos del mensaje" }, 400);
          if (!['cliente', 'admin'].includes(remitente)) return sendJSON({ mensaje: "Remitente inválido" }, 400);
          const nuevoMsg = await fetchSupabase('mensajes', 'POST', { chat_id, remitente, mensaje });
          return sendJSON({ success: true, data: nuevoMsg });
      }

      if (accion === 'obtener_mensajes') {
          const { chat_id, desde } = body;
          if (!chat_id) return sendJSON({ mensaje: "Falta chat_id" }, 400);
          let query = `mensajes?chat_id=eq.${chat_id}&select=*&order=created_at.asc`;
          if (desde) query += `&created_at=gt.${desde}`;
          const mensajes = await fetchSupabase(query);
          return sendJSON({ success: true, mensajes });
      }

      if (accion === 'vincular_chat') {
          if (!body.chat_id || !body.alias) return sendJSON({ success: false });
          await fetchSupabase(`mensajes?chat_id=eq.${body.chat_id}`, 'PATCH', { alias_cliente: body.alias });
          return sendJSON({ success: true });
      }

      if (accion === 'login') return (body.password === process.env.ADMIN_PASSWORD) ? sendAdmin(true, { token: ADMIN_TOKEN }) : sendAdmin(false, null, "Clave incorrecta."); 
      if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');

      if (accion === 'marcar_leidos') {
          const { chat_id, remitente } = body;
          if (!chat_id || !remitente) return sendJSON({ mensaje: "Faltan datos" }, 400);
          await fetchSupabase(`mensajes?chat_id=eq.${chat_id}&remitente=eq.${remitente}&leido=eq.false`, 'PATCH', { leido: true });
          return sendJSON({ success: true });
      }

      if (accion === 'chats_activos') {
          const mensajes = await fetchSupabase('mensajes?select=chat_id,created_at,alias_cliente&order=created_at.desc');
          const chatsUnicos = {};
          mensajes.forEach(m => { if (!chatsUnicos[m.chat_id]) chatsUnicos[m.chat_id] = m.created_at; });
          return sendAdmin(true, { chats: Object.entries(chatsUnicos).map(([id, ultimo]) => ({ chat_id: id, ultimo_mensaje: ultimo })) });
      }

      if (accion === 'eliminar_chat') {
          if (!body.chat_id) return sendAdmin(false, null, 'Falta chat_id');
          await fetchSupabase(`mensajes?chat_id=eq.${body.chat_id}`, 'DELETE');
          return sendJSON({ success: true });
      }

      if (accion === 'guardar_marca') {
          let payloadConfig = { color_acento: body.color_acento, color_fondo: body.color_fondo, color_tarjetas: body.color_tarjetas, color_texto: body.color_texto, color_secundario: body.color_secundario, color_texto_secundario: body.color_texto_secundario, color_fondo_campos: body.color_fondo_campos, color_precios: body.color_precios, porcentaje_sena: parseInt(body.porcentaje_sena) || 25, mp_total_activo: body.mp_total_activo === true || body.mp_total_activo === 'true', mp_sena_activo: body.mp_sena_activo === true || body.mp_sena_activo === 'true', pago_local_activo: body.pago_local_activo, mp_activo: body.mp_activo, transferencia_activa: body.transferencia_activa, datos_transferencia: body.datos_transferencia, moneda: body.moneda, zona_horaria: body.zona_horaria, hora_apertura: body.hora_apertura, hora_cierre: body.hora_cierre, dias_laborables: body.dias_laborables };
          if (body.logo_base64) payloadConfig.logo_url = await uploadStorage(body.logo_base64);
          if (body.isotipo_base64) payloadConfig.isotipo_url = await uploadStorage(body.isotipo_base64);
          if (body.logo_login_base64) payloadConfig.logo_login_url = await uploadStorage(body.logo_login_base64);
          if (body.icono_acceso_base64) payloadConfig.icono_acceso_url = await uploadStorage(body.icono_acceso_base64);
          const exist = await fetchSupabase('configuracion_marca?select=id');
          if (exist && exist.length > 0) { await fetchSupabase(`configuracion_marca?id=eq.${exist[0].id}`, 'PATCH', payloadConfig); } else { await fetchSupabase('configuracion_marca', 'POST', payloadConfig); }
          return sendAdmin(true);
      }

      if (accion === 'agregar_cupon') { await fetchSupabase('cupones', 'POST', { codigo: body.codigo.toUpperCase().trim(), descuento_porcentaje: body.porcentaje, fecha_vencimiento: body.vencimiento || null }); return sendAdmin(true); }
      if (accion === 'toggle_cupon') { const curr = await fetchSupabase(`cupones?codigo=eq.${body.codigo}&select=*`); await fetchSupabase(`cupones?codigo=eq.${body.codigo}`, 'PATCH', { estado: curr[0].estado === 'Activo' ? 'Inactivo' : 'Activo' }); return sendAdmin(true); }
      if (accion === 'editar_cupon') { await fetchSupabase(`cupones?codigo=eq.${body.codigo}`, 'PATCH', { descuento_porcentaje: body.porcentaje, fecha_vencimiento: body.vencimiento || null }); return sendAdmin(true); }
      
      // RF-03: alta manual de Admin. TODA reserva nueva nace RF-03, incluso con un
      // solo servicio (en ese caso, una sola reserva_linea). El flujo legacy
      // "crear -> promover -> actualizar" queda solo para compatibilizar históricos.
      //
      // La escritura es EXCLUSIVAMENTE la RPC crear_turno_admin_rf03: cabecera,
      // líneas, economía y validación de disponibilidad ocurren en la misma
      // transacción. Acá no se inserta nada en `reservas` ni en `reserva_lineas`.
      // El JS solo valida la FORMA del payload para dar un error rápido y legible;
      // precio, duración, disponibilidad, jornada, cupón y saldo son de la RPC.
      if (accion === 'crear_reserva_admin') {
          const { fecha, hora, cliente, telefono } = body;
          const estado_pago = body.estado_pago || 'Confirmado (Pago Local)';
          const lineasPedidas = Array.isArray(body.lineas) ? body.lineas : [];

          if (!fecha || !hora) return sendAdmin(false, null, "Completá la fecha y la hora del turno");
          if (!cliente || !telefono) return sendAdmin(false, null, "Completá el cliente y el teléfono");
          if (lineasPedidas.length === 0) return sendAdmin(false, null, "El turno tiene que tener al menos un servicio");
          for (let i = 0; i < lineasPedidas.length; i++) {
              const l = lineasPedidas[i] || {};
              if (!l.id_servicio) return sendAdmin(false, null, `Elegí el servicio de la línea ${i + 1}`);
              if (!l.id_profesional) return sendAdmin(false, null, `Elegí el profesional de la línea ${i + 1}`);
          }

          // CRM antes de la RPC, igual que antes: la ficha del cliente queda creada
          // aunque después el turno sea rechazado por disponibilidad.
          const idCrm = await registrarClienteCRM(cliente, telefono, "-");

          let creado;
          try {
              // Solo ids. Los snapshots, la economía y el saldo los decide la RPC.
              creado = await fetchSupabase('rpc/crear_turno_admin_rf03', 'POST', {
                  p_fecha: fecha,
                  p_hora: hora,
                  p_cliente: cliente,
                  p_telefono: telefono,
                  p_email: "-",
                  p_estado_pago: estado_pago,
                  p_id_cliente_crm: idCrm || null,
                  p_lineas: lineasPedidas.map(l => ({
                      id_servicio: l.id_servicio,
                      id_profesional: l.id_profesional
                  }))
              });
          } catch (e) {
              // fetchSupabase envuelve el fallo como "Error BD: <cuerpo>" y PostgREST
              // responde JSON { code, message, details, hint }. Se expone solo el
              // `message`: nunca el stack ni credenciales.
              const crudo = String((e && e.message) || e || '').replace(/^Error BD:\s*/, '');
              let mensaje = 'No se pudo crear el turno';
              try {
                  const parseado = JSON.parse(crudo);
                  if (parseado && parseado.message) mensaje = String(parseado.message);
              } catch (_) {
                  if (crudo) mensaje = crudo.slice(0, 300);
              }
              return sendAdmin(false, null, mensaje);
          }

          if (!creado || !creado.id_reserva_interno) {
              return sendAdmin(false, null, 'No se pudo crear el turno');
          }

          // Calendar: UN evento por turno, con la duración TOTAL de la composición.
          // La RPC ya resolvió el calendar_id (el del único profesional, o "primary"
          // si la composición reparte entre dos o más). La descripción lleva la
          // composición ordenada completa para que el evento sea legible.
          const compCreada = Array.isArray(creado.composicion) ? creado.composicion : [];
          const duracionTotal = parseInt(creado.duracion_total_min, 10) || 30;
          const calId = creado.calendar_id_evento || 'primary';
          const nombreProfEvento = creado.nombre_profesional_evento || 'Local';
          const descripcionComp = compCreada
              .map((l, i) => `${i + 1}. ${l.nombre_servicio} · ${l.nombre_profesional} (${l.duracion_snapshot} min)`)
              .join(' | ');
          const idInternoAdm = creado.id_reserva_interno;

          // FIX QA 5: Fallback asíncrono también desde el Admin. Un solo PATCH
          // porque sync_calendar es una columna de la reserva, no de la línea.
          notificarGoogleScript({ accion: "notificar_reserva", fecha: fecha, hora: hora, duracion: duracionTotal, calendar_id: calId, servicio: descripcionComp, cliente: cliente, email: "-", telefono: telefono, nombreProfesional: nombreProfEvento, id_reserva_interno: idInternoAdm })
          .then(async (success) => {
              if(!success) await fetchSupabase(`reservas?id_reserva_interno=eq.${encodeURIComponent(idInternoAdm)}`, 'PATCH', { sync_calendar: false });
          });

          // Se devuelve la RPC completa: el frontend muestra los valores reales
          // persistidos (composición, duración total, economía y saldo).
          return sendAdmin(true, creado);
      }
      
      if (accion === 'guardar_nota_cliente') { await fetchSupabase(`clientes?id_cliente=eq.${body.id_cliente}`, 'PATCH', { notas_clinicas: body.notas }); return sendAdmin(true); }

      // -----------------------------------------------------------------------
      // CRM · ALTA Y EDICIÓN MANUAL DE CLIENTES
      // -----------------------------------------------------------------------
      // Aditivo: no cambia `list-clientes` ni `guardar_nota_cliente` (las notas
      // siguen siendo cosa exclusiva de la FICHA). No toca `reservas`: editar
      // un cliente NO reescribe reservas históricas.
      //
      // Reglas compartidas por los dos caminos:
      //   · nombre  → obligatorio, con trim.
      //   · teléfono→ opcional. Vacío se guarda NULL (cliente sin teléfono, que
      //               NO participa de la unicidad). Informado pero con CERO
      //               dígitos ("abc") se rechaza en altas y ediciones nuevas.
      //               Los históricos que ya tienen letras no se tocan ni se
      //               listan distinto: solo deja de ser válido informarlos de nuevo.
      //   · email   → opcional. Vacío se guarda NULL. Si viene, mismo formato que
      //               el resto del backend.
      //   · el nombre NUNCA se usa como clave: se permiten nombres repetidos.
      //   · un teléfono informado pertenece a un solo cliente, por dígitos.
      const validarDatosClienteCRM = (body, opciones = {}) => {
          const nombre = String(body.nombre == null ? '' : body.nombre).trim();
          const telefono = String(body.telefono == null ? '' : body.telefono).trim();
          const email = String(body.email == null ? '' : body.email).trim();
          if (!nombre) return { ok: false, error: 'El nombre del cliente no puede quedar vacío' };
          // Un teléfono no vacío con CERO dígitos se rechaza siempre, con una sola
          // excepción: que sea el MISMO valor histórico ya almacenado ("v", "G",
          // "S", "g", "J"...). Ahí el usuario no está informando un teléfono
          // nuevo, está reenviando el registro tal como está porque el formulario
          // precarga el valor crudo. Sin esta excepción no se podría cambiar el
          // nombre o el email de un cliente legacy sin tocarle el teléfono.
          // En ALTA NUEVA `opciones` llega vacío y nada cambia: se sigue rechazando.
          if (telefono && !opciones.telefonoLegadoIntacto && !soloDigitos(telefono)) return { ok: false, error: 'Ingresá un teléfono válido o dejá el campo vacío.' };
          // Mismo criterio de formato que usa el resto del backend al editar un turno.
          // Única excepción: que sea el MISMO email histórico ya almacenado ("-"). El
          // alta automática de reservas llama registrarClienteCRM(cliente, telefono, "-"),
          // así que hay fichas con email "-" creadas por el propio sistema. Si el
          // usuario reenvía ese valor intacto, no está informando un email nuevo: es el
          // modal precargando el valor crudo. En ALTA NUEVA `opciones` llega vacío y
          // "-" sigue siendo rechazado: no se crean emails legacy desde el alta manual.
          if (email && !opciones.emailLegadoIntacto && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'El email del cliente no tiene un formato válido' };
          return { ok: true, nombre, telefono: telefono || null, email: email || null };
      };

      if (accion === 'agregar_cliente') {
          const v = validarDatosClienteCRM(body);
          if (!v.ok) return sendAdmin(false, null, v.error);
          try {
              if (v.telefono) {
                  const idExistente = await buscarClientePorTelefonoCRM(v.telefono);
                  if (idExistente) return sendAdmin(false, null, CRM_MSG_TELEFONO_DUPLICADO);
              }
              const nuevo = await fetchSupabase('clientes', 'POST', { nombre: v.nombre, telefono: v.telefono, email: v.email });
              if (!nuevo || !nuevo.length) return sendAdmin(false, null, 'No se pudo guardar el cliente');
              return sendAdmin(true, { id_cliente: nuevo[0].id_cliente });
          } catch (e) {
              // El UNIQUE parcial de dígitos es la autoridad final ante dos altas
              // concurrentes con el mismo teléfono. SOLO esa colisión se traduce
              // al mensaje de negocio; cualquier otro error de BD devuelve un
              // mensaje genérico y jamás su detalle crudo.
              if (v.telefono && esColisionTelefonoCRM(e)) return sendAdmin(false, null, CRM_MSG_TELEFONO_DUPLICADO);
              console.error('[agregar_cliente]', e && e.message ? e.message : e);
              return sendAdmin(false, null, 'No se pudo guardar el cliente');
          }
      }

      if (accion === 'editar_cliente') {
          const idCliente = String(body.id_cliente || '').trim();
          if (!idCliente) return sendAdmin(false, null, 'Falta identificar el cliente a editar');
          // id_cliente NO se interpola a ciegas: se valida como uuid ANTES de
          // tocar la query. Eso además hace seguro el filtro `eq.` (un uuid no
          // puede inyectar operadores de PostgREST) y evita que un id basura
          // produzca un error crudo de BD.
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idCliente)) return sendAdmin(false, null, 'El cliente a editar no es válido');
          let v = null;
          try {
              // (A) PRIMERO se resuelve el cliente existente. Sin el valor
              // almacenado no hay forma de distinguir "el usuario reenvió el
              // teléfono histórico tal cual" de "el usuario lo cambió por uno
              // sin dígitos": en los dos casos el POST llega con el mismo texto.
              const actual = await fetchSupabase(`clientes?id_cliente=eq.${idCliente}&select=id_cliente,telefono,email`);
              if (!actual || !actual.length) return sendAdmin(false, null, 'El cliente ya no existe en el directorio');
              const telAlmacenado = actual[0].telefono == null ? '' : String(actual[0].telefono);
              const telRecibido = String(body.telefono == null ? '' : body.telefono).trim();
              // (B) Comparación contra el almacenado:
              //   · idéntico al histórico y con cero dígitos -> se conserva (LEG-01/02)
              //   · vacío                                     -> NULL (LEG-03)
              //   · distinto y con cero dígitos               -> se rechaza (LEG-04)
              //   · con uno o más dígitos                      -> identidad normal (LEG-05)
              // El histórico NO se limpia ni se convierte en NULL: se reescribe
              // exactamente igual, y nada se toca fuera de esta edición explícita.
              const telLegadoIntacto = telRecibido !== ''
                  && telRecibido === telAlmacenado
                  && !soloDigitos(telRecibido);
              // Mismo criterio para el email, por el mismo motivo: existen fichas
              // con email "-" porque el alta automática de reservas guarda ese
              // valor. Si el usuario reenvía ese email intacto se conserva; si
              // escribe cualquier otro valor inválido, se rechaza.
              const emailAlmacenado = actual[0].email == null ? '' : String(actual[0].email);
              const emailRecibido = String(body.email == null ? '' : body.email).trim();
              const emailLegadoIntacto = emailRecibido !== ''
                  && emailRecibido === emailAlmacenado
                  && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRecibido);
              v = validarDatosClienteCRM(body, { telefonoLegadoIntacto: telLegadoIntacto, emailLegadoIntacto: emailLegadoIntacto });
              if (!v.ok) return sendAdmin(false, null, v.error);
              if (v.telefono) {
                  // Conservar el propio teléfono no es conflicto: solo se rechaza
                  // si el número ya está en el registro de OTRO cliente.
                  const idExistente = await buscarClientePorTelefonoCRM(v.telefono);
                  if (idExistente && String(idExistente) !== idCliente) return sendAdmin(false, null, CRM_MSG_TELEFONO_DUPLICADO);
              }
              // `telefono` es SIEMPRE el valor final: si vino vacío queda NULL
              // (quitar el teléfono) y si vino con cero dígitos pero es el valor
              // histórico almacenado se reescribe idéntico. El PATCH es explícito
              // y limitado a los tres campos de identidad: notas_clinicas y
              // fecha_registro no se tocan, y reservas no se tocan.
              //
              // El id ya viene validado como uuid, así que interpolarlo en el
              // filtro `eq.` es seguro. Y como fetchSupabase pide
              // return=representation, la respuesta ES la autoridad sobre si
              // la fila existió: 0 filas devueltas = cliente inexistente, y se
              // informa el error en vez de un "guardado" que no ocurrió.
              const updated = await fetchSupabase(`clientes?id_cliente=eq.${idCliente}`, 'PATCH', { nombre: v.nombre, telefono: v.telefono, email: v.email });
              if (!updated || !updated.length) return sendAdmin(false, null, 'El cliente ya no existe en el directorio');
              return sendAdmin(true, { id_cliente: idCliente });
          } catch (e) {
              if (v && v.telefono && esColisionTelefonoCRM(e)) return sendAdmin(false, null, CRM_MSG_TELEFONO_DUPLICADO);
              console.error('[editar_cliente]', e && e.message ? e.message : e);
              return sendAdmin(false, null, 'No se pudo guardar el cliente');
          }
      }
      if (accion === 'agregar_servicio') { let imgUrl = ''; if (body.imagen_base64) imgUrl = await uploadStorage(body.imagen_base64); await fetchSupabase('servicios', 'POST', { categoria: body.categoria || 'Otros', nombre: body.nombre, precio: body.precio, duracion_minutos: body.duracion, url_imagen: imgUrl }); return sendAdmin(true); }
      if (accion === 'editar_servicio') { let payloadUpdate = { nombre: body.nombre, categoria: body.categoria, precio: body.precio, duracion_minutos: body.duracion }; if (body.imagen_base64) { payloadUpdate.url_imagen = await uploadStorage(body.imagen_base64); } await fetchSupabase(`servicios?id=eq.${body.id}`, 'PATCH', payloadUpdate); return sendAdmin(true); }
      if (accion === 'toggle_servicio') { const curr = await fetchSupabase(`servicios?id=eq.${body.id}&select=*`); await fetchSupabase(`servicios?id=eq.${body.id}`, 'PATCH', { estado: curr[0].estado === 'Activo' ? 'Inactivo' : 'Activo' }); return sendAdmin(true); }
      if (accion === 'agregar_profesional') { let imgUrl = ''; if (body.imagen_base64) imgUrl = await uploadStorage(body.imagen_base64); await fetchSupabase('profesionales', 'POST', { nombre: body.nombre, calendar_id: body.calendar_id, servicios_asignados: body.servicios, url_imagen: imgUrl || null }); return sendAdmin(true); }
      if (accion === 'toggle_profesional') { const curr = await fetchSupabase(`profesionales?id=eq.${body.id}&select=*`); await fetchSupabase(`profesionales?id=eq.${body.id}`, 'PATCH', { estado: curr[0].estado === 'Activo' ? 'Inactivo' : 'Activo' }); return sendAdmin(true); }
      if (accion === 'editar_profesional') { let payloadUpdate = { nombre: body.nombre, calendar_id: body.calendar_id, servicios_asignados: body.servicios }; if (body.imagen_base64) { payloadUpdate.url_imagen = await uploadStorage(body.imagen_base64); } await fetchSupabase(`profesionales?id=eq.${body.id}`, 'PATCH', payloadUpdate); return sendAdmin(true); }
      if (accion === 'cancelar_reserva') { await fetchSupabase(`reservas?id_reserva_interno=eq.${body.id_reserva}`, 'PATCH', { estado_turno: 'Cancelada' }); return sendAdmin(true); }
      if (accion === 'eliminar_reserva_admin') { await fetchSupabase(`reservas?id_reserva_interno=eq.${body.id_reserva}`, 'PATCH', { eliminado_logico: true }); return sendAdmin(true); }
      if (accion === 'actualizar_asistencia') {
          const marcaAsistencia = String(body.estado_turno || body.estado || '').trim();
          let estadoTurnoAsistencia = null;
          if (/^completad[oa]/i.test(marcaAsistencia)) estadoTurnoAsistencia = 'Completada';
          else if (/^ausente/i.test(marcaAsistencia)) estadoTurnoAsistencia = 'Ausente';
          if (!estadoTurnoAsistencia) return sendAdmin(false, null, "Estado de asistencia inválido");
          const updPayload = { estado_turno: estadoTurnoAsistencia };
          if (body.ingreso_real !== undefined && body.ingreso_real !== null) updPayload.ingreso_real = parseFloat(body.ingreso_real) || 0;
          await fetchSupabase(`reservas?id_reserva_interno=eq.${body.id_reserva}`, 'PATCH', updPayload); return sendAdmin(true);
      }
      // RF-03: detección del modelo de datos de un turno. SOLO LECTURA: no escribe
      // nada. La decisión de promover NO se toma acá; la RPC promover_turno_rf03 es
      // la autoridad final y la que escribe de forma atómica.
      // OJO: en Admin, `id_reserva` significa SIEMPRE reservas.id_reserva_interno
      // (TEXT, tipo RES-xxxx / ADM-xxxx). Por eso el id UUID se devuelve aparte,
      // como `id_reserva_uuid`, y nunca se reemplaza la semántica de `id_reserva`.
      if (accion === 'detectar_turno_rf03') {
          const { id_reserva } = body;
          const idBusqueda = id_reserva == null ? '' : String(id_reserva).trim();
          if (!idBusqueda) return sendAdmin(false, null, 'Falta id de reserva');
          // El encode aplica solo al filtro HTTP/PostgREST; `idBusqueda` conserva el
          // valor original y se usa tal cual al llamar a la RPC.
          const idBusquedaEncoded = encodeURIComponent(idBusqueda);

          const reservas = await fetchSupabase(`reservas?id_reserva_interno=eq.${idBusquedaEncoded}&select=id,id_reserva_interno,id_servicio,id_profesional,estado_turno,estado_pago,monto_cobrado,ingreso_real,servicios(nombre,precio,duracion_minutos),profesionales(nombre)`);
          const reserva = Array.isArray(reservas) ? reservas[0] : null;
          if (!reserva) return sendAdmin(false, null, 'Reserva no encontrada');

          // RF-03 = existe al menos una línea. Un turno Bloqueada se devuelve normal:
          // la prohibición de promover la aplica la RPC, no esta detección.
          const lineas = await fetchSupabase(`reserva_lineas?id_reserva=eq.${reserva.id}&select=id`);
          const cantidadLineas = Array.isArray(lineas) ? lineas.length : 0;

          // precio_actual, duracion_actual, monto_cobrado e ingreso_real son
          // REFERENCIAS para mostrar en pantalla. NO son el precio histórico pactado
          // ni el pago real, y no se convierten en snapshots ni se infieren pagos.
          return sendAdmin(true, {
              promovido: cantidadLineas > 0,
              lineas: cantidadLineas,
              id_reserva: reserva.id_reserva_interno,
              id_reserva_uuid: reserva.id,
              id_reserva_interno: reserva.id_reserva_interno,
              id_servicio: reserva.id_servicio || null,
              id_profesional: reserva.id_profesional || null,
              estado_turno: reserva.estado_turno || 'Agendada',
              estado_pago: reserva.estado_pago || null,
              monto_cobrado: reserva.monto_cobrado,
              ingreso_real: reserva.ingreso_real,
              servicio: {
                  nombre: reserva.servicios?.nombre || 'Servicio',
                  precio_actual: reserva.servicios?.precio ?? null,
                  duracion_actual: reserva.servicios?.duracion_minutos ?? null
              },
              profesional: { nombre: reserva.profesionales?.nombre || 'Local' }
          });
      }

      // RF-03: promoción de un turno legacy al modelo de múltiples servicios.
      // TODA escritura ocurre dentro de la RPC (atómica e idempotente): acá no se
      // hace INSERT en reserva_lineas ni PATCH en reservas. Solo se valida la FORMA
      // básica de los datos; la lógica de negocio y las guardas (Bloqueada,
      // id_servicio/id_profesional nulos, cupón) son autoridad de la RPC.
      if (accion === 'promover_turno_rf03') {
          const { id_reserva, precio_base_pactado, duracion_pactada, total_pagado, cupon_codigo, cupon_porcentaje } = body;

          const idReserva = id_reserva == null ? '' : String(id_reserva).trim();
          if (!idReserva) return sendAdmin(false, null, 'Falta id de reserva');

          const aNumero = (v) => {
              if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
              if (typeof v === 'string' && v.trim() !== '') return Number(v);
              return NaN;
          };
          const precio = aNumero(precio_base_pactado);
          const duracion = aNumero(duracion_pactada);
          const pagado = aNumero(total_pagado);

          if (!Number.isFinite(precio) || precio < 0) return sendAdmin(false, null, 'El precio base pactado debe ser un número mayor o igual a 0');
          if (!Number.isFinite(duracion) || !Number.isInteger(duracion) || duracion <= 0) return sendAdmin(false, null, 'La duración pactada debe ser un entero mayor a 0');
          if (!Number.isFinite(pagado) || pagado < 0) return sendAdmin(false, null, 'El total pagado debe ser un número mayor o igual a 0');

          let codigo = cupon_codigo == null ? null : String(cupon_codigo).trim();
          if (codigo === '') codigo = null;
          const porcentaje = (cupon_porcentaje == null || cupon_porcentaje === '') ? null : aNumero(cupon_porcentaje);

          if ((codigo === null) !== (porcentaje === null)) return sendAdmin(false, null, 'El cupón requiere código y porcentaje, o ninguno de los dos');
          if (codigo !== null && (!Number.isInteger(porcentaje) || porcentaje < 1 || porcentaje > 100)) return sendAdmin(false, null, 'El porcentaje del cupón debe ser un entero entre 1 y 100');

          try {
              const resultado = await fetchSupabase('rpc/promover_turno_rf03', 'POST', {
                  p_id_reserva_interno: idReserva,
                  p_precio_base_pactado: precio,
                  p_duracion_pactada: duracion,
                  p_total_pagado: pagado,
                  p_cupon_codigo: codigo,
                  p_cupon_porcentaje: porcentaje
              });
              return sendAdmin(true, resultado);
          } catch (e) {
              // fetchSupabase envuelve el fallo como "Error BD: <cuerpo>" y PostgREST
              // responde JSON { code, message, details, hint }. Se expone solo el
              // `message`: nunca el stack ni credenciales.
              const crudo = String((e && e.message) || e || '').replace(/^Error BD:\s*/, '');
              let mensaje = 'No se pudo promover el turno a RF-03';
              try {
                  const parseado = JSON.parse(crudo);
                  if (parseado && parseado.message) mensaje = String(parseado.message);
              } catch (_) {
                  if (crudo) mensaje = crudo.slice(0, 300);
              }
              return sendAdmin(false, null, mensaje);
          }
      }

      // RF-03: obtener composición completa para edición
      if (accion === 'obtener_composicion_turno_rf03') {
          const { id_reserva_interno } = body;
          if (!id_reserva_interno) return sendAdmin(false, null, 'Falta id_reserva_interno');
          const reservas = await fetchSupabase(`reservas?id_reserva_interno=eq.${encodeURIComponent(id_reserva_interno)}&select=*,servicios(nombre),profesionales(nombre)`);
          if (!reservas || reservas.length === 0) return sendAdmin(false, null, 'Reserva no encontrada');
          const r = reservas[0];
          const lineas = await fetchSupabase(`reserva_lineas?id_reserva=eq.${r.id}&select=id,orden,id_servicio,id_profesional,precio_snapshot,duracion_snapshot,servicios(nombre),profesionales(nombre)&order=orden.asc`);
          const esRf03 = Array.isArray(lineas) && lineas.length > 0;
          const saldoPendiente = Math.max(0, (r.total_pactado || 0) - (r.total_pagado || 0));
          return sendAdmin(true, {
              es_rf03: esRf03,
              legacy: !esRf03,
              id_reserva: r.id_reserva_interno,
              id_reserva_interno: r.id_reserva_interno,
              id_reserva_uuid: r.id,
              fecha_turno: r.fecha_turno,
              hora_turno: r.hora_turno,
              estado_turno: r.estado_turno,
              estado_pago: r.estado_pago,
              id_servicio: r.id_servicio,
              id_profesional: r.id_profesional,
              servicio: { nombre: r.servicios?.nombre || null },
              profesional: { nombre: r.profesionales?.nombre || null },
              subtotal_pactado: r.subtotal_pactado,
              descuento_aplicado: r.descuento_aplicado,
              total_pactado: r.total_pactado,
              total_pagado: r.total_pagado,
              saldo_pendiente: saldoPendiente,
              cupon_codigo_aplicado: r.cupon_codigo_aplicado,
              cupon_porcentaje_aplicado: r.cupon_porcentaje_aplicado,
              composicion: lineas.map(l => ({
                  id_linea: l.id,
                  orden: l.orden,
                  id_servicio: l.id_servicio,
                  nombre_servicio: l.servicios?.nombre || null,
                  id_profesional: l.id_profesional,
                  nombre_profesional: l.profesionales?.nombre || null,
                  precio_snapshot: l.precio_snapshot,
                  duracion_snapshot: l.duracion_snapshot
              }))
          });
      }

      // RF-03: actualizar composición vía RPC (autoridad exclusiva)
      if (accion === 'actualizar_composicion_turno_rf03') {
          const { id_reserva_interno, lineas } = body;
          if (!id_reserva_interno) return sendAdmin(false, null, 'Falta id_reserva_interno');
          if (!Array.isArray(lineas) || lineas.length === 0) return sendAdmin(false, null, 'La composición debe tener al menos una línea');
          try {
              const resultado = await fetchSupabase('rpc/actualizar_composicion_turno_rf03', 'POST', {
                  p_id_reserva_interno: id_reserva_interno,
                  p_lineas: lineas
              });
              return sendAdmin(true, resultado);
          } catch (e) {
              const crudo = String((e && e.message) || e || '').replace(/^Error BD:\s*/, '');
              let mensaje = 'No se pudo actualizar la composición';
              try {
                  const parseado = JSON.parse(crudo);
                  if (parseado && parseado.message) mensaje = String(parseado.message);
              } catch (_) {
                  if (crudo) mensaje = crudo.slice(0, 300);
              }
              return sendAdmin(false, null, mensaje);
          }
      }

      // FASE 2: Reasignación de turno (drag & drop). Solo cambia el profesional;
      // fecha/hora se mantienen, lo que bloquea/libera la disponibilidad en vivo
      // y mueve el evento en Google Calendar como respaldo de agenda.
      if (accion === 'reasignar_reserva') {
          // WP-P05 / RF-02: la acción cubre el turno completo. hora_turno, fecha_turno
          // y los datos de contacto son opcionales: si no vienen, se conserva el valor
          // actual. Así el flujo de mover/arrastrar sigue funcionando sin cambios.
          const { id_reserva, id_profesional, enviar_email, hora_turno, fecha_turno, cliente, email, telefono } = body;
          if (!id_reserva) return sendAdmin(false, null, 'Falta id de reserva');

          // FASE 2.2: normalización de la hora destino (HH:MM -> HH:MM:SS).
          const normalizarHora = (t) => {
              if (t === null || t === undefined || t === '') return null;
              const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
              if (!m) return null;
              const hh = String(Number(m[1])).padStart(2, '0');
              const ss = m[3] ? String(Number(m[3])).padStart(2, '0') : '00';
              return `${hh}:${m[2]}:${ss}`;
          };

          const reservas = await fetchSupabase(`reservas?id_reserva_interno=eq.${id_reserva}&select=*,servicios(nombre,duracion_minutos),profesionales(nombre,calendar_id)`);
          if (!reservas || reservas.length === 0) return sendAdmin(false, null, 'Reserva no encontrada');
          const reserva = reservas[0];
          if (reserva.estado_turno === 'Cancelada') return sendAdmin(false, null, 'No se puede mover una reserva cancelada');
          if (!reserva.fecha_turno || !reserva.hora_turno) return sendAdmin(false, null, 'La reserva no tiene turno definido');

          // RF-03: un turno promovido tiene su composición en reserva_lineas (N líneas
          // secuenciales con snapshots). Se detecta acá para no aplicar el modelo legacy
          // de "un solo servicio de cabecera" sobre una composición real. Solo lectura.
          // FAIL-CLOSED: si la lectura falla NO se degrada a legacy. Degradar haría que un
          // turno promovido se moviera con la duración de un solo servicio de cabecera y
          // su profesional global, corrompiendo la composición. Ante error se aborta antes
          // de cualquier PATCH. Solo es legacy si la consulta fue exitosa y dio 0 líneas.
          let lineasRf03;
          try {
              lineasRf03 = await fetchSupabase(`reserva_lineas?id_reserva=eq.${reserva.id}&select=id,orden,id_profesional,duracion_snapshot&order=orden.asc`);
          } catch (e) {
              console.error('[reasignar_reserva] no se pudo leer reserva_lineas:', e && e.message ? e.message : e);
              return sendAdmin(false, null, 'No se pudo verificar la composición del turno. Reintentá en unos segundos.');
          }
          if (!Array.isArray(lineasRf03)) {
              console.error('[reasignar_reserva] reserva_lineas devolvió un formato inesperado.');
              return sendAdmin(false, null, 'No se pudo verificar la composición del turno. Reintentá en unos segundos.');
          }
          const esRf03 = lineasRf03.length > 0;

          const nuevaHora = normalizarHora(hora_turno);
          if (hora_turno !== undefined && hora_turno !== null && hora_turno !== '' && nuevaHora === null) {
              return sendAdmin(false, null, 'Hora destino inválida');
          }
          const horaOrigen = String(reserva.hora_turno || '').slice(0, 5);
          const horaCambia = nuevaHora !== null && nuevaHora.slice(0, 5) !== horaOrigen;

          // Si no viene id_profesional se conserva el actual, para que editar solo
          // la fecha o un dato de contacto nunca desasigne por omisión.
          const profSolicitado = (id_profesional === undefined) ? reserva.id_profesional : id_profesional;

          // RF-02A: fecha destino. Solo se evalúa si viene informada.
          const fechaDestino = (fecha_turno === undefined || fecha_turno === null || fecha_turno === '')
              ? null : String(fecha_turno).trim();
          if (fechaDestino !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fechaDestino)) {
              return sendAdmin(false, null, 'Fecha destino inválida');
          }
          const fechaOrigen = String(reserva.fecha_turno || '').slice(0, 10);
          const fechaCambia = fechaDestino !== null && fechaDestino !== fechaOrigen;
          const fechaFinal = fechaCambia ? fechaDestino : fechaOrigen;

          // RF-02D: datos de contacto del turno (reservas.cliente / email / telefono).
          // `undefined` = no enviado, se conserva. Cadena vacía = se borra el dato.
          const normDato = (v) => (v === undefined ? undefined : String(v == null ? '' : v).trim());
          const nuevoCliente = normDato(cliente);
          const nuevoEmail = normDato(email);
          const nuevoTelefono = normDato(telefono);
          if (nuevoCliente !== undefined && nuevoCliente === '') {
              return sendAdmin(false, null, 'El nombre del cliente no puede quedar vacío');
          }
          if (nuevoEmail !== undefined && nuevoEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(nuevoEmail)) {
              return sendAdmin(false, null, 'El email del cliente no tiene un formato válido');
          }
          const clienteCambia = (nuevoCliente !== undefined && nuevoCliente !== String(reserva.cliente || '').trim())
              || (nuevoEmail !== undefined && nuevoEmail !== String(reserva.email || '').trim())
              || (nuevoTelefono !== undefined && nuevoTelefono !== String(reserva.telefono || '').trim());

          const turnoCambia = horaCambia || fechaCambia || clienteCambia;

          // Enmienda 2.2: el mismo profesional ya no se bloquea si la hora cambia.
          // WP-P05: tampoco bloquea cuando lo que cambia es la fecha o un dato del cliente.
          if (String(reserva.id_profesional || '') === String(profSolicitado || '') && !turnoCambia) {
              const sinProf = (reserva.id_profesional === null || reserva.id_profesional === undefined || reserva.id_profesional === '')
                            || (profSolicitado === null || profSolicitado === undefined || profSolicitado === '');
              return sendAdmin(false, null, sinProf ? 'La reserva ya está sin profesional asignado' : 'La reserva ya está asignada a ese profesional');
          }

          const esBloque = reserva.estado_turno === 'Bloqueada';
          const servicioNombre = reserva.servicios?.nombre || 'Servicio';
          const parseT = (t) => { const partes = String(t).split(':'); return parseInt(partes[0]) * 60 + parseInt(partes[1]); };

          // RF-03: la duración del turno es la suma de sus líneas secuenciales.
          // Legacy: la duración del servicio de cabecera, sin cambios.
          const duracion = esRf03
              ? (lineasRf03.reduce((acc, l) => acc + (parseInt(l.duracion_snapshot, 10) || 0), 0) || 30)
              : (reserva.servicios?.duracion_minutos || 30);

          // RF-03: cambiar el profesional "global" desde acá es ambiguo. La composición
          // puede tener profesionales distintos por línea, y sobrescribir todos sería
          // corrupción de datos. Fecha/hora y contacto siguen funcionando; el profesional
          // de una línea se edita por línea vía actualizar_composicion_turno_rf03.
          if (esRf03 && id_profesional !== undefined
              && String(id_profesional || '') !== String(reserva.id_profesional || '')) {
              return sendAdmin(false, null, 'En turnos con múltiples servicios el profesional se cambia por línea desde la composición; no se puede reasignar globalmente');
          }

          // Hora destino final: la nueva si cambió, sino la original.
          const horaDestino = horaCambia ? nuevaHora : String(reserva.hora_turno);

          // FASE 2.2: al cambiar el horario se valida que quede dentro de la jornada de la marca.
          // WP-P05: la jornada se revalida también cuando solo cambia la fecha, porque la
          // combinación fecha+hora es la que debe ser reservable.
          if (horaCambia || fechaCambia) {
              const cfgMarcaSlots = await fetchSupabase('configuracion_marca?select=hora_apertura,hora_cierre,zona_horaria,dias_laborables').catch(() => null);
              const cfg = (cfgMarcaSlots && cfgMarcaSlots[0]) || {};
              const aMin = parseT(String(cfg.hora_apertura || '09:00'));
              const cMin = parseT(String(cfg.hora_cierre || '19:00'));
              const startMin = parseT(horaDestino);
              if (startMin < aMin) return sendAdmin(false, null, 'El horario está antes de la apertura de la jornada');
              if (startMin + duracion > cMin) return sendAdmin(false, null, 'El turno termina después del cierre de la jornada');
              // RF-02A: se reutiliza la misma regla de día laborable que aplica la
              // disponibilidad y la reserva pública (WP-020-3), para que no se pueda
              // aparar un turno en un día cerrado. Se excluyen los bloqueos: un
              // bloqueo puede legítimamente ser un fin de semana (vacaciones, feriado).
              if (!esBloque && !esFechaLaborableValida(fechaFinal, cfg)) {
                  return sendAdmin(false, null, 'La fecha seleccionada es pasada o no es un día laborable');
              }
          }

          const requestedStart = parseT(horaDestino);
          const requestedEnd = requestedStart + duracion;
          const ahora = new Date();

          const targetId = (profSolicitado === null || profSolicitado === undefined || profSolicitado === '') ? null : String(profSolicitado).trim();
          // 2.2: si el profesional no cambia (solo se mueve el horario), no se
          // re-evalúa la calificación: el turno ya estaba asignado a ese profesional.
          const mismoProfesional = targetId !== null && String(reserva.id_profesional || '') === String(targetId);

          let target = null;
          if (targetId !== null) {
              target = (await fetchSupabase(`profesionales?id=eq.${targetId}&select=*`))[0];
              if (!target) return sendAdmin(false, null, 'Profesional destino no encontrado');
              if (target.estado !== 'Activo') return sendAdmin(false, null, 'El profesional destino está inactivo');
              // Los BLOQUEADOS no tienen servicio asignado (id_servicio null): cualquier
              // profesional activo puede recibirlos; el check de calificación solo aplica a turnos.
              // Consistente con disponibilidad (id) y reservar (id): el profesional
              // guarda id_servicio en servicios_asignados, no el nombre.
              if (!esBloque && !mismoProfesional && !esProfCalificado(target.servicios_asignados, reserva.id_servicio)) return sendAdmin(false, null, `El profesional destino no está calificado para ${servicioNombre}`);
          }

          // Regla de solapamiento idéntica a reservar: excluye la propia reserva,
          // respeta la gracia de 15 min para 'Pendiente (MP)' y compara contra la
          // hora DESTINO (nueva o idéntica a la original).
          // WP-P05: la consulta se hace contra la fecha DESTINO, no la original; si
          // no, un cambio de fecha no detectaría conflictos en el día nuevo.
          const solapamientos = await fetchSupabase(`reservas?fecha_turno=eq.${fechaFinal}&eliminado_logico=is.false&estado_turno=neq.Cancelada&select=id,id_reserva_interno,id_profesional,hora_turno,estado_turno,estado_pago,fecha_creacion,servicios(duracion_minutos)`);

          // RF-03: los turnos externos promovidos ocupan intervalos POR LÍNEA (secuenciales
          // desde su hora_turno, con la suma de duraciones previas). Si solo se mirara el
          // servicio de cabecera se subestimaría la ocupación real. Se traen las líneas de
          // los candidatos del día y se acumulan; los turnos sin líneas siguen siendo legacy.
          // FAIL-CLOSED: si esta lectura falla se aborta, porque perderla permitiría
          // sobreposicionar contra un turno externo promovido.
          let lineasSolapamiento = [];
          const idsCandidatos = solapamientos.map(o => o.id).filter(Boolean);
          if (idsCandidatos.length > 0) {
              try {
                  lineasSolapamiento = await fetchSupabase(`reserva_lineas?id_reserva=in.(${idsCandidatos.join(',')})&select=id_reserva,orden,id_profesional,duracion_snapshot&order=orden.asc`);
              } catch (e) {
                  console.error('[reasignar_reserva] no se pudo leer reserva_lineas externas:', e && e.message ? e.message : e);
                  return sendAdmin(false, null, 'No se pudo verificar la disponibilidad del día. Reintentá en unos segundos.');
              }
              if (!Array.isArray(lineasSolapamiento)) {
                  console.error('[reasignar_reserva] reserva_lineas externas devolvió un formato inesperado.');
                  return sendAdmin(false, null, 'No se pudo verificar la disponibilidad del día. Reintentá en unos segundos.');
              }
          }

          const lineasPorReserva = {};
          for (const l of lineasSolapamiento) {
              if (!Array.isArray(lineasPorReserva[l.id_reserva])) lineasPorReserva[l.id_reserva] = [];
              lineasPorReserva[l.id_reserva].push(l);
          }

          // RF-03: los intervalos que se piden NO son un bloque global. Se construyen desde
          // las líneas propias, en orden, desde la hora destino: cada línea conserva SU
          // profesional. Un turno con profesionales distintos se valida línea por línea.
          let intervaloSolicitado;
          if (esRf03) {
              intervaloSolicitado = [];
              let cursor = requestedStart;
              for (const l of lineasRf03) {
                  const lDur = parseInt(l.duracion_snapshot, 10) || 0;
                  intervaloSolicitado.push({ ini: cursor, fin: cursor + lDur, prof: l.id_profesional });
                  cursor = cursor + lDur;
              }
          } else {
              intervaloSolicitado = [{ ini: requestedStart, fin: requestedEnd, prof: targetId }];
          }

          const existeSolapamiento = solapamientos.some(o => {
              if (String(o.id_reserva_interno || '') === String(id_reserva)) return false;
              if (o.estado_pago === 'Pendiente (MP)' && o.fecha_creacion) {
                  const creado = new Date(o.fecha_creacion);
                  if ((ahora - creado) / 60000 > 15) return false;
              }
              const start = parseT(o.hora_turno);
              const lineas = lineasPorReserva[o.id] || [];

              // Turno externo promovido: cada línea ocupa su propio intervalo secuencial.
              if (lineas.length > 0) {
                  let acumulado = 0;
                  for (const l of lineas) {
                      const lIni = start + acumulado;
                      const lDur = parseInt(l.duracion_snapshot, 10) || 0;
                      const lFin = lIni + lDur;
                      acumulado = lFin - start;
                      for (const req of intervaloSolicitado) {
                          if (String(req.prof || '') !== String(l.id_profesional || '')) continue;
                          if (req.ini < lFin && lIni < req.fin) return true;
                      }
                  }
                  return false;
              }

              // Turno externo legacy: un solo servicio de cabecera.
              const end = start + (o.servicios?.duracion_minutos || 30);
              for (const req of intervaloSolicitado) {
                  if (String(req.prof || '') !== String(o.id_profesional || '')) continue;
                  if (req.ini < end && start < req.fin) return true;
              }
              return false;
          });
          if (existeSolapamiento) return sendAdmin(false, null, 'Ese profesional ya tiene un turno en ese horario');

          // PATCH de profesional + hora + fecha + datos de contacto (impacta disponibilidad del index en vivo)
          // FASE 8 (pagos): este PATCH es intencionalmente limitado a fecha, hora,
          // profesional y contacto. El servicio no se toca, por lo que el importe, la
          // seña y las preferencias de Mercado Pago quedan intactos y no hay que recalcular nada.
          const patchData = { id_profesional: targetId };
          if (horaCambia) patchData.hora_turno = horaDestino;
          if (fechaCambia) patchData.fecha_turno = fechaFinal;
          if (nuevoCliente !== undefined) patchData.cliente = nuevoCliente;
          if (nuevoEmail !== undefined) patchData.email = nuevoEmail || null;
          if (nuevoTelefono !== undefined) patchData.telefono = nuevoTelefono || null;
          await fetchSupabase(`reservas?id_reserva_interno=eq.${id_reserva}`, 'PATCH', patchData);

          // FASE 6 (CRM): si el turno tiene ficha en `clientes`, se sincronizan nombre,
          // teléfono y email para no dejar la ficha desactualizada respecto del turno.
          // Solo UPDATE de la ficha ya vinculada; no se crean fichas nuevas desde una
          // edición, para no duplicar clientes ni inventar un sistema nuevo.
          let crmSincronizado = false;
          if (clienteCambia && reserva.id_cliente_crm) {
              const crmPatch = {};
              if (nuevoCliente !== undefined) crmPatch.nombre = nuevoCliente;
              if (nuevoEmail !== undefined) crmPatch.email = nuevoEmail || null;
              if (nuevoTelefono !== undefined) crmPatch.telefono = nuevoTelefono || null;
              if (Object.keys(crmPatch).length > 0) {
                  await fetchSupabase(`clientes?id_cliente=eq.${reserva.id_cliente_crm}`, 'PATCH', crmPatch).catch(() => null);
                  crmSincronizado = true;
              }
          }

          if (esBloque) return sendAdmin(true, { sync_calendar: null, movido: true, crm_sincronizado: crmSincronizado });

          // Respaldo de agenda: mover el evento en Google Calendar del pro origen
          // al pro destino con el nuevo horario. Los bloques no se sincronizan
          // (igual que hoy). fecha/hora = ORIGEN; nueva_fecha/nueva_hora = DESTINO.
          let calOrigen = reserva.profesionales?.calendar_id || 'primary';
          let calDestino = 'primary';
          let nombreDestino = 'Local';
          if (targetId !== null && target) {
              calDestino = target.calendar_id || 'primary';
              nombreDestino = target.nombre || 'Sin asignar';
          } else {
              calDestino = 'primary';
              nombreDestino = 'Sin asignar';
          }

          // FASE 9 (GAS): se reutiliza el contrato `mover_reserva` existente. Los campos
          // nueva_fecha/nueva_hora ya forman parte del contrato, así que el cambio de día
          // se envia por el mismo camino. fecha/hora siguen siendo el ORIGEN del evento.
          // Los datos de contacto se envían ya editados para que el evento y el aviso
          // por email reflejen la información nueva.
          const googleRes = await moverGoogleEvento({
              accion: 'mover_reserva',
              id_reserva_interno: id_reserva,
              fecha: reserva.fecha_turno,
              hora: reserva.hora_turno,
              nueva_fecha: fechaFinal,   // 2.2: vertical (misma fecha); RF-02: puede cambiar de día
              nueva_hora: horaDestino,   // original si no cambia, nueva si cambia
              duracion: duracion,
              calendar_id_origen: calOrigen,
              calendar_id_destino: calDestino,
              servicio: servicioNombre,
              cliente: (nuevoCliente !== undefined ? nuevoCliente : reserva.cliente) || '',
              email: (nuevoEmail !== undefined ? nuevoEmail : reserva.email) || '-',
              telefono: (nuevoTelefono !== undefined ? nuevoTelefono : reserva.telefono) || '-',
              nombreProfesional: nombreDestino,
              notificar_por_email: enviar_email === true
          });

          if (!googleRes.ok) {
              await fetchSupabase(`reservas?id_reserva_interno=eq.${id_reserva}`, 'PATCH', { sync_calendar: false });
              return sendAdmin(true, { sync_calendar: false, movido: true, crm_sincronizado: crmSincronizado, aviso: 'Turno movido correctamente, pero el evento de Google no se pudo actualizar' });
          }
          return sendAdmin(true, { sync_calendar: true, movido: true, crm_sincronizado: crmSincronizado, fecha_turno: fechaFinal });
      }
      if (accion === 'obtener_categorias_gastos') {
          if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
          const categorias = await fetchSupabase('categorias_gastos?es_activa=eq.true&order=nombre.asc&select=*');
          return sendAdmin(true, { categorias });
      }
      if (accion === 'obtener_gastos') {
          if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
          const gastos = await fetchSupabase('gastos_operativos?estado=eq.ACTIVO&order=fecha_gasto.desc&select=*,categorias_gastos(nombre,color_tag)');
          return sendAdmin(true, { gastos });
      }
      if (accion === 'registrar_gasto') {
          if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
          const { monto, fecha_gasto, id_categoria, nota_descripcion } = body;
          if (!monto || !fecha_gasto || !id_categoria) return sendAdmin(false, null, 'Faltan datos del gasto');
          await fetchSupabase('gastos_operativos', 'POST', { monto: parseFloat(monto), fecha_gasto, id_categoria, nota_descripcion });
          return sendAdmin(true);
      }
      if (accion === 'eliminar_gasto') {
          if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
          if (!body.id) return sendAdmin(false, null, 'Falta id del gasto');
          await fetchSupabase(`gastos_operativos?id=eq.${body.id}`, 'PATCH', { estado: 'ANULADO' });
          return sendAdmin(true);
      }
      // Alta MANUAL de una categoría de gasto. Es la única acción que escribe en
      // `categorias_gastos`: hasta ahora la tabla solo se leía.
      //
      // Payload permitido: SOLO `nombre` y `color_tag`. `id`, `es_activa` y
      // cualquier otro campo del body se ignoran a propósito (no se copian al
      // INSERT), así que un cliente malicioso no puede desactivar la categoría
      // recién creada ni forzar un id.
      if (accion === 'agregar_categoria_gasto') {
          if (body.token !== ADMIN_TOKEN) return sendAdmin(false, null, 'Denegado');
          const nombre = String(body.nombre == null ? '' : body.nombre).trim();
          const colorTag = String(body.color_tag == null ? '' : body.color_tag).trim();
          if (!nombre) return sendAdmin(false, null, 'Ingresá un nombre para la categoría.');
          // `#RRGGBB` exacto. `color_tag` se inyecta en un `style` al armar el
          // flujo de caja (admin.js), así que no se acepta texto libre.
          if (!/^#[0-9a-fA-F]{6}$/.test(colorTag)) return sendAdmin(false, null, 'El color seleccionado no es válido.');
          try {
              // Precheck por la MISMA clave del índice: `lower(trim(nombre))`,
              // sin comparación case-sensitive. Se consulta sobre TODAS las
              // filas, no solo las activas, porque el índice UNIQUE tampoco
              // filtra por `es_activa`: una categoría desactivada con el mismo
              // nombre sigue reservando el nombre.
              //
              // Se lee solo `nombre`: es un catálogo chico y no hace falta el
              // resto de la fila para decidir. Este precheck NO reemplaza al
              // índice (dos requests pueden pasar las dos por el precheck); es
              // el índice el que decide, y su 23505 se traduce al mismo
              // mensaje de negocio más abajo.
              const existentes = await fetchSupabase('categorias_gastos?select=nombre');
              const clave = claveNombreCategoriaGasto(nombre);
              const yaExiste = Array.isArray(existentes)
                  && existentes.some(c => claveNombreCategoriaGasto(c.nombre) === clave);
              if (yaExiste) return sendAdmin(false, null, GASTOS_MSG_CATEGORIA_DUPLICADA);

              // `es_activa` NO se manda a propósito: el default `true` de la
              // tabla (esquema_maestro.sql:71) es el estado real de una
              // categoría recién creada, y no es un campo editable de este alta.
              await fetchSupabase('categorias_gastos', 'POST', { nombre: nombre, color_tag: colorTag });
              return sendAdmin(true);
          } catch (e) {
              // Carrera resuelta: otra request insertó el mismo nombre entre el
              // precheck y el INSERT. El índice es la autoridad final y el
              // frontend recibe EXACTAMENTE el mismo mensaje que habría recibido
              // del precheck.
              if (esColisionNombreCategoriaGasto(e)) return sendAdmin(false, null, GASTOS_MSG_CATEGORIA_DUPLICADA);
              // Cualquier otro error no se filtra al frontend: el texto crudo
              // de PostgREST expone SQL y nombres de objetos internos.
              console.error('Error creando categoria de gasto:', e);
              return sendAdmin(false, null, 'No se pudo crear la categoría. Intentá de nuevo.');
          }
      }
      if (accion === 'bloquear_horario') { 
          const parseT = (t) => { const partes = String(t).split(':'); return parseInt(partes[0]) * 60 + parseInt(partes[1]); };
          const formT = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
          const duracion = parseInt(body.duracion) || 30;
          const slots = Math.ceil(duracion / 30);
          const baseMin = parseT(body.hora_inicio);
          for (let i = 0; i < slots; i++) {
              const hSlot = formT(baseMin + (i * 30));
              await fetchSupabase('reservas', 'POST', { id_reserva_interno: "BLK-"+Date.now()+'-'+i, fecha_turno: body.fecha, hora_turno: hSlot, cliente: body.motivo, telefono: "-", email: "-", id_profesional: body.profesional||null, monto_cobrado: 0, estado_turno: "Bloqueada" });
          }
          return sendAdmin(true); 
      }
    }
  } catch (error) { return sendAdmin(false, null, error.message); }
}