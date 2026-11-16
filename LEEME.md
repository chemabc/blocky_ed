# Editor colaborativo en tiempo real

Servicio aparte (Node) en el que varias personas escriben a la vez el mismo texto. Lo usa la plataforma de
asambleas, pero no depende de ella: **cualquier aplicación** puede usarlo con un nombre, un secreto y dos
direcciones. La carpeta está pensada para salir algún día a su propio repositorio sin cambiar nada.

Licencias: MIT (Yjs, Hocuspocus, CodeMirror, y-codemirror.next, markdown-it, ws, esbuild) y Apache-2.0 (el
compilador de Typst para Node, de typst.ts).

## Piezas

| Fichero | Qué hace |
|---|---|
| `src/servidor.mjs` | El servidor: WebSocket (Hocuspocus) y unas pocas direcciones HTTP. |
| `src/pases.mjs` | Lee los pases (JWT HS256) y firma y comprueba las peticiones entre servidores. |
| `src/aplicaciones.mjs` | Las aplicaciones dadas de alta y las dos llamadas que les hace. |
| `src/almacen.mjs` | Su propia copia de cada sala (estado de Yjs y versión), en ficheros. |
| `src/typst.mjs` | De Markdown a Typst y la plantilla común (A4, letra, título). |
| `src/renderizador.mjs` | Compila con Typst en un hilo aparte, con tiempo máximo, en una carpeta vacía (con las imágenes en memoria). |
| `src/biblioteca.mjs` | La biblioteca: plantillas, fragmentos, cabeceras y pies, e imágenes, en carpetas; quién ve y quién cambia. |
| `src/cifrado.mjs` | Cifra lo que la biblioteca guarda en disco (AES-256-GCM). |
| `src/cliente/editor.mjs` | El editor en el navegador: barra de formato, plantilla, cabecera y pie, texto, comentarios, fragmentos, imágenes y vista Typst; se construye en `publico/cliente.js`. |
| `src/cliente/biblioteca.mjs` | La biblioteca en el navegador: el árbol, la ficha de cada cosa y el cajón de fragmentos e imágenes. |
| `prueba/` | Pruebas con `node --test`: pases, Typst, biblioteca (con cifrado y compilación) y una sala con varias personas de verdad. |

## Lo que ve quien escribe

- **Barra de formato** arriba: negrita, cursiva, título, listas, cita, enlace, código, tabla y separador.
  Escribe las marcas de Markdown o de Typst, según el formato del texto.
- **Vista Typst** (botón): enciende un panel al lado con el resultado compilado, que se pone al día poco
  después de cada cambio. Apagada, el panel no se ve y no se compila nada. **Previsualizar** compila una
  vez (por ejemplo, antes de descargar) y **PDF** lo descarga.
- **Comentarios**: se selecciona un trozo y «💬 Comentar». El trozo queda resaltado; al pulsarlo sale un
  bocadillo debajo con el hilo, «Responder» y «✓ Resuelto». «↓ 💬» va al siguiente. Los comentarios se
  anclan al texto (posiciones relativas de Yjs): siguen en su sitio aunque se escriba alrededor.
- **Plantilla** y **Cabecera y pie** (desplegables, si la aplicación usa la biblioteca): lo elegido vale
  para todas las personas de la sala y lo cambia quien escribe. Si el texto está vacío, la plantilla pone su
  texto de partida.
- **📚 Fragmentos e imágenes**: un cajón con los dos árboles; al pulsar uno, se mete donde está el cursor
  (una imagen se mete como `![nombre](imagen:<número>)` en Markdown o `#image("/imagenes/<número>")` en Typst).
- **Cuántos a la vez**: si el pase dice un máximo de personas escribiendo (o comentando) y ya están, se
  entra a leer con un aviso.
- **Sesiones largas y cortes de conexión.** El pase solo se mira al entrar en la sala: una vez dentro, la
  conexión dura las horas que haga falta. Si se corta (wifi, el portátil se duerme, se reinicia el editor),
  el cliente pide un pase nuevo a la aplicación (`pedirPase`), vuelve a entrar y manda lo escrito mientras
  tanto. Si en 5 segundos no ha vuelto, sale un **aviso rojo** («no cierres esta pestaña») y, mientras no hay
  conexión, se guarda una **copia del texto en el navegador** (`localStorage`, una por pestaña), que se borra
  al volver y quedar todo enviado. Si la pestaña se cerró antes, al abrir de nuevo el texto se ofrecen las
  copias que no coinciden con el texto de ahora, para copiarlas y pegar lo que falte (no se mezclan solas:
  podrían duplicar trozos). Cerrar la pestaña sin conexión y con algo sin enviar pide confirmación.

## Cómo se usa desde una aplicación

1. **Darla de alta** en la variable `EDITOR_APLICACIONES` del editor:
   `{"asambleas": {"secreto": "…", "url": "http://app:8000/editor"}}`.
