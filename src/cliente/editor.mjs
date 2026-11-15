// El editor en el navegador. Cualquier aplicación lo usa igual: carga /cliente.js y llama a
//   EditorColaborativo.montar(elemento, opciones)
// (ver LEEME.md). Pinta, dentro del elemento:
//   - arriba, una barra con los botones de formato (Markdown o Typst, según el texto), «Comentar», el
//     botón de la vista Typst (encendida o apagada), «Previsualizar» y «PDF»;
//   - a la izquierda, el texto (CodeMirror), unido a la sala: lo que escribe cada persona llega a las demás
//     al momento, con su cursor y su nombre;
//   - a la derecha, si se enciende, el resultado compilado con Typst, que se pone al día poco después de
//     cada cambio. Apagado, no se ve ni se pide nada al servidor;
//   - los comentarios, como trozos de texto resaltados; al pulsar uno, sale su bocadillo con las respuestas;
//   - si la aplicación usa la biblioteca (opción «biblioteca»), los desplegables «Plantilla» y «Cabecera y
//     pie» y el cajón de fragmentos e imágenes (ver biblioteca.mjs).
//
// Sin colores de Markdown a propósito: pesan el doble y el resultado ya se ve en la vista Typst.

import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { EditorView, minimalSetup } from "codemirror";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import { ESTILOS_DE_BIBLIOTECA, arbol, camino, clienteDeBiblioteca, montarBiblioteca, referenciaDeImagen } from "./biblioteca.mjs";

// Milisegundos que espera la vista Typst desde el último cambio antes de pedir la compilación.
const ESPERA_DE_LA_VISTA = 1200;
// Minutos que se usa un pase para compilar antes de pedir otro (los pases duran 5).
const VIDA_DEL_PASE = 4;

// Botones de formato de cada lenguaje: [etiqueta, descripción, acción]. Las acciones son
//   ["envolver", antes, después, texto de ejemplo] · ["linea", prefijo] · ["insertar", texto].
const FORMATOS = {
  markdown: [
    ["B", "Negrita", ["envolver", "**", "**", "negrita"]],
    ["I", "Cursiva", ["envolver", "*", "*", "cursiva"]],
    ["H", "Título", ["linea", "## "]],
    ["•", "Lista", ["linea", "- "]],
    ["1.", "Lista numerada", ["linea", "1. "]],
    ["❝", "Cita", ["linea", "> "]],
    ["🔗", "Enlace", ["envolver", "[", "](https://)", "texto"]],
    ["</>", "Código", ["envolver", "`", "`", "código"]],
    ["▦", "Tabla", ["insertar", "\n| Columna | Columna |\n|---|---|\n|  |  |\n"]],
    ["―", "Separador", ["insertar", "\n---\n"]],
  ],
  typst: [
    ["B", "Negrita", ["envolver", "*", "*", "negrita"]],
    ["I", "Cursiva", ["envolver", "_", "_", "cursiva"]],
    ["H", "Título", ["linea", "== "]],
    ["•", "Lista", ["linea", "- "]],
    ["1.", "Lista numerada", ["linea", "+ "]],
    ["❝", "Cita", ["envolver", "#quote(block: true)[", "]", "cita"]],
    ["🔗", "Enlace", ["envolver", '#link("https://")[', "]", "texto"]],
    ["</>", "Código", ["envolver", "`", "`", "código"]],
    ["▦", "Tabla", ["insertar", "\n#table(columns: 2,\n  [Columna], [Columna],\n  [], [],\n)\n"]],
    ["―", "Separador", ["insertar", "\n#line(length: 100%)\n"]],
  ],
};

