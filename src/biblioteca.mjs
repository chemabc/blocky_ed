// La biblioteca del editor: plantillas, fragmentos, cabeceras y pies, e imágenes, en carpetas y subcarpetas.
//
// - PLANTILLA: todo lo que puede llevar un documento de partida: su aspecto (Typst: página, letra,
//   márgenes…) y, si se quiere, un texto de partida (el esqueleto de un acta, por ejemplo). Cada documento
//   elige la suya en un desplegable.
// - FRAGMENTO: un trozo de texto, de código o de las dos cosas, que se mete en el documento con un clic.
//   Es la «enciclopedia de fragmentos».
// - CABECERA Y PIE (membrete): lo que va arriba y abajo de cada página (el de una organización, por
//   ejemplo). Se elige aparte de la plantilla, en otro desplegable.
// - IMAGEN: un dibujo (PNG, JPEG o GIF) que se puede poner en un texto, en una plantilla o en un membrete.
//
// QUIÉN VE Y QUIÉN CAMBIA. El editor no conoce a las personas: se fía del pase que firma cada aplicación
// (ver pases.mjs). Para la biblioteca, el pase trae:
//   - usuario: un número que identifica a la persona en esa aplicación (sin decir quién es);
//   - ambitos: los «ámbitos» a los que pertenece, [{ id, nombre, cambiar }]. Un ámbito es lo que la
//     aplicación quiera: «toda la plataforma», una organización, un grupo… Con «cambiar», la persona puede
//     crear y cambiar lo de ese ámbito (lo administra); sin él, solo usarlo.
//   - carpetas (opcional): los nombres de las carpetas de primer nivel que puede ver con este pase.
// Cada carpeta y cada elemento tiene un DUEÑO (un ámbito, o la propia persona: «solo yo») y puede estar
// COMPARTIDO con otros ámbitos y con personas sueltas. Se ve lo que es de un ámbito tuyo, lo tuyo y lo que
// se ha compartido contigo. Se cambia lo que es de un ámbito que administras, y lo tuyo.
// Los ámbitos de cada aplicación van aparte («asambleas:o3»): una aplicación nunca ve lo de otra.
// Además, cada aplicación puede tener limitadas sus carpetas de primer nivel de plantillas y de fragmentos en
// EDITOR_APLICACIONES («carpetas»: ["Actas"]): la plataforma de asambleas solo ve las de actas. Las
// cabeceras y pies y las imágenes no se limitan así (son de cada organización, no de un tipo de documento).
//
// CÓMO SE GUARDA. Todo en la carpeta de datos, CIFRADO (ver cifrado.mjs): un índice con las carpetas y
// los elementos (con sus textos) y un fichero por imagen. Los cambios van de uno en uno (en cola) y cada
// fichero se escribe aparte y después se renombra, para que un corte no lo deje roto.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cifrar, descifrar } from "./cifrado.mjs";

// Las clases de cosas que hay, con su nombre para las personas. Cada una tiene su propio árbol de carpetas.
export const CLASES = { plantilla: "Plantillas", fragmento: "Fragmentos", membrete: "Cabeceras y pies", imagen: "Imágenes" };
// Clases cuyas carpetas de primer nivel limita cada aplicación (ver arriba).
const LIMITADAS = ["plantilla", "fragmento"];
// Tamaño máximo de una imagen (2 MB) y de cada texto (en letras).
export const MAXIMO_DE_IMAGEN = 2 * 1024 * 1024;
const MAXIMO_DE_TEXTO = 200_000;
const MAXIMO_DE_NOMBRE = 120;
// Cuántos ámbitos y personas puede haber en la lista de compartir de una cosa.
const MAXIMO_DE_COMPARTIDOS = 100;
// Tipos de imagen admitidos, con los primeros bytes que los delatan (no se fía de lo que diga el navegador).
const IMAGENES = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
];
// Campos de cada clase (todos texto) y sus valores de partida.
const CAMPOS = {
  plantilla: { formato: "markdown", aspecto: "", texto: "" },
  fragmento: { texto: "" },
  membrete: { cabecera: "", pie: "" },
  imagen: {},
};

// Error que se cuenta a la persona (con el código HTTP con el que se responde).
export class ErrorDeBiblioteca extends Error {
  constructor(mensaje, estado = 400) {
    super(mensaje);
    this.estado = estado;
  }
}

