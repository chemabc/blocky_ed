// La biblioteca en el navegador (ver src/biblioteca.mjs para las reglas).
//
// Dos usos:
//   - dentro del editor de un texto (editor.mjs): los desplegables «Plantilla» y «Cabecera y pie», y el
//     cajón con los fragmentos y las imágenes que se meten con un clic;
//   - la pantalla de la biblioteca, EditorColaborativo.montarBiblioteca(elemento, opciones): el árbol de
//     carpetas de una clase (plantillas, fragmentos, cabeceras y pies o imágenes) y, al lado, la ficha de
//     lo elegido para crearlo, cambiarlo, compartirlo o borrarlo.
// Todo se pide al servidor del editor con el pase en la cabecera «Authorization».

// Nombres de cada clase para las personas: [plural, singular, «nueva/nuevo»].
export const NOMBRES = {
  plantilla: ["Plantillas", "plantilla", "Nueva plantilla"],
  fragmento: ["Fragmentos", "fragmento", "Nuevo fragmento"],
  membrete: ["Cabeceras y pies", "cabecera y pie", "Nueva cabecera y pie"],
  imagen: ["Imágenes", "imagen", "Subir imagen"],
};

// Estilos de la biblioteca (se suman a los del editor; mismas variables).
export const ESTILOS_DE_BIBLIOTECA = `
.ec-cajon{border:1px solid var(--ec-borde);border-radius:.4rem;padding:.4rem;display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));max-height:16rem;overflow:auto}
.ec-arbol{font-size:.9em}
.ec-arbol details{margin-left:.6rem}
.ec-arbol summary{cursor:pointer;padding:.1rem 0}
.ec-arbol button.ec-hoja{display:flex;align-items:center;gap:.35rem;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:.3rem;color:inherit;font:inherit;padding:.1rem .3rem;cursor:pointer;margin-left:.6rem}
.ec-arbol button.ec-hoja:hover,.ec-arbol button.ec-hoja[aria-current=true],.ec-arbol summary[aria-current=true]{border-color:var(--ec-acento)}
.ec-arbol img{width:1.6rem;height:1.6rem;object-fit:contain;background:#fff;border-radius:.2rem}
.ec-vacio{opacity:.65;font-size:.9em}
.ec-biblio{display:grid;gap:.8rem;grid-template-columns:minmax(14rem,1fr) minmax(0,2fr)}
@media (max-width:800px){.ec-biblio{grid-template-columns:minmax(0,1fr)}}
.ec-biblio > section{border:1px solid var(--ec-borde);border-radius:.4rem;padding:.6rem;min-width:0}
.ec-ficha{display:flex;flex-direction:column;gap:.5rem}
.ec-ficha label{display:flex;flex-direction:column;gap:.15rem;font-size:.9em}
.ec-ficha input,.ec-ficha select,.ec-ficha textarea{font:inherit;color:inherit;background:var(--ec-fondo);border:1px solid var(--ec-borde);border-radius:.3rem;padding:.3rem}
.ec-ficha textarea{font-family:ui-monospace,monospace;min-height:8rem}
.ec-ficha .ec-botones{display:flex;flex-wrap:wrap;gap:.4rem}
.ec-ficha button,.ec-biblio .ec-acciones button{font:inherit;color:inherit;background:none;border:1px solid var(--ec-borde);border-radius:.3rem;padding:.2rem .6rem;cursor:pointer}
.ec-ficha button.ec-principal{background:var(--ec-acento);color:#fff;border-color:var(--ec-acento)}
.ec-ficha button.ec-peligro{border-color:#dc2626;color:#dc2626}
.ec-acciones{display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.5rem}
.ec-fichas{display:flex;flex-wrap:wrap;gap:.3rem}
.ec-fichas span{border:1px solid var(--ec-borde);border-radius:1rem;padding:.05rem .5rem;font-size:.85em}
.ec-fichas button{border:none;padding:0 .2rem;background:none;color:inherit;cursor:pointer}
.ec-mensaje{font-size:.85em}
.ec-mensaje.error{color:#dc2626}
.ec-previa{background:#fff;width:100%;border:1px solid var(--ec-borde)}
`;