// Estilos propios del editor, con variables para que cada aplicación los adapte a su aspecto.
const ESTILOS = `
.ec{--ec-borde:rgba(127,127,127,.35);--ec-acento:#7c3aed;--ec-resalte:rgba(250,204,21,.35);--ec-fondo:Canvas;display:flex;flex-direction:column;gap:.4rem}
.ec-barra{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;border:1px solid var(--ec-borde);border-radius:.4rem;padding:.25rem}
.ec-barra button{min-width:2rem;border:1px solid transparent;border-radius:.3rem;background:none;color:inherit;padding:.15rem .45rem;font:inherit;cursor:pointer}
.ec-barra button:hover:not(:disabled){border-color:var(--ec-borde)}
.ec-barra button:disabled{opacity:.35;cursor:default}
.ec-barra button[aria-pressed=true]{background:var(--ec-acento);color:#fff}
.ec-separa{width:1px;align-self:stretch;background:var(--ec-borde);margin:0 .2rem}
.ec-hueco{flex:1}
.ec-aviso{border:1px solid #f59e0b;border-radius:.4rem;padding:.3rem .5rem;font-size:.85em}
.ec-cuerpo{display:grid;gap:.5rem;grid-template-columns:minmax(0,1fr)}
.ec-cuerpo.con-panel{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
@media (max-width:900px){.ec-cuerpo.con-panel{grid-template-columns:minmax(0,1fr)}}
.ec-texto{position:relative;border:1px solid var(--ec-borde);border-radius:.4rem;min-height:24rem}
.ec-texto .cm-editor{min-height:24rem;font-family:ui-monospace,monospace}
.ec-texto .cm-editor.cm-focused{outline:none}
.ec-panel{border:1px solid var(--ec-borde);border-radius:.4rem;padding:.4rem;overflow:auto;max-height:80vh}
.ec-panel img{width:100%;background:#fff;display:block}
.ec-estado{font-size:.8em;opacity:.75;margin-bottom:.3rem}
.ec-estado.error{color:#dc2626;opacity:1}
.ec-comentado{background:var(--ec-resalte);border-bottom:2px solid #eab308;cursor:pointer}
.ec-comentado.ec-activo{background:rgba(250,204,21,.65)}
.ec-burbuja{position:absolute;z-index:20;width:min(20rem,90%);background:var(--ec-fondo);border:1px solid #eab308;border-radius:.6rem;padding:.5rem;box-shadow:0 4px 14px rgba(0,0,0,.18);font-size:.85em}
.ec-burbuja::before{content:"";position:absolute;top:-.45rem;left:1rem;width:.8rem;height:.8rem;background:var(--ec-fondo);border-left:1px solid #eab308;border-top:1px solid #eab308;transform:rotate(45deg)}
.ec-burbuja p{margin:.15rem 0}
.ec-burbuja textarea{width:100%;box-sizing:border-box;min-height:3.2rem;font:inherit;color:inherit;background:none;border:1px solid var(--ec-borde);border-radius:.3rem;padding:.25rem}
.ec-burbuja .ec-botones{display:flex;gap:.3rem;justify-content:flex-end;margin-top:.3rem}
.ec-burbuja button{font:inherit;color:inherit;background:none;border:1px solid var(--ec-borde);border-radius:.3rem;padding:.1rem .45rem;cursor:pointer}
.ec-burbuja .ec-principal{background:var(--ec-acento);color:#fff;border-color:var(--ec-acento)}
.ec-quien{font-weight:600}
.ec-cuando{opacity:.6;font-size:.85em}
.ec-barra select{font:inherit;color:inherit;background:var(--ec-fondo);border:1px solid var(--ec-borde);border-radius:.3rem;padding:.1rem .2rem;max-width:12rem}
${ESTILOS_DE_BIBLIOTECA}`;

// Pone los estilos en la página una sola vez.
function ponerEstilos() {
  if (document.getElementById("ec-estilos")) return;
  const hoja = document.createElement("style");
  hoja.id = "ec-estilos";
  hoja.textContent = ESTILOS;
  document.head.append(hoja);
}

// Crea un elemento con su clase y su texto (atajo para pintar sin HTML a mano y sin riesgo de inyectar).
function crear(etiqueta, clase = "", texto = "") {
  const elemento = document.createElement(etiqueta);
  if (clase) elemento.className = clase;
  if (texto) elemento.textContent = texto;
  return elemento;
}

