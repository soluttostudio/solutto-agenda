# ESPECIFICACIÓN VISUAL HOTFIX — TSK-FIX-003

> **Rol:** UX/UI Engineer  
> **Contexto:** Hotfix visual para recuperación del logo (404) y refinamiento de edición inline de precios en el panel admin.  
> **Audiencia:** Programador Frontend — debe seguir esta especificación al pie de la letra.

---

## 1. PROBLEMA: Logo no se renderiza (404)

### Diagnóstico

En `index.html` (línea 17), la imagen del logo se referencia como:

```html
src="assets/Fresitas%20Nails%20sin%20fondo.webp"
```

El navegador resuelve esta ruta relativa como:

```
/Calendar system/assets/Fresitas Nails sin fondo.webp
```

Pero el archivo real está en:

```
/Calendar system/Fresitas Nails sin fondo.webp
```

**No existe el subdirectorio `assets/` dentro de `Calendar system/`.** Esto produce un error 404. El `onerror` actual oculta la imagen y muestra un fallback textual (`<h1 class="header__logo-fallback">`), pero se pierde la identidad visual de la marca.

### Solución estructura DOM

```html
<!-- index.html · header actual (solo cambiar src) -->
<header class="site-header">
  <img
    class="logo-img"
    src="Fresitas%20Nails%20sin%20fondo.webp"
    alt="Fresitas Nails"
    width="auto"
    height="80"
    onerror="this.style.display='none';this.nextElementSibling.style.display='block'"
  />
  <h1 class="header__logo-fallback" style="display:none">Fresitas Nails</h1>
</header>
```

**Cambio exacto:** `src="assets/Fresitas%20Nails%20sin%20fondo.webp"` → `src="Fresitas%20Nails%20sin%20fondo.webp"`

### Clases CSS existentes (NO modificar, ya son correctas)

```css
.site-header {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: var(--header-height, 72px);
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--gris-100);
  display: flex;
  align-items: center;
  padding: 0 24px;
  z-index: 100;
}

.logo-img {
  max-height: 80px;
  width: auto;
  object-fit: contain;
  display: block;
}

.header__logo-fallback {
  font-family: var(--font-accent, 'Great Vibes', cursive);
  font-size: 1.75rem;
  color: var(--fucsia, #D80073);
  margin: 0;
  line-height: 1;
}
```

> **Nota:** El header usa `display: flex; align-items: center` con padding simétrico. El logo queda alineado a la izquierda con su altura natural. No se necesita centrado forzado — la composición original de la marca es header con logo a la izquierda y espacio limpio a la derecha.

---

## 2. PROBLEMA: Edición de precios con recarga tosca de tabla

### Diagnóstico

En `admin.html`, las funciones `saveBtn` y `cancelBtn` del editor inline de precios llaman a `renderServicios()` (líneas 513 y 521), lo que:

1. Borra todo `tbody.innerHTML`
2. Reconstruye cada fila desde cero
3. Re-asigna todos los event listeners
4. Provoca un parpadeo visual y pérdida de foco
5. Es particularmente molesto si hay muchos servicios

### Comportamiento esperado (UX)

```
ESTADO INICIAL: Celda en modo "display"
┌──────────────────────────┐
│  $5.000  [✎]             │  ← .price-display
└──────────────────────────┘

USUARIO HACE CLIC EN [✎]:
┌──────────────────────────┐
│ [___5000___] [Guardar][×]│  ← .price-input-group
└──────────────────────────┘
  • Input recibe foco automático
  • Input type="number", min=0
  • Botón "Guardar" hace fetch a update-precio
  • Botón "Cancelar" (×) descarta cambios

AL GUARDAR (éxito):
  → La celda vuelve a modo display con el NUEVO precio
  → NO se recarga la tabla entera
  → Se muestra un alert success efímero

AL CANCELAR:
  → La celda vuelve a modo display con el PRECIO ORIGINAL
  → NO se recarga la tabla entera

AL GUARDAR (error):
  → El input permanece abierto con el valor ingresado
  → Se muestra alert error
  → El usuario puede corregir y reintentar
```