2. **Dar pases.** Cuando una persona abre un texto, la aplicación decide qué puede hacer y le da un pase:
   un JWT HS256 firmado con su secreto, con
   - `app`: el nombre de la aplicación;
   - `sala`: qué texto, con el nombre que quiera la aplicación (`documentos.documento:12`);
   - `alias`: cómo se llama la persona;
   - `permiso`: `leer`, `comentar` o `escribir`;
   - `exp`: hasta cuándo vale, en pocos minutos;
   - opcionales: `formato` (`markdown` o `typst`), `titulo` (para el PDF), `max_escritores` y
     `max_comentaristas` (cuántas personas a la vez con ese permiso).
3. **Pintar el editor** en su página:

   ```html
   <script src="http://localhost:1234/cliente.js"></script>
   <div id="cuadro"></div>
   <script>
     EditorColaborativo.montar(document.getElementById("cuadro"), {
       url: "ws://localhost:1234", sala: "asambleas/documentos.documento:12", pase: "…",
       alias: "Lince", color: "#7c3aed", permiso: "escribir", formato: "markdown",
       pedirPase: async () => "…",  // uno nuevo: al reconectar y para compilar
       alCambiar: (texto) => {}, alPersonas: (lista) => {}, alEstado: (estado) => {},
     });
   </script>
   ```

   Los colores se adaptan con variables CSS (`--ec-borde`, `--ec-acento`, `--ec-resalte`, `--ec-fondo`).
4. **Responder a las llamadas** del editor (firmadas, ver abajo):
   - `GET <url>/texto/?sala=…`: devuelve `{"texto", "version"}`. Es el texto con el que empieza una sala
     que el editor no tiene, o que la aplicación ha cambiado por su cuenta.
   - `POST <url>/guardado/` con `{"sala", "texto", "alias": [...], "version"}`: guarda lo escrito y
     devuelve `{"version"}`. Si ya no acepta cambios, responde 409 y el editor cierra la sala.
   - Opcional: `POST <url>/comentarios/` con `{"sala", "comentarios": [...]}`: todos los comentarios de la
     sala cada vez que cambian (con el trozo que comentan, `cita`), para que la aplicación los guarde. Si
     responde 404, el editor entiende que no los quiere.
5. **Cerrar una sala** cuando cambian los permisos (por ejemplo, al aprobar un acta): `POST /salas/cerrar`
   con `{"sala"}`, la cabecera `X-Editor-App` y la firma. Quien vuelva a entrar trae un pase nuevo.

## Biblioteca: plantillas, fragmentos, cabeceras y pies, e imágenes

Una biblioteca para todas las aplicaciones, en carpetas y subcarpetas, con cuatro árboles:

- **Plantillas**: todo lo que puede llevar un documento de partida: su aspecto (Typst: página, letra,
  títulos…; la variable `titulo` tiene el del documento) y, si se quiere, un texto de partida.
- **Fragmentos** (la enciclopedia): trozos de texto, de código o de las dos cosas.
- **Cabeceras y pies** (membretes): lo de arriba y abajo de cada página, en Typst. Se elige aparte.
- **Imágenes**: PNG, JPEG o GIF de hasta 2 MB.

**Quién ve y quién cambia.** El pase trae, además de lo de siempre:
- `usuario`: un número que identifica a la persona en esa aplicación, sin decir quién es;
- `ambitos`: `[{id, nombre, cambiar}]`, los ámbitos a los que pertenece (lo que la aplicación quiera: toda
  la plataforma, una organización, un grupo…). Con `cambiar`, los administra;
- opcional, `carpetas`: nombres de las carpetas de primer nivel que ve con ese pase.

Cada cosa tiene un **dueño** (un ámbito, o la propia persona) y puede estar **compartida** con otros
ámbitos y con personas sueltas. Se ve lo de tus ámbitos, lo tuyo y lo compartido contigo; se cambia lo de
los ámbitos que administras y lo tuyo. Las carpetas de primer nivel y las imágenes las crea la
administración (un ámbito con `cambiar`); lo demás, cualquiera. Lo de una aplicación nunca lo ve otra, y
cada aplicación puede quedarse solo con algunas carpetas de primer nivel de plantillas y de fragmentos
(`"carpetas": ["Actas"]` en `EDITOR_APLICACIONES`); las cabeceras y pies y las imágenes no se limitan así.

**Direcciones** (con el pase en `Authorization: Bearer …`; se pueden llamar desde otra web):