// Aplica un botón de formato al texto: envuelve lo seleccionado, pone un prefijo a cada línea o inserta.
function aplicarFormato(vista, [tipo, a, b, ejemplo]) {
  const { from, to } = vista.state.selection.main;
  if (tipo === "envolver") {
    const dentro = vista.state.sliceDoc(from, to) || ejemplo;
    vista.dispatch({ changes: { from, to, insert: a + dentro + b }, selection: { anchor: from + a.length, head: from + a.length + dentro.length } });
  } else if (tipo === "linea") {
    const cambios = [];
    for (let linea = vista.state.doc.lineAt(from); ; linea = vista.state.doc.line(linea.number + 1)) {
      cambios.push({ from: linea.from, insert: a });
      if (linea.to >= to || linea.number === vista.state.doc.lines) break;
    }
    vista.dispatch({ changes: cambios });
  } else {
    vista.dispatch({ changes: { from, to, insert: a }, selection: { anchor: from + a.length } });
  }
  vista.focus();
}

// Explica en lenguaje llano por qué el servidor no deja entrar en una sala, a partir del motivo que manda
// (servidor.mjs, rechazo): «pase: …» si el pase no vale; «aplicacion: …» si la aplicación no da el texto.
//   - motivo: el texto que llega con el rechazo (puede faltar en servidores viejos).
function explicarRechazo(motivo = "") {
  const [clase, ...resto] = String(motivo).split(": ");
  const detalle = resto.join(": ");
  if (clase === "aplicacion") {
    return `El editor no consigue el texto de la aplicación (${detalle}). No es cosa de tu permiso: avisa a quien mantiene la plataforma.`;
  }
  if (clase === "pase") return `No puedes entrar en este texto: ${detalle} Recarga la página para pedir un pase nuevo.`;
  return "No puedes entrar en este texto (el pase no vale o ha caducado). Recarga la página.";
}

