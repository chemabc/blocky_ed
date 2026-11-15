// Servidor del editor colaborativo en tiempo real.
//
// Varias personas escriben a la vez el mismo texto desde su navegador. Yjs une lo que escribe cada una
// sin pisarse y Hocuspocus (MIT) reparte los cambios por WebSocket. El servidor no conoce a las personas
// ni tiene base de datos de usuarios: se fía de los pases que firma cada aplicación (ver pases.mjs) y le
// devuelve lo escrito (ver aplicaciones.mjs).
//
// Además del WebSocket, responde a unas pocas direcciones HTTP:
//   - GET  /salud                → «bien» (para saber si está en marcha).
//   - GET  /cliente.js           → el editor para el navegador (se construye con «npm run construir»).
//   - POST /salas/cerrar         → echa a todo el mundo de una sala (lo pide la aplicación, firmado, por
//                                  ejemplo al aprobar un acta o al quitarle a alguien el permiso).
//   - POST /render (pase=…)      → el texto de la sala compilado con Typst, en SVG, para verlo al lado.
//   - GET  /pdf?pase=…           → el mismo, en PDF, para descargarlo.
//
// Cada sala tiene al lado otra para sus comentarios («<sala>#comentarios»): quien puede comentar escribe en
// ella aunque no pueda cambiar el texto. Y cada pase puede traer cuántas personas pueden escribir y
// comentar a la vez («max_escritores», «max_comentaristas»): si ya están todas, se entra a leer.
//
// Se arranca con «npm run arrancar» (o «node src/servidor.mjs»). Variables de entorno:
//   - EDITOR_PUERTO: el puerto (de partida, 1234).
//   - EDITOR_APLICACIONES: las aplicaciones que lo usan, en JSON (ver aplicaciones.mjs).
//   - EDITOR_DATOS: carpeta donde guarda su copia de cada sala (de partida, ./datos).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { guardar, leer } from "./almacen.mjs";
import { avisarComentarios, avisarGuardado, leerAplicaciones, pedirTexto } from "./aplicaciones.mjs";
import { firmaValida, leerPase, nombreDeSala } from "./pases.mjs";
import { pararRenderizador, renderizar } from "./renderizador.mjs";
import { componer } from "./typst.mjs";

// Carpeta del editor (la de package.json).
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
// Nombre del texto compartido dentro de cada documento de Yjs (el cliente usa el mismo).
export const CAMPO = "texto";
// Lo que se añade al nombre de una sala para la de sus comentarios.
export const COMENTARIOS = "#comentarios";

// Separa el nombre interno de una sala en su aplicación, su sala y si es la de comentarios
// («asambleas/documentos.documento:12#comentarios»).
function partes(nombre) {
  const corte = nombre.indexOf("/");
  const comentarios = nombre.endsWith(COMENTARIOS);
  const sala = nombre.slice(corte + 1, comentarios ? -COMENTARIOS.length : undefined);
  return { app: nombre.slice(0, corte), sala, comentarios };
}

// Lee el pase que llega en el cuerpo de un POST de formulario («pase=…»).
function paseDelCuerpo(cuerpo) {
  return new URLSearchParams(cuerpo).get("pase");
}

// Lee entero el cuerpo de una petición HTTP, como texto.
async function cuerpoDe(peticion) {
  let texto = "";
  for await (const trozo of peticion) texto += trozo;
  return texto;
}

// Responde a una petición HTTP y corta la cadena de Hocuspocus (que, si no, respondería «OK»).
function responder(respuesta, estado, contenido, tipo = "text/plain; charset=utf-8") {
  respuesta.writeHead(estado, { "Content-Type": tipo });
  respuesta.end(contenido);
  throw null; // así lo pide Hocuspocus para decir «ya he respondido yo»
}