| Petición | Qué hace |
|---|---|
| `GET /biblioteca` | Lo que ve la persona: carpetas, elementos (con sus textos) y sus ámbitos. |
| `POST /biblioteca/carpetas` · `PUT` / `DELETE /biblioteca/carpetas/<id>` | Crear, cambiar (nombre, dueño, compartir) y borrar (vacía) una carpeta. |
| `POST /biblioteca/elementos` · `PUT` / `DELETE /biblioteca/elementos/<id>` | Lo mismo con plantillas, fragmentos y membretes (`datos`: sus campos). |
| `POST /biblioteca/imagenes?carpeta=…&nombre=…&dueno=…` | Subir una imagen (el cuerpo son sus bytes). |
| `GET /biblioteca/imagenes/<id>` | Ver una imagen (el pase también vale en `?pase=`, para `<img>`). |
| `POST /biblioteca/previa` | Compilar un ejemplo con un aspecto o una cabecera y pie mientras se escriben (SVG). |

**La pantalla de la biblioteca** la pinta el propio editor:
`EditorColaborativo.montarBiblioteca(elemento, {url, pase, pedirPase, clase, buscarPersonas})`, con
`clase` = `plantilla`, `fragmento`, `membrete` o `imagen`. Para compartir con personas sueltas, la
aplicación da `buscarPersonas(texto)` → `[{id, nombre}]` (con el mismo `usuario` que pone en los pases).

**Cifrado.** Todo lo de la biblioteca se guarda cifrado con AES-256-GCM (`src/cifrado.mjs`) con la clave de
`EDITOR_CLAVE` (32 bytes en base64: `openssl rand -base64 32`). Cada fichero va sellado: si se toca, no se
lee. Protege si alguien se lleva el disco o una copia; no, de quien controla el servidor mientras funciona.
Sin `EDITOR_CLAVE`, no hay biblioteca. **Si se pierde la clave, se pierde la biblioteca.**

**Al compilar**, se ponen la plantilla y la cabecera y pie que haya elegido la sala (si quien compila las
ve) y se le dan al compilador, en memoria, las imágenes de la biblioteca que use el texto (solo las que ve).

## Firmas entre servidores

Cada petición lleva dos cabeceras:
- `X-Editor-Hora`: segundos desde 1970.
- `X-Editor-Firma`: HMAC-SHA256 en base64url de `«hora».«cuerpo»`, con el secreto de la aplicación. En un
  GET, el cuerpo es la sala.

Se rechaza si la hora se aleja más de 5 minutos. Así nadie puede hacerse pasar por la otra parte ni repetir
una petición vieja.

## Cómo se guarda

- Mientras hay alguien escribiendo, el texto vive en la memoria del editor (Yjs).
- Dos segundos después del último cambio, y como mucho cada diez, el editor:
  - avisa a la aplicación con el texto entero y los alias que han escrito desde el último aviso;
  - guarda su propia copia (`EDITOR_DATOS`), con la versión que le devolvió la aplicación.
- Al reabrir una sala, usa su copia si la versión coincide con la de la aplicación. Si no coincide, empieza
  con el texto de la aplicación.
- **La aplicación tiene siempre el texto bueno.** La copia del editor es solo la historia fina, que permite
  unir lo que escriben varias personas a la vez.

## Arrancar y probar

```bash
cd editor
npm install          # la primera vez
npm run construir    # crea publico/cliente.js
npm run probar       # pruebas
EDITOR_CLAVE=$(openssl rand -base64 32) EDITOR_APLICACIONES='{"asambleas":{"secreto":"s","url":"http://localhost:8000/editor"}}' npm run arrancar
```

En el contenedor de desarrollo hay un servicio `editor` que hace todo esto solo (ver
`.devcontainer/docker-compose.yml`).

## Typst

- `POST /render` (cuerpo `pase=…`) devuelve el SVG; `GET /pdf?pase=…` descarga el PDF. Sirven para
  cualquier origen: lo que protege es el pase.
- Markdown se convierte a Typst (`src/typst.mjs`); lo escrito se escapa. El Typst escrito a mano va tal
  cual. Los dos llevan delante la plantilla común.
- **Seguridad:**
  - compila en un hilo aparte, con 8 segundos como mucho (si no, se mata el hilo);
  - de una en una, en una carpeta vacía: no puede leer ficheros del servidor;
  - no se permiten paquetes (`@preview/…`), que se descargarían de internet;
  - los resultados se recuerdan mientras el texto no cambie.

## Por hacer

- **Mover** carpetas y elementos arrastrando, y **buscar** en la biblioteca.
- **Escribir plantillas y membretes a la vez** (hoy, cada cual en su ficha, con «Guardar»).
- **Cambiar la clave** de cifrado sin perder la biblioteca (descifrar con la vieja y cifrar con la nueva).
- **Autoría fina:** hoy se sabe quién ha escrito en cada intervalo de unos segundos. Con
  `Y.PermanentUserData` se sabría letra a letra.
- **Expulsar a una persona** sin cerrar la sala para todo el mundo.
- **Pases asimétricos** (Ed25519): el editor solo podría comprobar pases, no fabricarlos. Conviene cuando
  lo usen aplicaciones de otras personas.
- **Varias instancias** del editor (Hocuspocus tiene una extensión para repartir salas con Redis).