// Monta el editor dentro de un elemento de la página. Devuelve { vista, proveedor, destruir }.
//   - url: dirección WebSocket del servidor («ws://localhost:1234»); la HTTP se saca de ella.
//   - sala: nombre completo de la sala («asambleas/documentos.documento:12»).
//   - pase: el pase firmado (texto). pedirPase(): función que devuelve uno nuevo (promesa); se usa al
//     reconectar y para compilar cuando el primero ya es viejo.
//   - alias, color: cómo se ve a esta persona (cursores y comentarios).
//   - permiso: «leer», «comentar» o «escribir».
//   - formato: «markdown» (de partida) o «typst»: qué botones salen.
//   - biblioteca: true si el pase trae usuario y ámbitos (salen la plantilla, la cabecera y pie, los
//     fragmentos y las imágenes).
//   - alCambiar(texto), alPersonas(lista), alEstado(estado): avisos para la aplicación (opcionales).
function montar(elemento, opciones) {
  const { url, sala, alias, color = "#7c3aed", formato = "markdown", alCambiar, alPersonas, alEstado } = opciones;
  let permiso = opciones.permiso || "leer";
  const http = url.replace(/^ws/, "http");
  ponerEstilos();

  // ── Pases: el primero viene en la página; después se piden ──
  let pase = opciones.pase;
  let paseDesde = Date.now();
  let primero = true;
  async function paseFresco() {
    if (Date.now() - paseDesde > VIDA_DEL_PASE * 60000 && opciones.pedirPase) {
      pase = await opciones.pedirPase();
      paseDesde = Date.now();
    }
    return pase;
  }
  async function paseParaConectar() {
    if (primero) {
      primero = false;
      return pase;
    }
    paseDesde = 0;
    return paseFresco();
  }

  // ── Conexión: una sola para el texto y para sus comentarios ──
  const socket = new HocuspocusProviderWebsocket({ url });
  const proveedor = new HocuspocusProvider({ websocketProvider: socket, name: sala, token: paseParaConectar });
  const deComentarios = new HocuspocusProvider({ websocketProvider: socket, name: `${sala}#comentarios`, token: paseFresco });
  const texto = proveedor.document.getText("texto");
  const comentarios = deComentarios.document.getArray("comentarios");
  proveedor.awareness.setLocalStateField("user", { name: alias, color, colorLight: `${color}33` });

  // ── Esqueleto de la pantalla ──
  const raiz = crear("div", "ec");
  const barra = crear("div", "ec-barra");
  barra.setAttribute("role", "toolbar");
  barra.setAttribute("aria-label", "Formato y vista");
  const aviso = crear("div", "ec-aviso");
  aviso.hidden = true;
  const cuerpo = crear("div", "ec-cuerpo");
  const cajaDeTexto = crear("div", "ec-texto");
  const panel = crear("div", "ec-panel");
  panel.hidden = true;
  const estadoDelPanel = crear("div", "ec-estado");
  const imagen = crear("img");
  imagen.alt = "Resultado compilado con Typst";
  panel.append(estadoDelPanel, imagen);
  cuerpo.append(cajaDeTexto, panel);
  raiz.append(barra, aviso, cuerpo);
  elemento.replaceChildren(raiz);

  // ── El texto (CodeMirror) ──
  const soloLectura = new Compartment();
  const refrescar = StateEffect.define();
  let activo = null; // id del comentario abierto
  let nuevo = null; // { desde, hasta } del comentario que se está escribiendo

  // Posición actual (número) de una posición relativa de Yjs guardada en un comentario.
  function posicion(json) {
    const absoluta = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), proveedor.document);
    return absoluta ? absoluta.index : null;
  }
  // Los comentarios sin resolver, con su trozo de texto actual.
  function abiertos() {
    return comentarios
      .toArray()
      .filter((c) => !c.get("resuelto"))
      .map((c) => ({ c, desde: posicion(c.get("desde")), hasta: posicion(c.get("hasta")) }))
      .filter(({ desde, hasta }) => desde !== null && hasta !== null && hasta > desde)
      .sort((x, y) => x.desde - y.desde);
  }
  // Resalta los trozos comentados.
  const resaltes = ViewPlugin.fromClass(
    class {
      constructor() {
        this.decorations = this.calcular();
      }
      calcular() {
        const marcas = abiertos().map(({ c, desde, hasta }) =>
          Decoration.mark({ class: c.get("id") === activo ? "ec-comentado ec-activo" : "ec-comentado", attributes: { "data-comentario": c.get("id") } }).range(desde, hasta),
        );
        return Decoration.set(marcas, true);
      }
      update(cambio) {
        if (cambio.docChanged || cambio.transactions.some((t) => t.effects.some((e) => e.is(refrescar)))) this.decorations = this.calcular();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const vista = new EditorView({
    parent: cajaDeTexto,
    state: EditorState.create({
      doc: texto.toString(),
      extensions: [
        minimalSetup,
        EditorView.lineWrapping,
        yCollab(texto, proveedor.awareness),
        soloLectura.of(EditorState.readOnly.of(permiso !== "escribir")),
        resaltes,
        EditorView.updateListener.of((cambio) => {
          if (cambio.docChanged) {
            alCambiar?.(cambio.state.doc.toString());
            vistaTypst.cambio();
          }
          if (cambio.docChanged || cambio.selectionSet || cambio.viewportChanged) colocarBurbuja();
          botonComentar.disabled = !puedeComentar() || cambio.state.selection.main.empty;
        }),
        EditorView.domEventHandlers({
          // Al pulsar un trozo comentado se abre su bocadillo; al pulsar en otro sitio, se cierra.
          click(evento) {
            const marca = evento.target.closest?.("[data-comentario]");
            abrirComentario(marca ? marca.dataset.comentario : null);
          },
        }),
      ],
    }),
  });

  // ── Barra: formato ──
  const botonesDeFormato = [];
  for (const [etiqueta, descripcion, accion] of FORMATOS[formato] || FORMATOS.markdown) {
    const boton = crear("button", "", etiqueta);
    boton.type = "button";
    boton.title = descripcion;
    boton.setAttribute("aria-label", descripcion);
    if (etiqueta === "B") boton.style.fontWeight = "700";
    if (etiqueta === "I") boton.style.fontStyle = "italic";
    boton.addEventListener("click", () => aplicarFormato(vista, accion));
    botonesDeFormato.push(boton);
    barra.append(boton);
  }
  barra.append(crear("span", "ec-separa"));
  const botonComentar = crear("button", "", "💬 Comentar");
  botonComentar.type = "button";
  botonComentar.title = "Comenta el trozo seleccionado";
  botonComentar.disabled = true;
  botonComentar.addEventListener("click", () => {
    const { from, to } = vista.state.selection.main;
    if (from === to) return;
    nuevo = { desde: from, hasta: to };
    activo = null;
    pintarBurbuja();
  });
  const botonSiguiente = crear("button", "", "↓ 💬");
  botonSiguiente.type = "button";
  botonSiguiente.title = "Ir al comentario siguiente";
  botonSiguiente.addEventListener("click", () => {
    const lista = abiertos();
    if (!lista.length) return;
    const actual = lista.findIndex(({ c }) => c.get("id") === activo);
    const siguiente = lista[(actual + 1) % lista.length];
    vista.dispatch({ effects: EditorView.scrollIntoView(siguiente.desde, { y: "center" }) });
    abrirComentario(siguiente.c.get("id"));
  });
  barra.append(botonComentar, botonSiguiente, crear("span", "ec-hueco"));

  // ── Barra: vista Typst, previsualizar y PDF ──
  const botonVista = crear("button", "", "Vista Typst");
  botonVista.type = "button";
  botonVista.title = "Enciende o apaga el resultado al lado (apagado no gasta nada)";
  botonVista.setAttribute("aria-pressed", "false");
  const botonPrevia = crear("button", "", "Previsualizar");
  botonPrevia.type = "button";
  botonPrevia.title = "Compila una vez para ver cómo queda";
  const botonPdf = crear("button", "", "PDF");
  botonPdf.type = "button";
  botonPdf.title = "Descarga el PDF";
  barra.append(botonVista, botonPrevia, botonPdf);

  // ── Biblioteca: plantilla, cabecera y pie, fragmentos e imágenes ──
  // Lo elegido se guarda en la sala (mapa «opciones»): lo ven todas las personas y lo cambia quien escribe.
  const elegidos = proveedor.document.getMap("opciones");
  const api = opciones.biblioteca ? clienteDeBiblioteca(http, paseFresco) : null;
  let biblioteca = null; // lo leído de la biblioteca (GET /biblioteca)
  const desplegables = {};
  const cajon = crear("div", "ec-cajon");
  cajon.hidden = true;
  cajon.setAttribute("aria-label", "Fragmentos e imágenes");
  const botonCajon = crear("button", "", "📚 Fragmentos e imágenes");
  botonCajon.type = "button";
  botonCajon.title = "Mete en el texto trozos de la enciclopedia de fragmentos o imágenes";
  botonCajon.setAttribute("aria-pressed", "false");
  if (api) {
    barra.insertBefore(crear("span", "ec-separa"), botonComentar);
    for (const [clase, etiqueta, sinNada] of [["plantilla", "Plantilla", "Sin plantilla"], ["membrete", "Cabecera y pie", "Sin cabecera ni pie"]]) {
      const lista = crear("select");
      lista.title = etiqueta;
      lista.setAttribute("aria-label", etiqueta);
      lista.dataset.sinNada = sinNada;
      lista.addEventListener("change", () => elegir(clase, lista.value));
      desplegables[clase] = lista;
      barra.insertBefore(lista, botonComentar);
    }
    barra.insertBefore(botonCajon, botonComentar);
    raiz.insertBefore(cajon, cuerpo);
  }

  // Pinta los dos desplegables con lo que la persona ve, agrupado por carpetas, y lo elegido en la sala.
  function pintarDesplegables() {
    for (const [clase, lista] of Object.entries(desplegables)) {
      const actual = elegidos.get(clase) || "";
      lista.replaceChildren(new Option(lista.dataset.sinNada, ""));
      const grupos = new Map();
      for (const elemento of biblioteca?.elementos.filter((e) => e.clase === clase) || []) {
        const sitio = camino(biblioteca.carpetas, elemento.carpeta);
        if (!grupos.has(sitio)) grupos.set(sitio, crear("optgroup"));
        grupos.get(sitio).label = sitio;
        grupos.get(sitio).append(new Option(elemento.nombre, elemento.id));
      }
      lista.append(...grupos.values());
      if (actual && !lista.querySelector(`option[value="${actual}"]`)) lista.append(new Option("(una que no puedes ver)", actual));
      lista.value = actual;
    }
  }

  // Elige una plantilla o una cabecera y pie para el texto. Si es una plantilla con texto de partida y el
  // texto está vacío (y en el mismo formato), lo pone.
  function elegir(clase, id) {
    if (permiso !== "escribir") return pintarDesplegables();
    proveedor.document.transact(() => {
      if (id) elegidos.set(clase, id);
      else elegidos.delete(clase);
      const plantilla = clase === "plantilla" && biblioteca?.elementos.find((e) => e.id === id);
      if (plantilla?.datos.texto && !texto.length && (plantilla.datos.formato || "markdown") === formato) texto.insert(0, plantilla.datos.texto);
    });
  }

  // Mete un trozo de texto donde está el cursor (o en lugar de lo seleccionado).
  function meter(trozo) {
    if (permiso !== "escribir") return;
    const { from, to } = vista.state.selection.main;
    vista.dispatch({ changes: { from, to, insert: trozo }, selection: { anchor: from + trozo.length } });
    vista.focus();
  }

  // Pinta el cajón: el árbol de fragmentos y el de imágenes; al pulsar uno, se mete en el texto.
  function pintarCajon() {
    const columna = (titulo, contenido) => {
      const caja = crear("div");
      caja.append(crear("strong", "", titulo), contenido);
      return caja;
    };
    cajon.replaceChildren(
      columna("Fragmentos", arbol(biblioteca, "fragmento", { alElegir: (e) => meter(e.datos.texto) })),
      columna("Imágenes", arbol(biblioteca, "imagen", { alElegir: (e) => meter(referenciaDeImagen(e, formato)), miniatura: (e) => `${http}/biblioteca/imagenes/${e.id}?pase=${encodeURIComponent(pase)}` })),
    );
  }

  // Lee la biblioteca y pinta los desplegables (y el cajón, si está abierto). Si falla, lo dice en el cajón.
  async function cargarBiblioteca() {
    try {
      biblioteca = await api("GET", "");
    } catch (error) {
      biblioteca = null;
      cajon.replaceChildren(crear("p", "ec-mensaje error", `La biblioteca no responde: ${error.message}`));
    }
    pintarDesplegables();
    if (biblioteca && !cajon.hidden) pintarCajon();
  }
  botonCajon.addEventListener("click", () => {
    cajon.hidden = !cajon.hidden;
    botonCajon.setAttribute("aria-pressed", String(!cajon.hidden));
    if (!cajon.hidden) cargarBiblioteca();
  });
  // Si alguien cambia la plantilla o la cabecera y pie: desplegables al día y la vista Typst se recompila.
  elegidos.observe(() => {
    pintarDesplegables();
    vistaTypst.cambio();
  });
  if (api) cargarBiblioteca();

  // La vista Typst: encendida, compila poco después de cada cambio; apagada, nada.
  const vistaTypst = {
    encendida: false,
    reloj: null,
    url: null,
    // Pide la compilación y la pinta. Si falla, deja la anterior y enseña el error.
    async compilar() {
      panel.hidden = false;
      cuerpo.classList.add("con-panel");
      estadoDelPanel.className = "ec-estado";
      estadoDelPanel.textContent = "Compilando…";
      try {
        const respuesta = await fetch(`${http}/render`, { method: "POST", body: new URLSearchParams({ pase: await paseFresco() }) });
        const contenido = await respuesta.text();
        if (!respuesta.ok) throw new Error(contenido);
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(new Blob([contenido], { type: "image/svg+xml" }));
        imagen.src = this.url;
        estadoDelPanel.textContent = this.encendida ? "Al día" : "Vista previa (no se pone al día sola)";
      } catch (error) {
        estadoDelPanel.className = "ec-estado error";
        estadoDelPanel.textContent = `No se ha podido compilar: ${error.message}`;
      }
    },
    // Tras un cambio del texto: si está encendida, compila cuando se deja de escribir un momento.
    cambio() {
      if (!this.encendida) return;
      clearTimeout(this.reloj);
      this.reloj = setTimeout(() => this.compilar(), ESPERA_DE_LA_VISTA);
    },
    // Enciende o apaga. Apagada, se esconde el panel y no se pide nada.
    cambiar() {
      this.encendida = !this.encendida;
      botonVista.setAttribute("aria-pressed", String(this.encendida));
      clearTimeout(this.reloj);
      if (this.encendida) this.compilar();
      else {
        panel.hidden = true;
        cuerpo.classList.remove("con-panel");
      }
    },
  };
  botonVista.addEventListener("click", () => vistaTypst.cambiar());
  botonPrevia.addEventListener("click", () => vistaTypst.compilar());
  botonPdf.addEventListener("click", async () => {
    window.location.href = `${http}/pdf?pase=${encodeURIComponent(await paseFresco())}`;
  });

  // ── Comentarios: el bocadillo ──
  const burbuja = crear("div", "ec-burbuja");
  burbuja.hidden = true;
  burbuja.setAttribute("role", "dialog");
  cajaDeTexto.append(burbuja);
  let campoAbierto = null; // el cuadro de escribir del bocadillo (se conserva al refrescar)

  // Dice si quien mira puede comentar.
  function puedeComentar() {
    return permiso === "escribir" || permiso === "comentar";
  }
  // Abre el bocadillo de un comentario (o lo cierra, con null).
  function abrirComentario(id) {
    if (id === activo && !nuevo) return;
    activo = id;
    nuevo = null;
    campoAbierto = null;
    vista.dispatch({ effects: refrescar.of(null) });
    pintarBurbuja();
  }
  // Busca un comentario por su id.
  function comentarioPorId(id) {
    return comentarios.toArray().find((c) => c.get("id") === id);
  }
  // Una línea del hilo: quién, cuándo y qué.
  function lineaDelHilo(quien, colorDeQuien, cuando, que) {
    const linea = crear("p");
    const nombre = crear("span", "ec-quien", quien);
    nombre.style.color = colorDeQuien || "inherit";
    linea.append(nombre, " ", crear("span", "ec-cuando", new Date(cuando).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })), crear("br"), que);
    return linea;
  }
  // Cuadro de escribir con sus botones.
  function campo(textoDelBoton, alEnviar) {
    const zona = crear("div");
    const cuadro = crear("textarea");
    cuadro.setAttribute("aria-label", textoDelBoton);
    const botones = crear("div", "ec-botones");
    const enviar = crear("button", "ec-principal", textoDelBoton);
    enviar.type = "button";
    enviar.addEventListener("click", () => cuadro.value.trim() && alEnviar(cuadro.value.trim()));
    const cerrar = crear("button", "", "Cerrar");
    cerrar.type = "button";
    cerrar.addEventListener("click", () => abrirComentario(null));
    botones.append(cerrar, enviar);
    zona.append(cuadro, botones);
    return zona;
  }
  // Pinta el bocadillo: el hilo del comentario abierto, o el cuadro de uno nuevo.
  function pintarBurbuja() {
    if (!activo && !nuevo) {
      burbuja.hidden = true;
      return;
    }
    const escrito = campoAbierto?.querySelector("textarea")?.value || "";
    burbuja.replaceChildren();
    if (nuevo) {
      burbuja.append(crear("p", "ec-quien", "Comentario nuevo"));
      campoAbierto = campo("Comentar", (contenido) => {
        const mapa = new Y.Map();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        mapa.set("id", id);
        mapa.set("desde", Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(texto, nuevo.desde)));
        mapa.set("hasta", Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(texto, nuevo.hasta)));
        mapa.set("alias", alias);
        mapa.set("color", color);
        mapa.set("texto", contenido);
        mapa.set("cuando", Date.now());
        mapa.set("resuelto", false);
        mapa.set("respuestas", new Y.Array());
        comentarios.push([mapa]);
        nuevo = null;
        abrirComentario(id);
      });
    } else {
      const comentario = comentarioPorId(activo);
      if (!comentario) {
        activo = null;
        burbuja.hidden = true;
        return;
      }
      burbuja.append(lineaDelHilo(comentario.get("alias"), comentario.get("color"), comentario.get("cuando"), comentario.get("texto")));
      for (const respuesta of comentario.get("respuestas").toArray()) {
        burbuja.append(lineaDelHilo(respuesta.alias, respuesta.color, respuesta.cuando, respuesta.texto));
      }
      if (puedeComentar()) {
        campoAbierto = campo("Responder", (contenido) => {
          comentario.get("respuestas").push([{ alias, color, texto: contenido, cuando: Date.now() }]);
          campoAbierto.querySelector("textarea").value = "";
        });
        const resolver = crear("button", "", "✓ Resuelto");
        resolver.type = "button";
        resolver.title = "Quita el resalte (el comentario se guarda)";
        resolver.addEventListener("click", () => {
          comentario.set("resuelto", true);
          abrirComentario(null);
        });
        campoAbierto.querySelector(".ec-botones").prepend(resolver);
      } else {
        campoAbierto = campo("Responder", () => {});
        campoAbierto.querySelector("textarea").remove();
        campoAbierto.querySelector(".ec-principal").remove();
      }
    }
    campoAbierto.querySelector("textarea") && (campoAbierto.querySelector("textarea").value = escrito);
    burbuja.append(campoAbierto);
    burbuja.hidden = false;
    colocarBurbuja();
  }
  // Coloca el bocadillo justo debajo del principio del trozo comentado.
  function colocarBurbuja() {
    if (burbuja.hidden) return;
    const comentario = activo ? abiertos().find(({ c }) => c.get("id") === activo) : null;
    const desde = nuevo ? nuevo.desde : comentario?.desde;
    if (desde === undefined) return;
    vista.requestMeasure({
      read: () => ({ punto: vista.coordsAtPos(desde), caja: cajaDeTexto.getBoundingClientRect() }),
      write: ({ punto, caja }) => {
        if (!punto) return;
        burbuja.style.top = `${punto.bottom - caja.top + 8}px`;
        burbuja.style.left = `${Math.max(0, Math.min(punto.left - caja.left - 16, caja.width - burbuja.offsetWidth))}px`;
      },
    });
  }
  // Cuando cambian los comentarios (también los de otras personas): resaltes y bocadillo al día.
  comentarios.observeDeep(() => {
    vista.dispatch({ effects: refrescar.of(null) });
    if (activo) pintarBurbuja();
  });

  // ── Permiso: botones y solo lectura ──
  function aplicarPermiso() {
    for (const boton of botonesDeFormato) boton.disabled = permiso !== "escribir";
    for (const lista of Object.values(desplegables)) lista.disabled = permiso !== "escribir";
    vista.dispatch({ effects: soloLectura.reconfigure(EditorState.readOnly.of(permiso !== "escribir")) });
  }
  aplicarPermiso();

  // ── Avisos del servidor ──
  proveedor.on("stateless", ({ payload }) => {
    const mensaje = JSON.parse(payload);
    if (mensaje.tipo === "lleno") {
      permiso = mensaje.permiso;
      aplicarPermiso();
      aviso.textContent = `Ya hay ${mensaje.limite} personas con este permiso en el texto (el máximo): entras a leer. Recarga la página más tarde para volver a intentarlo.`;
      aviso.hidden = false;
    }
  });
  proveedor.on("authenticationFailed", ({ reason } = {}) => {
    aviso.textContent = explicarRechazo(reason);
    aviso.hidden = false;
  });
  proveedor.on("synced", () => alCambiar?.(texto.toString()));
  proveedor.on("status", ({ status }) => alEstado?.(status));
  proveedor.awareness.on("change", () => alPersonas?.([...proveedor.awareness.getStates().values()].map((estado) => estado.user).filter(Boolean)));

  return {
    vista,
    proveedor,
    // Desconecta y quita el editor de la página (al salir de la pantalla).
    destruir() {
      clearTimeout(vistaTypst.reloj);
      if (vistaTypst.url) URL.revokeObjectURL(vistaTypst.url);
      deComentarios.destroy();
      proveedor.destroy();
      socket.destroy();
      vista.destroy();
    },
  };
}

window.EditorColaborativo = { montar, montarBiblioteca };