// Crea un elemento con su clase y su texto (sin HTML a mano: nada de lo escrito se interpreta).
function crear(etiqueta, clase = "", texto = "") {
  const elemento = document.createElement(etiqueta);
  if (clase) elemento.className = clase;
  if (texto) elemento.textContent = texto;
  return elemento;
}

// Prepara las llamadas a la biblioteca de un servidor con un pase que se renueva.
//   - http: la dirección HTTP del editor.
//   - paseFresco(): promesa con un pase que aún vale.
// Devuelve api(metodo, camino, cuerpo) → lo respondido (JSON o texto); lanza un error con el mensaje del
// servidor si algo falla.
export function clienteDeBiblioteca(http, paseFresco) {
  return async function api(metodo, camino, cuerpo) {
    const binario = cuerpo instanceof Blob;
    const respuesta = await fetch(`${http}/biblioteca${camino}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await paseFresco()}`, ...(cuerpo && !binario ? { "Content-Type": "application/json" } : {}) },
      body: cuerpo === undefined ? undefined : binario ? cuerpo : JSON.stringify(cuerpo),
    });
    const tipo = respuesta.headers.get("content-type") || "";
    const contenido = tipo.includes("json") ? await respuesta.json() : await respuesta.text();
    if (!respuesta.ok) throw new Error(typeof contenido === "string" ? contenido : "La biblioteca no responde.");
    return contenido;
  };
}

// El camino de una carpeta, de arriba abajo («Actas / ORG Ebro»).
export function camino(carpetas, id) {
  const porId = new Map(carpetas.map((c) => [c.id, c]));
  const nombres = [];
  for (let actual = porId.get(id); actual; actual = porId.get(actual.padre)) nombres.unshift(actual.nombre);
  return nombres.join(" / ");
}

// Pinta el árbol de una clase: carpetas plegables (abiertas las de primer nivel) con sus elementos dentro.
//   - vista: lo que devuelve GET /biblioteca.
//   - alElegir(elemento): al pulsar un elemento. alElegirCarpeta(carpeta) (opcional): al pulsar una carpeta.
//   - miniatura(elemento) (opcional): dirección de la imagen pequeña de cada imagen.
//   - elegido: id de lo que se marca como elegido.
export function arbol(vista, clase, { alElegir, alElegirCarpeta, miniatura, elegido } = {}) {
  const raiz = crear("div", "ec-arbol");
  const carpetas = vista.carpetas.filter((c) => c.clase === clase);
  const elementos = vista.elementos.filter((e) => e.clase === clase);
  // Pinta lo que cuelga de una carpeta (o del primer nivel, con null).
  const rama = (padre, dentro) => {
    for (const carpeta of carpetas.filter((c) => (c.padre || null) === padre)) {
      const pliegue = crear("details");
      pliegue.open = padre === null || carpeta.id === elegido;
      const titulo = crear("summary", "", `📁 ${carpeta.nombre}`);
      titulo.dataset.carpeta = carpeta.id;
      if (carpeta.id === elegido) titulo.setAttribute("aria-current", "true");
      if (alElegirCarpeta) titulo.addEventListener("click", () => alElegirCarpeta(carpeta));
      pliegue.append(titulo);
      rama(carpeta.id, pliegue);
      dentro.append(pliegue);
    }
    for (const elemento of elementos.filter((e) => e.carpeta === padre)) {
      const hoja = crear("button", "ec-hoja");
      hoja.type = "button";
      hoja.dataset.elemento = elemento.id;
      if (elemento.id === elegido) hoja.setAttribute("aria-current", "true");
      if (miniatura) {
        const imagen = crear("img");
        imagen.alt = "";
        imagen.loading = "lazy";
        imagen.src = miniatura(elemento);
        hoja.append(imagen);
      }
      hoja.append(elemento.nombre);
      hoja.addEventListener("click", () => alElegir?.(elemento));
      dentro.append(hoja);
    }
  };
  rama(null, raiz);
  if (!raiz.childElementCount) raiz.append(crear("p", "ec-vacio", "No hay nada todavía."));
  return raiz;
}

// Lo que se escribe en el texto para poner una imagen de la biblioteca, según el formato.
export function referenciaDeImagen(elemento, formato) {
  return formato === "typst" ? `#image("/imagenes/${elemento.id}", width: 50%)` : `![${elemento.nombre}](imagen:${elemento.id})`;
}

