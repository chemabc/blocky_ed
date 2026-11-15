// Compila con Typst (el compilador para Node de typst.ts, Apache-2.0) en un hilo aparte.
//
// Compilar gasta procesador y un texto de Typst puede ser un bucle sin fin. Por eso:
// - se hace en un hilo de trabajo (worker_threads), y el servidor sigue atendiendo a todo el mundo;
// - cada compilación tiene un tiempo máximo: si se pasa, se mata el hilo y se crea otro;
// - van de una en una (en cola), y el resultado de cada sala se recuerda mientras su texto no cambie;
// - el compilador solo ve una carpeta vacía: un texto no puede leer ficheros del servidor.
//
// Este fichero hace de las dos cosas: si se carga como hilo, compila; si no, ofrece renderizar().

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Segundos que puede tardar una compilación.
const TIEMPO_MAXIMO = 8;
// Cuántos resultados se recuerdan (los de las últimas salas).
const RECORDADOS = 50;

// ── Dentro del hilo: compilar ────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  const { NodeCompiler } = await import("@myriaddreamin/typst-ts-node-compiler");
  const carpeta = mkdtempSync(join(tmpdir(), "typst-"));
  const compilador = NodeCompiler.create({ workspace: carpeta });
  // Cada mensaje: { id, fuente, como, ficheros } → responde { id, datos } o { id, error }. Los ficheros
  // (las imágenes de la biblioteca: { "/imagenes/<número>": bytes }) se le dan al compilador en memoria,
  // como si estuvieran en su carpeta vacía; los de la compilación anterior se olvidan.
  parentPort.on("message", ({ id, fuente, como, ficheros = {} }) => {
    try {
      compilador.resetShadow();
      for (const [ruta, bytes] of Object.entries(ficheros)) compilador.mapShadow(join(carpeta, ruta), Buffer.from(bytes));
      const resultado = compilador.compile({ mainFileContent: fuente });
      if (resultado.hasError()) {
        const avisos = resultado.takeDiagnostics()?.shortDiagnostics || [];
        parentPort.postMessage({ id, error: avisos.map((aviso) => aviso.message).join(" · ") || "Typst no ha podido compilarlo." });
        return;
      }
      const documento = resultado.result;
      const datos = como === "pdf" ? compilador.pdf(documento) : compilador.svg(documento);
      parentPort.postMessage({ id, datos });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message || error) });
    }
  });
}

// ── Desde el servidor: pedir compilaciones ───────────────────────────────────────────────────────────

let hilo = null;
let siguiente = 1;
let cola = Promise.resolve();
const recordados = new Map();

// Devuelve el hilo de compilar, creándolo si no hay.
function elHilo() {
  if (!hilo) {
    hilo = new Worker(new URL(import.meta.url));
    hilo.unref(); // no impide que el proceso termine
  }
  return hilo;
}

// Manda una compilación al hilo y espera su respuesta, como mucho TIEMPO_MAXIMO segundos.
function compilarEnElHilo(fuente, como, ficheros) {
  return new Promise((bien, mal) => {
    const id = siguiente++;
    const trabajador = elHilo();
    const reloj = setTimeout(() => {
      trabajador.off("message", alResponder);
      trabajador.terminate();
      hilo = null;
      mal(new Error(`Typst ha tardado más de ${TIEMPO_MAXIMO} segundos. ¿Hay un bucle sin fin?`));
    }, TIEMPO_MAXIMO * 1000);
    function alResponder(respuesta) {
      if (respuesta.id !== id) return;
      clearTimeout(reloj);
      trabajador.off("message", alResponder);
      if (respuesta.error) mal(new Error(respuesta.error));
      else bien(respuesta.datos);
    }
    trabajador.on("message", alResponder);
    trabajador.postMessage({ id, fuente, como, ficheros });
  });
}

// Compila un texto de Typst ya completo. Devuelve el SVG (texto) o el PDF (bytes). Si el mismo texto ya
// se compiló hace poco, devuelve lo recordado sin compilar.
//   - fuente: el Typst entero (con su plantilla; ver typst.mjs, componer).
//   - como: «svg» (para verlo en la página) o «pdf» (para descargarlo).
//   - ficheros: las imágenes que usa, { "/imagenes/<número>": bytes } (ver servidor.mjs).
export function renderizar(fuente, como = "svg", ficheros = {}) {
  const resumen = createHash("sha256").update(`${como}\n${fuente}`);
  for (const [ruta, bytes] of Object.entries(ficheros).sort()) resumen.update(`\n${ruta}\n`).update(bytes);
  const clave = resumen.digest("hex");
  if (recordados.has(clave)) return Promise.resolve(recordados.get(clave));
  const trabajo = cola.then(() => compilarEnElHilo(fuente, como, ficheros));
  cola = trabajo.catch(() => {});
  return trabajo.then((datos) => {
    recordados.set(clave, datos);
    if (recordados.size > RECORDADOS) recordados.delete(recordados.keys().next().value);
    return datos;
  });
}

// Para el hilo (al apagar el servidor o en las pruebas).
export async function pararRenderizador() {
  await hilo?.terminate();
  hilo = null;
}