### Refactor del JavaScript (admin.html, dentro del evento `editBtn.click()`)

Reemplazar el llamado a `renderServicios()` por manipulación local del DOM:

```javascript
// En lugar de:
//   await apiGet("update-precio", { id: svc.id_servicio, precio: nuevoPrecio });
//   renderServicios();  ← ELIMINAR

// Usar:
const data = await apiGet("update-precio", { id: svc.id_servicio, precio: nuevoPrecio });
// Volver a modo display con el nuevo precio
priceDisplay.innerHTML = `
  <span class="price-value">${formatPrecio(nuevoPrecio)}</span>
  <button class="edit-btn" title="Editar precio">✎</button>
`;
// Re-asignar event listener al nuevo botón ✎
// (ver sección "Re-asignación de eventos" más abajo)
showAlert("Precio actualizado correctamente.", "success");

// Para cancelar:
// En lugar de:
//   renderServicios();  ← ELIMINAR
// Usar:
priceDisplay.innerHTML = `
  <span class="price-value">${formatPrecio(currentPrice)}</span>
  <button class="edit-btn" title="Editar precio">✎</button>
`;
```

#### Re-asignación de eventos

Después de reemplazar el `innerHTML` del `priceDisplay`, hay que re-vincular el evento `click` al nuevo `edit-btn`:

```javascript
const newEditBtn = priceDisplay.querySelector(".edit-btn");
newEditBtn.addEventListener("click", /* misma lógica */);
```

Para evitar duplicación, se recomienda extraer la lógica del editor a una función reutilizable:

```javascript
function activatePriceEdit(priceDisplay, svc) {
  const currentPrice = svc.precio;
  priceDisplay.innerHTML = `
    <div class="price-input-group">
      <input type="number" value="${currentPrice}" min="0" step="1">
      <button class="save-btn">Guardar</button>
      <button class="cancel-btn">Cancelar</button>
    </div>
  `;
  const input = priceDisplay.querySelector("input");
  const saveBtn = priceDisplay.querySelector(".save-btn");
  const cancelBtn = priceDisplay.querySelector(".cancel-btn");
  input.focus();

  saveBtn.addEventListener("click", async () => {
    const nuevoPrecio = parseInt(input.value, 10);
    if (isNaN(nuevoPrecio) || nuevoPrecio <= 0) {
      showAlert("Ingrese un precio válido.", "error");
      return;
    }
    saveBtn.disabled = true;
    try {
      await apiGet("update-precio", { id: svc.id_servicio, precio: nuevoPrecio });
      // Volver a display SIN recargar toda la tabla
      renderPriceDisplay(priceDisplay, nuevoPrecio, svc);
      showAlert("Precio actualizado correctamente.", "success");
    } catch (err) {
      showAlert(err.message, "error");
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener("click", () => {
    // Volver a display con precio original SIN recargar toda la tabla
    renderPriceDisplay(priceDisplay, currentPrice, svc);
  });
}

function renderPriceDisplay(container, precio, svc) {
  container.innerHTML = `
    <span class="price-value">${formatPrecio(precio)}</span>
    <button class="edit-btn" title="Editar precio">✎</button>
  `;
  const editBtn = container.querySelector(".edit-btn");
  editBtn.addEventListener("click", () => activatePriceEdit(container, { ...svc, precio }));
}
```

### Clases CSS involucradas (admin.html, ya existen — NO modificar)

```css
.price-display { display: inline-flex; align-items: center; gap: 8px; }
.price-display .price-value { font-weight: 600; }
.price-display .edit-btn {
  background: none; border: none; color: var(--gray-400); cursor: pointer;
  font-size: 0.85rem; padding: 2px 6px; border-radius: 4px; transition: 0.15s;
}
.price-display .edit-btn:hover { color: var(--black-900); background: var(--silver-50); }
.price-input-group { display: inline-flex; align-items: center; gap: 6px; }
.price-input-group input[type="number"] {
  width: 100px; padding: 4px 8px; border: 1px solid var(--silver-200);
  border-radius: 4px; font-size: 0.85rem;
}
.price-input-group .save-btn, .price-input-group .cancel-btn {
  padding: 4px 10px; border: none; border-radius: 4px; font-size: 0.75rem; font-weight: 600; cursor: pointer;
}
.price-input-group .save-btn { background: var(--black-900); color: #fff; }
.price-input-group .save-btn:hover { background: var(--gray-600); }
.price-input-group .cancel-btn { background: var(--silver-100); color: var(--gray-500); }
.price-input-group .cancel-btn:hover { background: var(--silver-200); }
```

