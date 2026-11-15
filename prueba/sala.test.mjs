// Prueba de una sala de verdad: arranca el editor y una aplicación de mentira (un servidor HTTP que da
// el texto inicial y apunta lo guardado). Lo que escribe Lince le llega a Nutria, que solo puede leer y
// cuyos cambios no se aceptan; a la aplicación le llega el texto con quién lo ha escrito; quien comenta
// escribe en la sala de comentarios pero no en el texto; con un máximo de escritores, quien llega de más
// entra a leer; y el texto se compila con Typst.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";

import { crearPase, firmaValida } from "../src/pases.mjs";
import { crearServidor } from "../src/servidor.mjs";

const SECRETO = "secreto-de-prueba";

// Espera hasta que se cumpla una condición (o falla a los 5 segundos).
async function hasta(condicion) {
  for (let intento = 0; intento < 100; intento++) {
    if (condicion()) return;
    await new Promise((listo) => setTimeout(listo, 50));
  }
  throw new Error("No se ha cumplido a tiempo.");
}

// Fabrica un pase para la sala de prueba.
function paseDe(alias, permiso, extra = {}) {
  return crearPase({ app: "asambleas", sala: "documentos.documento:1", alias, permiso, exp: Math.floor(Date.now() / 1000) + 300, ...extra }, SECRETO);
}

// Conecta a una persona a la sala con su permiso (y a la de comentarios, por la misma conexión). Devuelve su
// proveedor (ya sincronizado), con .comentarios (el de la sala de comentarios) y .avisos (lo que le dice el
// servidor). Al acabar se cierra con cerrar(proveedor), que cierra también su conexión.
async function conectar(puerto, alias, permiso, extra = {}) {
  const pase = paseDe(alias, permiso, extra);
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${puerto}`, WebSocketPolyfill: WebSocket });
  const proveedor = new HocuspocusProvider({ websocketProvider: socket, name: "asambleas/documentos.documento:1", token: pase });
  proveedor.avisos = [];
  proveedor.on("stateless", ({ payload }) => proveedor.avisos.push(JSON.parse(payload)));
  await new Promise((listo) => proveedor.on("synced", listo));
  proveedor.comentarios = new HocuspocusProvider({ websocketProvider: socket, name: "asambleas/documentos.documento:1#comentarios", token: pase });
  await new Promise((listo) => proveedor.comentarios.on("synced", listo));
  proveedor.socket = socket;
  return proveedor;
}

// Cierra el proveedor de una persona y su conexión.
function cerrar(proveedor) {
  proveedor.comentarios.destroy();
  proveedor.destroy();
  proveedor.socket.destroy();
}

test("dos personas en una sala", async () => {
  const guardados = [];
  // La aplicación de mentira: responde al texto inicial y apunta los guardados (si la firma vale).
  const aplicacion = createServer(async (peticion, respuesta) => {
    let cuerpo = "";
    for await (const trozo of peticion) cuerpo += trozo;
    const firmado = peticion.method === "GET" ? new URL(peticion.url, "http://x").searchParams.get("sala") : cuerpo;
    if (!firmaValida(peticion.headers, firmado, SECRETO)) {
      respuesta.writeHead(403).end();
      return;
    }
    respuesta.writeHead(200, { "Content-Type": "application/json" });
    if (peticion.method === "GET") return respuesta.end(JSON.stringify({ texto: "## Puntos\n", version: 1 }));
    guardados.push(JSON.parse(cuerpo));
    respuesta.end(JSON.stringify({ version: 1 + guardados.length }));
  });
  await new Promise((listo) => aplicacion.listen(0, "127.0.0.1", listo));
  const aplicaciones = { asambleas: { secreto: SECRETO, url: `http://127.0.0.1:${aplicacion.address().port}` } };
  const servidor = crearServidor({ aplicaciones, carpeta: await mkdtemp(join(tmpdir(), "editor-")), espera: 50, esperaMaxima: 200 });
  await servidor.listen(0);
  const puerto = servidor.address.port;
  try {
    const lince = await conectar(puerto, "Lince", "escribir");
    const nutria = await conectar(puerto, "Nutria", "leer");
    assert.equal(nutria.document.getText("texto").toString(), "## Puntos\n");
    lince.document.getText("texto").insert(10, "1. Huerto\n");
    await hasta(() => nutria.document.getText("texto").toString().includes("Huerto"));
    nutria.document.getText("texto").insert(0, "Hola ");
    await hasta(() => guardados.length > 0);
    await new Promise((listo) => setTimeout(listo, 300));
    assert.equal(lince.document.getText("texto").toString(), "## Puntos\n1. Huerto\n");
    assert.deepEqual(guardados.at(-1).alias, ["Lince"]);
    assert.equal(guardados.at(-1).texto, "## Puntos\n1. Huerto\n");
    // Nutria (lee) no comenta; Garza (comenta) sí, aunque no puede cambiar el texto.
    const garza = await conectar(puerto, "Garza", "comentar");
    garza.comentarios.document.getArray("comentarios").push(["de Garza"]);
    garza.document.getText("texto").insert(0, "Garza ");
    nutria.comentarios.document.getArray("comentarios").push(["de Nutria"]);
    await hasta(() => lince.comentarios.document.getArray("comentarios").length > 0);
    await new Promise((listo) => setTimeout(listo, 200));
    assert.deepEqual(lince.comentarios.document.getArray("comentarios").toArray(), ["de Garza"]);
    assert.ok(!lince.document.getText("texto").toString().includes("Garza"));
    // Con un máximo de un escritor, la segunda persona que escribe entra a leer y se le avisa.
    const zorro = await conectar(puerto, "Zorro", "escribir", { max_escritores: 1 });
    await hasta(() => zorro.avisos.length > 0);
    assert.deepEqual(zorro.avisos[0], { tipo: "lleno", permiso: "leer", limite: 1 });
    zorro.document.getText("texto").insert(0, "Zorro ");
    // El resultado con Typst, en SVG y en PDF, con un pase de la sala.
    const base = `http://127.0.0.1:${puerto}`;
    const svg = await fetch(`${base}/render`, { method: "POST", body: new URLSearchParams({ pase: paseDe("Nutria", "leer") }) });
    assert.equal(svg.status, 200);
    assert.match(await svg.text(), /<svg/);
    const pdf = await fetch(`${base}/pdf?pase=${encodeURIComponent(paseDe("Nutria", "leer", { titulo: "Acta" }))}`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await fetch(`${base}/render`, { method: "POST", body: "pase=malo" })).status, 403);
    assert.ok(!lince.document.getText("texto").toString().includes("Zorro"));
    cerrar(zorro);
    cerrar(garza);
    cerrar(lince);
    cerrar(nutria);
  } finally {
    await servidor.destroy();
    aplicacion.closeAllConnections();
    aplicacion.close();
  }
});