// Saca del pase lo que la biblioteca necesita saber de una persona: su aplicación, su «yo», su alias, sus
// ámbitos (con el suyo personal) y las carpetas de primer nivel que puede ver (null: todas). Devuelve null
// si el pase no trae usuario (la aplicación no usa la biblioteca).
//   - datos: lo leído del pase.
//   - aplicacion: la de EDITOR_APLICACIONES (puede traer «carpetas»).
export function quienEs(datos, aplicacion = {}) {
  if (!datos.usuario) return null;
  const app = datos.app;
  const yo = `${app}:u:${datos.usuario}`;
  const ambitos = new Map([[yo, { nombre: "Solo yo", cambiar: true }]]);
  for (const ambito of Array.isArray(datos.ambitos) ? datos.ambitos : []) {
    if (ambito?.id) ambitos.set(`${app}:${ambito.id}`, { nombre: String(ambito.nombre || ambito.id), cambiar: Boolean(ambito.cambiar) });
  }
  let raices = Array.isArray(aplicacion.carpetas) ? aplicacion.carpetas : null;
  if (Array.isArray(datos.carpetas)) raices = raices ? raices.filter((nombre) => datos.carpetas.includes(nombre)) : datos.carpetas;
  return { app, yo, alias: datos.alias, ambitos, raices };
}

// Dice si una persona llega a una cosa (carpeta o elemento): es de un ámbito suyo, suya, o compartida con ella.
function llega(quien, cosa) {
  return quien.ambitos.has(cosa.dueno) || cosa.compartido.some(({ id }) => quien.ambitos.has(id));
}

// Dice si una persona puede cambiar una cosa: su dueño es un ámbito que administra, o ella misma.
function puedeCambiar(quien, cosa) {
  return Boolean(quien.ambitos.get(cosa.dueno)?.cambiar);
}

// Número nuevo al azar para una carpeta o un elemento (16 letras de 0-9 y a-f).
function nuevoId() {
  return randomBytes(8).toString("hex");
}

// Limpia un nombre: sin espacios de sobra, ni vacío ni demasiado largo.
function nombreValido(nombre) {
  const limpio = String(nombre || "").trim().replace(/\s+/g, " ");
  if (!limpio) throw new ErrorDeBiblioteca("Falta el nombre.");
  if (limpio.length > MAXIMO_DE_NOMBRE) throw new ErrorDeBiblioteca(`El nombre es demasiado largo (como mucho, ${MAXIMO_DE_NOMBRE} letras).`);
  return limpio;
}

// Comprueba la lista de compartir: solo ámbitos y personas de la misma aplicación. Devuelve [{ id, nombre }].
function compartidoValido(quien, lista = []) {
  if (!Array.isArray(lista)) throw new ErrorDeBiblioteca("La lista de compartir no es una lista.");
  if (lista.length > MAXIMO_DE_COMPARTIDOS) throw new ErrorDeBiblioteca(`Se puede compartir con ${MAXIMO_DE_COMPARTIDOS} como mucho.`);
  const vistos = new Map();
  for (const { id, nombre } of lista) {
    if (typeof id !== "string" || !id.startsWith(`${quien.app}:`)) throw new ErrorDeBiblioteca("Solo se comparte dentro de la misma aplicación.");
    vistos.set(id, { id, nombre: String(nombre || id).slice(0, MAXIMO_DE_NOMBRE) });
  }
  return [...vistos.values()];
}

// Comprueba el dueño que se elige: un ámbito que la persona administra, o ella misma. Las imágenes y las
// carpetas de primer nivel no pueden ser de una persona sola (las sube y las crea la administración).
function duenoValido(quien, dueno, { personal = true } = {}) {
  const elegido = dueno || quien.yo;
  if (!quien.ambitos.get(elegido)?.cambiar) throw new ErrorDeBiblioteca("No puedes poner cosas a nombre de ese ámbito.", 403);
  if (!personal && elegido === quien.yo) throw new ErrorDeBiblioteca("Esto lo crea la administración: elige un ámbito que administres.", 403);
  return elegido;
}

// Comprueba y limpia los campos de un elemento según su clase.
function datosValidos(clase, datos = {}) {
  const limpios = {};
  for (const [campo, dePartidaDelCampo] of Object.entries(CAMPOS[clase])) {
    const valor = String(datos[campo] ?? dePartidaDelCampo);
    if (valor.length > MAXIMO_DE_TEXTO) throw new ErrorDeBiblioteca("El texto es demasiado largo.");
    limpios[campo] = valor;
  }
  if (clase === "plantilla" && !["markdown", "typst"].includes(limpios.formato)) throw new ErrorDeBiblioteca("El formato es «markdown» o «typst».");
  return limpios;
}

