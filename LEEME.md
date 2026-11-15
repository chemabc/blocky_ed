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
| `src/renderizador.mjs` | Compila con Typst en un hilo aparte, con tiempo máximo, en una carpeta vacía. |
| `src/cliente/editor.mjs` | El editor en el navegador: barra de formato, texto, comentarios y vista Typst; se construye en `publico/cliente.js`. |
| `prueba/` | Pruebas con `node --test`: pases, Typst y una sala con varias personas de verdad. |

## Lo que ve quien escribe

- **Barra de formato** arriba: negrita, cursiva, título, listas, cita, enlace, código, tabla y separador.
  Escribe las marcas de Markdown o de Typst, según el formato del texto.
- **Vista Typst** (botón): enciende un panel al lado con el resultado compilado, que se pone al día poco
  después de cada cambio. Apagada, el panel no se ve y no se compila nada. **Previsualizar** compila una
  vez (por ejemplo, antes de descargar) y **PDF** lo descarga.
- **Comentarios**: se selecciona un trozo y «💬 Comentar». El trozo queda resaltado; al pulsarlo sale un
  bocadillo debajo con el hilo, «Responder» y «✓ Resuelto». «↓ 💬» va al siguiente. Los comentarios se
  anclan al texto (posiciones relativas de Yjs): siguen en su sitio aunque se escriba alrededor.
- **Cuántos a la vez**: si el pase dice un máximo de personas escribiendo (o comentando) y ya están, se
  entra a leer con un aviso.

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
EDITOR_APLICACIONES='{"asambleas":{"secreto":"s","url":"http://localhost:8000/editor"}}' npm run arrancar
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

- **Plantillas por aplicación y tipo de texto** (`plantillas/<app>/<tipo>.typ`), con cabecera y pie propios.
- **Autoría fina:** hoy se sabe quién ha escrito en cada intervalo de unos segundos. Con
  `Y.PermanentUserData` se sabría letra a letra.
- **Expulsar a una persona** sin cerrar la sala para todo el mundo.
- **Pases asimétricos** (Ed25519): el editor solo podría comprobar pases, no fabricarlos. Conviene cuando
  lo usen aplicaciones de otras personas.
- **Varias instancias** del editor (Hocuspocus tiene una extensión para repartir salas con Redis).