// Pinta la pantalla de la biblioteca para una clase dentro de un elemento de la página.
//   - url: dirección WebSocket del editor (la HTTP se saca de ella).
//   - pase, pedirPase(): como en montar() (el pase lleva usuario y ámbitos).
//   - clase: «plantilla», «fragmento», «membrete» o «imagen».
//   - buscarPersonas(texto) (opcional): promesa con [{ id, nombre }] para compartir con personas sueltas
//     (la da la aplicación, que es la que conoce a las personas).
export function montarBiblioteca(elemento, opciones) {
  const { url, clase, buscarPersonas } = opciones;
  const http = url.replace(/^ws/, "http");
  let pase = opciones.pase;
  let paseDesde = Date.now();
  // Un pase que aún vale: el de la página durante 4 minutos; después, uno nuevo.
  async function paseFresco() {
    if (Date.now() - paseDesde > 4 * 60000 && opciones.pedirPase) {
      pase = await opciones.pedirPase();
      paseDesde = Date.now();
    }
    return pase;
  }
  const api = clienteDeBiblioteca(http, paseFresco);
  if (!document.getElementById("ec-estilos-biblioteca")) {
    const hoja = crear("style");
    hoja.id = "ec-estilos-biblioteca";
    hoja.textContent = `.ec-biblio{--ec-borde:rgba(127,127,127,.35);--ec-acento:#7c3aed;--ec-fondo:Canvas}${ESTILOS_DE_BIBLIOTECA}`;
    document.head.append(hoja);
  }

  const raiz = crear("div", "ec-biblio");
  const izquierda = crear("section");
  izquierda.setAttribute("aria-label", NOMBRES[clase][0]);
  const derecha = crear("section", "ec-ficha");
  derecha.setAttribute("aria-label", "Ficha");
  raiz.append(izquierda, derecha);
  elemento.replaceChildren(raiz);

  let vista = null; // lo último leído de la biblioteca
  let elegido = null; // { tipo: "carpeta" | "elemento", id } o { tipo: "nuevo", carpeta } o { tipo: "carpeta-nueva", padre }

  // Nombre de un ámbito (o «compartido contigo» si no es de los tuyos).
  const nombreDeAmbito = (id) => vista.ambitos.find((a) => a.id === id)?.nombre || "compartido contigo";
  // Ámbitos en los que la persona puede poner cosas (sin el personal, si no vale para esto).
  const ambitosPropios = (personal) => vista.ambitos.filter((a) => a.cambiar && (personal || a.id !== vista.yo));
  // La carpeta en la que se está (la elegida o la del elemento elegido), o null.
  function carpetaActual() {
    if (!elegido) return null;
    if (elegido.tipo === "carpeta") return elegido.id;
    if (elegido.tipo === "elemento") return vista.elementos.find((e) => e.id === elegido.id)?.carpeta || null;
    return elegido.carpeta || elegido.padre || null;
  }

  // Lee la biblioteca y lo vuelve a pintar todo.
  async function recargar() {
    try {
      vista = await api("GET", "");
    } catch (error) {
      izquierda.replaceChildren(crear("p", "ec-mensaje error", error.message));
      derecha.replaceChildren();
      return;
    }
    pintar();
  }

  // Pinta el árbol con sus botones y la ficha de lo elegido.
  function pintar() {
    const acciones = crear("div", "ec-acciones");
    const enCarpeta = carpetaActual();
    const nuevaCarpeta = crear("button", "", enCarpeta ? "📁 Nueva subcarpeta" : "📁 Nueva carpeta");
    nuevaCarpeta.type = "button";
    nuevaCarpeta.addEventListener("click", () => elegir({ tipo: "carpeta-nueva", padre: enCarpeta }));
    acciones.append(nuevaCarpeta);
    if (enCarpeta) {
      const nuevo = crear("button", "", `＋ ${NOMBRES[clase][2]}`);
      nuevo.type = "button";
      nuevo.addEventListener("click", () => elegir({ tipo: "nuevo", carpeta: enCarpeta }));
      acciones.append(nuevo);
    }
    const marcado = elegido?.tipo === "carpeta" || elegido?.tipo === "elemento" ? elegido.id : null;
    izquierda.replaceChildren(
      acciones,
      arbol(vista, clase, {
        elegido: marcado,
        alElegir: (e) => elegir({ tipo: "elemento", id: e.id }),
        alElegirCarpeta: (c) => elegir({ tipo: "carpeta", id: c.id }),
        miniatura: clase === "imagen" ? (e) => `${http}/biblioteca/imagenes/${e.id}?pase=${encodeURIComponent(pase)}` : null,
      }),
    );
    if (vista.raices && ["plantilla", "fragmento"].includes(clase)) izquierda.append(crear("p", "ec-vacio", `Carpetas de primer nivel permitidas aquí: ${vista.raices.join(", ")}.`));
    pintarFicha();
  }

  // Elige algo y lo pinta.
  function elegir(nuevo) {
    elegido = nuevo;
    pintar();
  }

  // Un campo de la ficha: etiqueta y control.
  function campo(etiqueta, control) {
    const caja = crear("label", "", etiqueta);
    caja.append(control);
    return caja;
  }
  // Desplegable con opciones [valor, texto].
  function desplegable(opcionesDelDesplegable, valor) {
    const lista = crear("select");
    for (const [clave, texto] of opcionesDelDesplegable) {
      const opcion = crear("option", "", texto);
      opcion.value = clave;
      lista.append(opcion);
    }
    lista.value = valor;
    return lista;
  }
  // Cuadro de texto largo.
  function cuadro(valor, filas = 8) {
    const area = crear("textarea");
    area.value = valor || "";
    area.rows = filas;
    area.spellcheck = false;
    return area;
  }

  // Lista de compartir: fichas con ✕ y, si se puede cambiar, para añadir ámbitos y personas.
  //   Devuelve { nodo, lista() }.
  function compartir(inicial, editable) {
    let lista = [...inicial];
    const nodo = crear("div");
    const fichas = crear("div", "ec-fichas");
    const pintarFichas = () => {
      fichas.replaceChildren();
      if (!lista.length) fichas.append(crear("span", "", "con nadie más"));
      for (const { id, nombre } of lista) {
        const ficha = crear("span", "", nombre);
        if (editable) {
          const quitar = crear("button", "", "✕");
          quitar.type = "button";
          quitar.setAttribute("aria-label", `Dejar de compartir con ${nombre}`);
          quitar.addEventListener("click", () => {
            lista = lista.filter((x) => x.id !== id);
            pintarFichas();
          });
          ficha.append(quitar);
        }
        fichas.append(ficha);
      }
    };
    pintarFichas();
    nodo.append(fichas);
    if (editable) {
      const anadir = (id, nombre) => {
        if (!lista.some((x) => x.id === id)) lista.push({ id, nombre });
        pintarFichas();
      };
      const otros = vista.ambitos.filter((a) => a.id !== vista.yo);
      const ambitos = desplegable([["", "Compartir con…"], ...otros.map((a) => [a.id, a.nombre])], "");
      ambitos.setAttribute("aria-label", "Compartir con un grupo o una organización");
      ambitos.addEventListener("change", () => {
        if (ambitos.value) anadir(ambitos.value, ambitos.selectedOptions[0].textContent);
        ambitos.value = "";
      });
      nodo.append(ambitos);
      if (buscarPersonas) {
        const buscador = crear("input");
        buscador.type = "search";
        buscador.placeholder = "Compartir con una persona (escribe su alias)";
        buscador.setAttribute("aria-label", "Compartir con una persona");
        const resultados = crear("div", "ec-fichas");
        let reloj = null;
        buscador.addEventListener("input", () => {
          clearTimeout(reloj);
          reloj = setTimeout(async () => {
            resultados.replaceChildren();
            if (buscador.value.trim().length < 2) return;
            for (const persona of await buscarPersonas(buscador.value.trim())) {
              const boton = crear("button", "", `＋ ${persona.nombre}`);
              boton.type = "button";
              boton.addEventListener("click", () => {
                anadir(`${vista.app}:u:${persona.id}`, persona.nombre);
                buscador.value = "";
                resultados.replaceChildren();
              });
              resultados.append(boton);
            }
          }, 300);
        });
        nodo.append(buscador, resultados);
      }
    }
    return { nodo, lista: () => lista };
  }

  // Línea de aviso bajo la ficha.
  const mensaje = crear("p", "ec-mensaje");
  function avisar(texto, error = false) {
    mensaje.className = error ? "ec-mensaje error" : "ec-mensaje";
    mensaje.textContent = texto;
  }
  // Hace una llamada y, si va bien, recarga y elige lo devuelto; si no, enseña el error.
  async function hacer(llamada, despues) {
    try {
      const resultado = await llamada();
      await recargar();
      if (despues) elegir(despues(resultado));
      avisar("Hecho.");
    } catch (error) {
      avisar(error.message, true);
    }
  }

  // Pinta la ficha de lo elegido: una carpeta (nueva o no) o un elemento (nuevo o no).
  function pintarFicha() {
    derecha.replaceChildren();
    avisar("");
    if (!elegido) {
      derecha.append(crear("p", "ec-vacio", `Elige una carpeta o un elemento. ${NOMBRES[clase][0]}: lo de tus ámbitos, lo tuyo y lo compartido contigo.`));
      return;
    }
    const esCarpeta = elegido.tipo === "carpeta" || elegido.tipo === "carpeta-nueva";
    const existente = elegido.tipo === "carpeta" ? vista.carpetas.find((c) => c.id === elegido.id) : elegido.tipo === "elemento" ? vista.elementos.find((e) => e.id === elegido.id) : null;
    const nuevo = !existente;
    const editable = nuevo || existente.puedeCambiar;
    const personal = esCarpeta ? Boolean(nuevo ? elegido.padre : existente.padre) : clase !== "imagen";
    derecha.append(crear("h3", "", nuevo ? (esCarpeta ? "Carpeta nueva" : NOMBRES[clase][2]) : existente.nombre));
    if (!nuevo) {
      const sitio = esCarpeta ? (existente.padre ? camino(vista.carpetas, existente.padre) : "primer nivel") : camino(vista.carpetas, existente.carpeta);
      derecha.append(crear("p", "ec-vacio", `En ${sitio} · de ${nombreDeAmbito(existente.dueno)} · ${existente.autor ? `cambiado por ${existente.autor}, ` : ""}${new Date(existente.cambiado).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}${editable ? "" : " · solo lectura"}`));
    }

    const nombre = crear("input");
    nombre.value = existente?.nombre || "";
    nombre.maxLength = 120;
    nombre.required = true;
    derecha.append(campo("Nombre", nombre));
    const propios = ambitosPropios(personal);
    const dueno = desplegable(propios.length ? propios.map((a) => [a.id, a.nombre]) : [[existente?.dueno || "", nombreDeAmbito(existente?.dueno)]], existente?.dueno || (personal ? vista.yo : propios[0]?.id || ""));
    derecha.append(campo("De quién es (quién puede cambiarlo)", dueno));
    const lista = compartir(existente?.compartido || [], editable);
    const zonaCompartir = crear("div", "ec-ficha");
    zonaCompartir.append(crear("span", "", "Compartido con"), lista.nodo);
    derecha.append(zonaCompartir);

    // Campos propios de cada clase.
    const campos = {};
    const datos = existente?.datos || {};
    let previa = null;
    if (!esCarpeta) {
      if (clase === "plantilla") {
        campos.formato = desplegable([["markdown", "Markdown"], ["typst", "Typst"]], datos.formato || "markdown");
        campos.aspecto = cuadro(datos.aspecto, 8);
        campos.aspecto.placeholder = '#set text(font: "Libertinus Serif", size: 12pt)\n#set heading(numbering: "1.")';
        campos.texto = cuadro(datos.texto, 10);
        derecha.append(
          campo("Formato del texto de partida", campos.formato),
          campo("Aspecto (Typst: página, letra, títulos…; la variable «titulo» tiene el del documento)", campos.aspecto),
          campo("Texto de partida (opcional: se pone en los documentos vacíos que la eligen)", campos.texto),
        );
      } else if (clase === "fragmento") {
        campos.texto = cuadro(datos.texto, 12);
        derecha.append(campo("Texto, código o las dos cosas", campos.texto));
      } else if (clase === "membrete") {
        campos.cabecera = cuadro(datos.cabecera, 5);
        campos.pie = cuadro(datos.pie, 4);
        derecha.append(
          campo("Cabecera (Typst; puede llevar imágenes: #image(\"/imagenes/…\", height: 1.2cm))", campos.cabecera),
          campo("Pie (Typst; vacío deja el número de página)", campos.pie),
        );
      } else if (clase === "imagen") {
        if (existente) {
          const imagen = crear("img", "ec-previa");
          imagen.alt = existente.nombre;
          imagen.src = `${http}/biblioteca/imagenes/${existente.id}?pase=${encodeURIComponent(pase)}`;
          imagen.style.maxHeight = "16rem";
          imagen.style.objectFit = "contain";
          derecha.append(imagen, crear("p", "ec-vacio", `En Markdown: ![${existente.nombre}](imagen:${existente.id}) · En Typst: #image("/imagenes/${existente.id}")`));
        } else {
          campos.fichero = crear("input");
          campos.fichero.type = "file";
          campos.fichero.accept = "image/png,image/jpeg,image/gif";
          derecha.append(campo("Imagen (PNG, JPEG o GIF; 2 MB como mucho)", campos.fichero));
        }
      }
      if (clase === "plantilla" || clase === "membrete") {
        previa = crear("img", "ec-previa");
        previa.alt = "Vista previa";
        previa.hidden = true;
      }
    }
    if (!editable) for (const control of derecha.querySelectorAll("input, select, textarea")) control.disabled = true;

    // Botones.
    const botones = crear("div", "ec-botones");
    if (editable) {
      const guardar = crear("button", "ec-principal", nuevo && clase === "imagen" && !esCarpeta ? "Subir" : "Guardar");
      guardar.type = "button";
      guardar.addEventListener("click", () => {
        const comun = { nombre: nombre.value, dueno: dueno.value, compartido: lista.lista() };
        const deLaClase = Object.fromEntries(Object.entries(campos).filter(([clave]) => clave !== "fichero").map(([clave, control]) => [clave, control.value]));
        if (esCarpeta && nuevo) hacer(() => api("POST", "/carpetas", { clase, padre: elegido.padre, ...comun }), (c) => ({ tipo: "carpeta", id: c.id }));
        else if (esCarpeta) hacer(() => api("PUT", `/carpetas/${existente.id}`, comun), () => elegido);
        else if (nuevo && clase === "imagen") {
          const fichero = campos.fichero.files[0];
          if (!fichero) return avisar("Elige una imagen.", true);
          const parametros = new URLSearchParams({ carpeta: elegido.carpeta, nombre: comun.nombre || fichero.name, dueno: comun.dueno, compartido: JSON.stringify(comun.compartido) });
          hacer(() => api("POST", `/imagenes?${parametros}`, fichero), (e) => ({ tipo: "elemento", id: e.id }));
        } else if (nuevo) hacer(() => api("POST", "/elementos", { clase, carpeta: elegido.carpeta, ...comun, datos: deLaClase }), (e) => ({ tipo: "elemento", id: e.id }));
        else hacer(() => api("PUT", `/elementos/${existente.id}`, { ...comun, datos: deLaClase }), () => elegido);
      });
      botones.append(guardar);
    }
    if (previa) {
      const verPrevia = crear("button", "", "Previsualizar");
      verPrevia.type = "button";
      verPrevia.addEventListener("click", async () => {
        avisar("Compilando…");
        const ejemplo = clase === "plantilla" ? { formato: campos.formato.value, aspecto: campos.aspecto.value, texto: campos.texto.value || (campos.formato.value === "typst" ? "= Apartado\n\nTexto de ejemplo." : "## Apartado\n\nTexto de ejemplo.") } : { texto: "Texto de ejemplo.", cabecera: campos.cabecera.value, pie: campos.pie.value };
        try {
          const svg = await api("POST", "/previa", ejemplo);
          if (previa.src.startsWith("blob:")) URL.revokeObjectURL(previa.src);
          previa.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          previa.hidden = false;
          avisar("");
        } catch (error) {
          avisar(`No se ha podido compilar: ${error.message}`, true);
        }
      });
      botones.append(verPrevia);
    }
    if (!nuevo && editable) {
      const borrar = crear("button", "ec-peligro", "Borrar");
      borrar.type = "button";
      borrar.addEventListener("click", () => {
        if (!window.confirm(`¿Borrar «${existente.nombre}»? No se puede deshacer.`)) return;
        hacer(() => api("DELETE", `/${esCarpeta ? "carpetas" : "elementos"}/${existente.id}`), () => null);
      });
      botones.append(borrar);
    }
    derecha.append(botones, mensaje);
    if (previa) derecha.append(previa);
  }

  recargar();
  return { recargar };
}