// Dice qué tipo de imagen es por sus primeros bytes, o null si no es de las admitidas.
export function tipoDeImagen(bytes) {
  const encontrado = IMAGENES.find(([, firma]) => firma.every((byte, i) => bytes[i] === byte));
  return encontrado ? encontrado[0] : null;
}

// Crea la biblioteca sobre una carpeta de datos y una clave de cifrado. Lo usa servidor.mjs (y las pruebas).
export function crearBiblioteca({ carpeta, clave }) {
  const raiz = join(carpeta, "biblioteca");
  let indice = null; // { carpetas: { id: carpeta }, elementos: { id: elemento } }, descifrado, en memoria
  let cola = Promise.resolve();

  // Lee el índice del disco la primera vez (después, de memoria). Si no hay, empieza vacío.
  async function leerIndice() {
    if (indice) return indice;
    try {
      indice = JSON.parse(descifrar(await readFile(join(raiz, "indice.cif")), clave, "indice").toString("utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      indice = { carpetas: {}, elementos: {} };
    }
    return indice;
  }

  // Escribe un fichero cifrado sin dejarlo a medias (primero uno temporal, después se renombra).
  async function escribirCifrado(nombre, datos, para) {
    await mkdir(join(raiz, "imagenes"), { recursive: true });
    await writeFile(join(raiz, `${nombre}.tmp`), cifrar(datos, clave, para));
    await rename(join(raiz, `${nombre}.tmp`), join(raiz, nombre));
  }

  // Hace un cambio en el índice, de uno en uno, y lo guarda. Si el cambio falla, el índice se vuelve a
  // leer del disco (no queda a medias en memoria).
  function cambiar(hacer) {
    const trabajo = cola.then(async () => {
      const actual = await leerIndice();
      try {
        const resultado = await hacer(actual);
        await escribirCifrado("indice.cif", JSON.stringify(actual), "indice");
        return resultado;
      } catch (error) {
        indice = null;
        throw error;
      }
    });
    cola = trabajo.catch(() => {});
    return trabajo;
  }

  // La carpeta de primer nivel de la que cuelga una carpeta.
  function raizDe(carpetas, id) {
    let actual = carpetas[id];
    while (actual?.padre) actual = carpetas[actual.padre];
    return actual;
  }

  // Dice si una carpeta está dentro de lo que la aplicación y el pase dejan ver (sus carpetas de primer
  // nivel, en las clases limitadas).
  function enSusRaices(quien, carpetas, id) {
    const primera = raizDe(carpetas, id);
    return Boolean(primera) && primera.app === quien.app && (!quien.raices || !LIMITADAS.includes(primera.clase) || quien.raices.includes(primera.nombre));
  }

  // Lo que ve una persona: las carpetas a las que llega (y las de encima, para poder llegar a ellas), los
  // elementos a los que llega, y sus ámbitos (para elegir dueño y con quién compartir). Cada cosa dice si
  // la puede cambiar.
  async function ver(quien) {
    const { carpetas, elementos } = await leerIndice();
    const visibles = new Set();
    // Marca una carpeta y todas las de encima.
    const marcar = (id) => {
      for (let actual = carpetas[id]; actual && !visibles.has(actual.id); actual = carpetas[actual.padre]) visibles.add(actual.id);
    };
    const susElementos = Object.values(elementos).filter((e) => e.app === quien.app && enSusRaices(quien, carpetas, e.carpeta) && llega(quien, e));
    for (const carpeta of Object.values(carpetas)) if (carpeta.app === quien.app && enSusRaices(quien, carpetas, carpeta.id) && llega(quien, carpeta)) marcar(carpeta.id);
    for (const elemento of susElementos) marcar(elemento.carpeta);
    const ordenar = (a, b) => a.nombre.localeCompare(b.nombre, "es");
    return {
      app: quien.app,
      yo: quien.yo,
      raices: quien.raices,
      ambitos: [...quien.ambitos].map(([id, { nombre, cambiar: administra }]) => ({ id, nombre, cambiar: administra })),
      carpetas: [...visibles].map((id) => ({ ...carpetas[id], puedeCambiar: puedeCambiar(quien, carpetas[id]), llega: llega(quien, carpetas[id]) })).sort(ordenar),
      elementos: susElementos.map((e) => ({ ...e, puedeCambiar: puedeCambiar(quien, e) })).sort(ordenar),
    };
  }

  // Un elemento que la persona ve (de una clase), o null. Lo usa el servidor para compilar con la plantilla,
  // el membrete y las imágenes que elige cada documento.
  async function elementoVisible(quien, id, clase) {
    const { carpetas, elementos } = await leerIndice();
    const elemento = elementos[id];
    if (!elemento || elemento.clase !== clase || elemento.app !== quien.app) return null;
    return enSusRaices(quien, carpetas, elemento.carpeta) && llega(quien, elemento) ? elemento : null;
  }

  // Crea una carpeta. En el primer nivel, solo la administración y con un nombre que la aplicación deje ver;
  // dentro de otra, quien llegue a esa otra.
  //   - datos: { clase, nombre, padre, dueno, compartido }.
  function crearCarpeta(quien, { clase, nombre, padre = null, dueno, compartido }) {
    return cambiar(({ carpetas }) => {
      if (!CLASES[clase]) throw new ErrorDeBiblioteca("Esa clase de carpeta no existe.");
      const limpio = nombreValido(nombre);
      if (padre) {
        const deEncima = carpetas[padre];
        if (!deEncima || deEncima.clase !== clase || !enSusRaices(quien, carpetas, padre) || !llega(quien, deEncima)) throw new ErrorDeBiblioteca("No puedes crear carpetas ahí.", 403);
      } else if (quien.raices && LIMITADAS.includes(clase) && !quien.raices.includes(limpio)) {
        throw new ErrorDeBiblioteca(`Aquí solo hay carpetas de primer nivel llamadas: ${quien.raices.join(", ")}.`, 403);
      }
      const carpeta = {
        id: nuevoId(), app: quien.app, clase, nombre: limpio, padre, dueno: duenoValido(quien, dueno, { personal: Boolean(padre) }),
        compartido: compartidoValido(quien, compartido), autor: quien.alias, cambiado: Date.now(),
      };
      carpetas[carpeta.id] = carpeta;
      return carpeta;
    });
  }

  // Cambia el nombre, el dueño o con quién se comparte una carpeta (quien la puede cambiar).
  function cambiarCarpeta(quien, id, { nombre, dueno, compartido }) {
    return cambiar(({ carpetas }) => {
      const carpeta = carpetas[id];
      if (!carpeta || carpeta.app !== quien.app || !puedeCambiar(quien, carpeta)) throw new ErrorDeBiblioteca("No puedes cambiar esa carpeta.", 403);
      if (nombre !== undefined) {
        const limpio = nombreValido(nombre);
        if (!carpeta.padre && quien.raices && LIMITADAS.includes(carpeta.clase) && !quien.raices.includes(limpio)) throw new ErrorDeBiblioteca("Ese nombre de primer nivel no está permitido aquí.", 403);
        carpeta.nombre = limpio;
      }
      if (dueno !== undefined) carpeta.dueno = duenoValido(quien, dueno, { personal: Boolean(carpeta.padre) });
      if (compartido !== undefined) carpeta.compartido = compartidoValido(quien, compartido);
      carpeta.cambiado = Date.now();
      return carpeta;
    });
  }

  // Borra una carpeta vacía (sin carpetas ni elementos dentro, ni siquiera de los que no ves).
  function borrarCarpeta(quien, id) {
    return cambiar(({ carpetas, elementos }) => {
      const carpeta = carpetas[id];
      if (!carpeta || carpeta.app !== quien.app || !puedeCambiar(quien, carpeta)) throw new ErrorDeBiblioteca("No puedes borrar esa carpeta.", 403);
      const llena = Object.values(carpetas).some((c) => c.padre === id) || Object.values(elementos).some((e) => e.carpeta === id);
      if (llena) throw new ErrorDeBiblioteca("La carpeta no está vacía (puede tener cosas de otras personas que no ves).", 409);
      delete carpetas[id];
    });
  }

  // Comprueba que una persona puede meter algo de una clase en una carpeta (si llega a ella).
  function carpetaParaMeter(quien, carpetas, id, clase) {
    const carpeta = carpetas[id];
    if (!carpeta || carpeta.clase !== clase || !enSusRaices(quien, carpetas, id) || !llega(quien, carpeta)) throw new ErrorDeBiblioteca("No puedes meter cosas en esa carpeta.", 403);
    return carpeta;
  }

  // Crea una plantilla, un fragmento o un membrete (las imágenes se suben con subirImagen).
  //   - datos: { clase, carpeta, nombre, dueno, compartido, datos: { …los campos de la clase } }.
  function crearElemento(quien, { clase, carpeta, nombre, dueno, compartido, datos }) {
    return cambiar(({ carpetas, elementos }) => {
      if (!CLASES[clase] || clase === "imagen") throw new ErrorDeBiblioteca("Esa clase no se crea así.");
      carpetaParaMeter(quien, carpetas, carpeta, clase);
      const elemento = {
        id: nuevoId(), app: quien.app, clase, carpeta, nombre: nombreValido(nombre), dueno: duenoValido(quien, dueno),
        compartido: compartidoValido(quien, compartido), datos: datosValidos(clase, datos), autor: quien.alias, cambiado: Date.now(),
      };
      elementos[elemento.id] = elemento;
      return elemento;
    });
  }

  // Cambia un elemento (quien lo puede cambiar): nombre, carpeta, dueño, con quién se comparte y campos.
  function cambiarElemento(quien, id, { nombre, carpeta, dueno, compartido, datos }) {
    return cambiar(({ carpetas, elementos }) => {
      const elemento = elementos[id];
      if (!elemento || elemento.app !== quien.app || !puedeCambiar(quien, elemento)) throw new ErrorDeBiblioteca("No puedes cambiar eso.", 403);
      if (nombre !== undefined) elemento.nombre = nombreValido(nombre);
      if (carpeta !== undefined && carpeta !== elemento.carpeta) elemento.carpeta = carpetaParaMeter(quien, carpetas, carpeta, elemento.clase).id;
      if (dueno !== undefined) elemento.dueno = duenoValido(quien, dueno, { personal: elemento.clase !== "imagen" });
      if (compartido !== undefined) elemento.compartido = compartidoValido(quien, compartido);
      if (datos !== undefined && elemento.clase !== "imagen") elemento.datos = datosValidos(elemento.clase, { ...elemento.datos, ...datos });
      elemento.autor = quien.alias;
      elemento.cambiado = Date.now();
      return elemento;
    });
  }

  // Borra un elemento (y, si es una imagen, su fichero).
  function borrarElemento(quien, id) {
    return cambiar(async ({ elementos }) => {
      const elemento = elementos[id];
      if (!elemento || elemento.app !== quien.app || !puedeCambiar(quien, elemento)) throw new ErrorDeBiblioteca("No puedes borrar eso.", 403);
      delete elementos[id];
      if (elemento.clase === "imagen") await rm(join(raiz, "imagenes", `${id}.cif`), { force: true });
    });
  }

  // Sube una imagen a una carpeta de imágenes, a nombre de un ámbito que la persona administra.
  //   - datos: { carpeta, nombre, dueno, compartido, bytes }.
  function subirImagen(quien, { carpeta, nombre, dueno, compartido, bytes }) {
    return cambiar(async ({ carpetas, elementos }) => {
      if (!bytes?.length) throw new ErrorDeBiblioteca("La imagen está vacía.");
      if (bytes.length > MAXIMO_DE_IMAGEN) throw new ErrorDeBiblioteca("La imagen pesa más de 2 MB.", 413);
      const tipo = tipoDeImagen(bytes);
      if (!tipo) throw new ErrorDeBiblioteca("Solo se admiten imágenes PNG, JPEG o GIF.", 415);
      carpetaParaMeter(quien, carpetas, carpeta, "imagen");
      const elemento = {
        id: nuevoId(), app: quien.app, clase: "imagen", carpeta, nombre: nombreValido(nombre), dueno: duenoValido(quien, dueno, { personal: false }),
        compartido: compartidoValido(quien, compartido), datos: { tipo, tamano: bytes.length }, autor: quien.alias, cambiado: Date.now(),
      };
      await escribirCifrado(join("imagenes", `${elemento.id}.cif`), bytes, `imagen:${elemento.id}`);
      elementos[elemento.id] = elemento;
      return elemento;
    });
  }

  // Los bytes de una imagen que la persona ve, con su tipo: { tipo, bytes }. null si no la ve o no existe.
  async function imagen(quien, id) {
    const elemento = await elementoVisible(quien, id, "imagen");
    if (!elemento) return null;
    const bytes = descifrar(await readFile(join(raiz, "imagenes", `${id}.cif`)), clave, `imagen:${id}`);
    return { tipo: elemento.datos.tipo, bytes };
  }

  return { ver, elementoVisible, crearCarpeta, cambiarCarpeta, borrarCarpeta, crearElemento, cambiarElemento, borrarElemento, subirImagen, imagen };
}