// Crea (sin arrancarlo) el servidor del editor. Lo usan este fichero y las pruebas.
//   - aplicaciones: { nombre: { secreto, url } }.
//   - carpeta: dónde guarda su copia de cada sala.
//   - espera, esperaMaxima: milisegundos que espera, tras el último cambio, para avisar a la aplicación
//     (y como mucho, aunque no se deje de escribir).
export function crearServidor({ aplicaciones, carpeta, espera = 2000, esperaMaxima = 10000 }) {
  // Quién ha escrito en cada sala desde el último aviso a la aplicación: nombre de sala → Set de alias.
  const autores = new Map();
  // Versión de la aplicación con la que va cada sala: nombre de sala → número.
  const versiones = new Map();
  // Quién está dentro de cada sala y con qué permiso: nombre de sala → Map(conexión → permiso).
  const presentes = new Map();
  // Salas de comentarios que han cambiado desde el último aviso a la aplicación.
  const comentariosCambiados = new Set();

  // Los comentarios de una sala como datos sencillos, con el trozo que comentan tal como está ahora (si el
  // texto está abierto; si no, sin cita).
  function listaDeComentarios(documento, nombreDelTexto) {
    const texto = servidor.documents.get(nombreDelTexto);
    // El trozo de texto entre dos posiciones relativas guardadas, o "" si no se puede saber.
    const cita = (desde, hasta) => {
      if (!texto || !desde || !hasta) return "";
      const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(desde), texto);
      const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(hasta), texto);
      return a && b && b.index > a.index ? texto.getText(CAMPO).toString().slice(a.index, b.index) : "";
    };
    return documento.getArray("comentarios").toArray().filter((c) => c instanceof Y.Map).map((c) => ({
      id: c.get("id"), alias: c.get("alias"), texto: c.get("texto"), cuando: c.get("cuando"), resuelto: Boolean(c.get("resuelto")),
      cita: cita(c.get("desde"), c.get("hasta")), respuestas: (c.get("respuestas")?.toArray() || []).map(({ alias, texto: t, cuando }) => ({ alias, texto: t, cuando })),
    }));
  }

  // Cuántas personas hay en una sala con un permiso.
  function cuantos(nombre, permiso) {
    return [...(presentes.get(nombre)?.values() || [])].filter((otro) => otro === permiso).length;
  }

  // El texto actual de una sala: el que está en memoria, o su copia guardada si nadie la tiene abierta.
  async function textoDe(nombre) {
    const abierta = servidor.documents.get(nombre);
    if (abierta) return abierta.getText(CAMPO).toString();
    const copia = await leer(carpeta, nombre);
    if (!copia) return "";
    const documento = new Y.Doc();
    Y.applyUpdate(documento, copia.estado);
    return documento.getText(CAMPO).toString();
  }

  // Compila el texto de la sala de un pase con Typst, con su formato y su título.
  async function compilarSala(datos, como) {
    const texto = await textoDe(nombreDeSala(datos.app, datos.sala));
    return renderizar(componer(texto, datos.formato || "markdown", datos.titulo || ""), como);
  }

  const servidor = new Hocuspocus({
    quiet: true,
    debounce: espera,
    maxDebounce: esperaMaxima,

    // Al conectarse alguien: comprueba su pase y que es de esta sala (o de la de sus comentarios). Si ya
    // hay tantas personas escribiendo (o comentando) como permite el pase, entra a leer. En la sala del
    // texto solo cambia quien escribe; en la de comentarios, también quien comenta (Hocuspocus descarta lo
    // que intente cambiar quien no puede). Lo devuelto queda como «context».
    async onAuthenticate({ token, documentName, connection, socketId }) {
      const datos = leerPase(token, aplicaciones);
      const { app, sala, comentarios } = partes(documentName);
      if (datos.app !== app || datos.sala !== sala) throw new Error("El pase es de otra sala.");
      let permiso = datos.permiso;
      const limite = { escribir: datos.max_escritores, comentar: datos.max_comentaristas }[permiso];
      const textoDeLaSala = nombreDeSala(app, sala);
      // En la de comentarios vale lo que se le dio en la del texto (si ya entró, que es lo normal).
      const yaDentro = presentes.get(textoDeLaSala)?.get(socketId);
      if (comentarios && yaDentro) permiso = yaDentro;
      else if (Number.isInteger(limite) && cuantos(textoDeLaSala, permiso) >= limite) permiso = "leer";
      if (!comentarios) {
        if (!presentes.has(textoDeLaSala)) presentes.set(textoDeLaSala, new Map());
        presentes.get(textoDeLaSala).set(socketId, permiso);
      }
      connection.readOnly = comentarios ? permiso === "leer" : permiso !== "escribir";
      return { alias: datos.alias, permiso, pedido: datos.permiso, limite };
    },

    // Ya dentro: si ha entrado con menos permiso del que traía (porque estaba lleno), se le avisa.
    async connected({ context, connectionInstance, documentName }) {
      if (context.permiso !== context.pedido && !partes(documentName).comentarios) {
        connectionInstance.sendStateless(JSON.stringify({ tipo: "lleno", permiso: context.permiso, limite: context.limite }));
      }
    },

    // Al salir alguien: deja libre su sitio.
    async onDisconnect({ documentName, socketId }) {
      presentes.get(documentName)?.delete(socketId);
    },

    // Al abrirse una sala que no está en memoria: usa su copia si va con la misma versión que la
    // aplicación; si no (no hay copia, o la aplicación cambió el texto por su cuenta), empieza con el texto
    // de la aplicación. Si la aplicación no responde, sigue con la copia, si la hay.
    async onLoadDocument({ document, documentName }) {
      const { app, sala, comentarios } = partes(documentName);
      const copia = await leer(carpeta, documentName);
      // Los comentarios solo los tiene el editor: no se piden a la aplicación.
      if (comentarios) {
        if (copia) Y.applyUpdate(document, copia.estado);
        return;
      }
      let remoto = null;
      try {
        remoto = await pedirTexto(aplicaciones[app], sala);
      } catch (error) {
        if (!copia) throw error;
      }
      if (copia && (remoto === null || remoto.version === copia.version)) {
        Y.applyUpdate(document, copia.estado);
        versiones.set(documentName, copia.version);
      } else {
        document.getText(CAMPO).insert(0, remoto.texto || "");
        versiones.set(documentName, remoto.version);
      }
    },

    // Cada cambio: apunta quién lo ha hecho (para la autoría que guarda la aplicación). En la sala de
    // comentarios, solo que han cambiado (se mandan todos a la aplicación al guardar).
    async onChange({ documentName, context }) {
      if (partes(documentName).comentarios) {
        comentariosCambiados.add(documentName);
        return;
      }
      if (context?.permiso !== "escribir") return;
      if (!autores.has(documentName)) autores.set(documentName, new Set());
      autores.get(documentName).add(context.alias);
    },

    // Unos segundos después de los cambios: avisa a la aplicación con el texto y quién ha escrito, y guarda
    // su propia copia. Si la aplicación ya no acepta cambios, echa a todo el mundo de la sala.
    async onStoreDocument({ document, documentName }) {
      if (partes(documentName).comentarios && comentariosCambiados.delete(documentName)) {
        const { app, sala } = partes(documentName);
        await avisarComentarios(aplicaciones[app], { sala, comentarios: listaDeComentarios(document, nombreDeSala(app, sala)) });
      }
      const quienes = autores.get(documentName);
      autores.set(documentName, new Set());
      if (quienes?.size && !partes(documentName).comentarios) {
        const { app, sala } = partes(documentName);
        const texto = document.getText(CAMPO).toString();
        const respuesta = await avisarGuardado(aplicaciones[app], { sala, texto, alias: [...quienes], version: versiones.get(documentName) });
        if (respuesta.cerrada) {
          servidor.closeConnections(documentName);
          return;
        }
        versiones.set(documentName, respuesta.version);
      }
      await guardar(carpeta, documentName, Y.encodeStateAsUpdate(document), versiones.get(documentName));
    },

    // Las direcciones HTTP (ver arriba).
    async onRequest({ request, response }) {
      const direccion = new URL(request.url, "http://editor");
      if (request.method === "GET" && direccion.pathname === "/salud") responder(response, 200, "bien");
      if (request.method === "GET" && direccion.pathname === "/cliente.js") {
        const codigo = await readFile(join(RAIZ, "publico", "cliente.js")).catch(() => null);
        if (codigo === null) responder(response, 404, "Falta construir el cliente: npm run construir");
        responder(response, 200, codigo, "text/javascript; charset=utf-8");
      }
      if (request.method === "POST" && direccion.pathname === "/salas/cerrar") {
        const cuerpo = await cuerpoDe(request);
        const app = request.headers["x-editor-app"];
        if (!aplicaciones[app] || !firmaValida(request.headers, cuerpo, aplicaciones[app].secreto)) responder(response, 403, "Firma no válida.");
        servidor.closeConnections(nombreDeSala(app, JSON.parse(cuerpo).sala));
        responder(response, 200, "cerrada");
      }
      // Compilar con Typst. Se puede pedir desde otra web (la de la aplicación): por eso deja entrar a
      // cualquier origen; lo que protege es el pase, que va en el cuerpo (SVG) o en la dirección (PDF).
      if ((request.method === "POST" && direccion.pathname === "/render") || (request.method === "GET" && direccion.pathname === "/pdf")) {
        response.setHeader("Access-Control-Allow-Origin", "*");
        const pdf = direccion.pathname === "/pdf";
        let datos;
        try {
          datos = leerPase(pdf ? direccion.searchParams.get("pase") : paseDelCuerpo(await cuerpoDe(request)), aplicaciones);
        } catch (error) {
          responder(response, 403, error.message);
        }
        let resultado;
        try {
          resultado = await compilarSala(datos, pdf ? "pdf" : "svg");
        } catch (error) {
          responder(response, 422, error.message);
        }
        if (!pdf) responder(response, 200, resultado, "image/svg+xml; charset=utf-8");
        const nombre = encodeURIComponent((datos.titulo || "documento").slice(0, 80));
        response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${nombre}.pdf`);
        responder(response, 200, Buffer.from(resultado), "application/pdf");
      }
      responder(response, 404, "No existe.");
    },
  });
  // Al destruir el servidor, se para también el hilo de Typst.
  const destruir = servidor.destroy.bind(servidor);
  servidor.destroy = async () => {
    await pararRenderizador();
    return destruir();
  };
  return servidor;
}

// Si se ejecuta este fichero directamente (y no desde las pruebas), arranca el servidor.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const puerto = Number(process.env.EDITOR_PUERTO || 1234);
  const servidor = crearServidor({ aplicaciones: leerAplicaciones(), carpeta: process.env.EDITOR_DATOS || join(RAIZ, "datos") });
  await servidor.listen(puerto);
  console.log(`Editor colaborativo en marcha en el puerto ${puerto}.`);
}