---

## 3. LOGO EN EL PANEL ADMIN

### Login screen (admin.html)

Actualmente el login muestra solo texto `<h1>Fresitas Nails</h1>`. Se debe agregar el logo dentro del `.login-box`:

```html
<div class="login-box">
  <img
    class="login-logo"
    src="Fresitas%20Nails%20sin%20fondo.webp"
    alt="Fresitas Nails"
    width="auto"
    height="60"
  />
  <p>Panel Administrativo</p>
  <!-- ... resto del formulario ... -->
</div>
```

### CSS para login-logo

```css
.login-logo {
  display: block;
  max-height: 60px;
  width: auto;
  margin: 0 auto 12px auto;
  object-fit: contain;
}
```

> Colocar este estilo en el bloque `<style>` de `admin.html`, idealmente después de la regla `.login-box p`.

### Sidebar (admin.html)

Actualmente el sidebar tiene `<h2>Administración</h2>`. Se debe reemplazar por el logo:

```html
<aside class="sidebar">
  <div class="sidebar-logo-wrap">
    <img
      class="sidebar-logo"
      src="Fresitas%20Nails%20sin%20fondo.webp"
      alt="Fresitas Nails"
      width="auto"
      height="32"
    />
  </div>
  <nav>
    <!-- ... items de navegación ... -->
  </nav>
  <button id="btn-logout" class="logout-btn">Cerrar sesión</button>
</aside>
```

### CSS para sidebar-logo

```css
.sidebar-logo-wrap {
  padding: 0 20px 20px;
  border-bottom: 1px solid var(--gray-600);
  margin-bottom: 16px;
}
.sidebar-logo {
  display: block;
  max-height: 32px;
  width: auto;
  object-fit: contain;
  filter: brightness(0) invert(1); /* fuerza blanco sobre fondo negro */
}
```

---

## 4. CHECKLIST DE IMPLEMENTACIÓN

- [ ] **index.html línea 17:** cambiar `src="assets/Fresitas%20Nails%20sin%20fondo.webp"` → `src="Fresitas%20Nails%20sin%20fondo.webp"`
- [ ] **admin.html login:** agregar `<img class="login-logo">` dentro de `.login-box`
- [ ] **admin.html login:** agregar CSS `.login-logo { ... }`
- [ ] **admin.html sidebar:** reemplazar `<h2>Administración</h2>` por `.sidebar-logo-wrap` con `<img class="sidebar-logo">`
- [ ] **admin.html sidebar:** agregar CSS `.sidebar-logo-wrap` y `.sidebar-logo`
- [ ] **admin.html JS `renderServicios()`:** extraer lógica de edición a `activatePriceEdit()` y `renderPriceDisplay()`
- [ ] **admin.html JS:** eliminar llamado a `renderServicios()` dentro de `saveBtn.click()` y `cancelBtn.click()`
- [ ] **admin.html JS:** la función `formatPrecio()` ya existe y debe reutilizarse
- [ ] **Verificar:** que el `edit-btn` dentro de `renderServicios()` use `activatePriceEdit()` para abrir el editor
- [ ] **Verificar:** que no haya fugas de memoria (remover `innerHTML` limpia los listeners viejos automáticamente)

---

## 5. ESTRUCTURA DE ARCHIVOS (post-hotfix)

```
Calendar system/
├── .gitignore
├── .vercel/
├── Fresitas Nails sin fondo.webp    ← logo (immutable)
├── index.html                        ← hotfix: src corregido
├── admin.html                        ← hotfix: logo + refactor edición
├── app.js
└── styles.css
```

> No se requiere crear el directorio `assets/`. El logo vive en la raíz de `Calendar system/` y se referencia sin prefijo.
