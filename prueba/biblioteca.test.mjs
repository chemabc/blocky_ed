// Pruebas de la biblioteca: quién ve y quién cambia cada cosa, que todo se guarda cifrado, y las direcciones
// HTTP (con pases), incluida una plantilla, un membrete y una imagen compilados con Typst.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as Y from "yjs";

import { guardar } from "../src/almacen.mjs";
import { crearBiblioteca, quienEs } from "../src/biblioteca.mjs";
import { cifrar, descifrar, leerClave } from "../src/cifrado.mjs";
import { crearPase } from "../src/pases.mjs";
import { pararRenderizador } from "../src/renderizador.mjs";
import { crearServidor } from "../src/servidor.mjs";

const SECRETO = "secreto-de-prueba";
const CLAVE = randomBytes(32);
// Un PNG de 1×1 punto.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Las personas de las pruebas, como las ve la biblioteca:
//   - admin: administra toda la plataforma («comun») y la organización 1;
//   - lince: de la organización 1 y del grupo 7 (sin administrar nada);
//   - nutria: de la organización 2;
//   - otra: de otra aplicación.
const app = { carpetas: ["Actas"] };
const admin = quienEs({ app: "asambleas", usuario: "a", alias: "Admin", ambitos: [{ id: "comun", nombre: "Toda", cambiar: true }, { id: "o1", nombre: "ORG 1", cambiar: true }] }, app);
const lince = quienEs({ app: "asambleas", usuario: "l", alias: "Lince", ambitos: [{ id: "comun", nombre: "Toda" }, { id: "o1", nombre: "ORG 1" }, { id: "g7", nombre: "GRU 7" }] }, app);
const nutria = quienEs({ app: "asambleas", usuario: "n", alias: "Nutria", ambitos: [{ id: "comun", nombre: "Toda" }, { id: "o2", nombre: "ORG 2" }] }, app);
const otra = quienEs({ app: "libros", usuario: "l", alias: "Lince", ambitos: [{ id: "comun", nombre: "Toda", cambiar: true }] });

after(() => pararRenderizador());

test("cifrado: ida y vuelta, y no se deja cambiar", () => {
  const cifrado = cifrar("hola", CLAVE, "indice");
  assert.equal(descifrar(cifrado, CLAVE, "indice").toString(), "hola");
  assert.throws(() => descifrar(cifrado, CLAVE, "otra-cosa"));
  cifrado[cifrado.length - 1] ^= 1;
  assert.throws(() => descifrar(cifrado, CLAVE, "indice"));
  assert.equal(leerClave(""), null);
  assert.throws(() => leerClave("corta"));
});

test("quién ve y quién cambia", async () => {
  const carpeta = await mkdtemp(join(tmpdir(), "biblioteca-"));
  const biblioteca = crearBiblioteca({ carpeta, clave: CLAVE });

  // Primer nivel: solo la administración y solo con los nombres que deja la aplicación.
  await assert.rejects(biblioteca.crearCarpeta(admin, { clase: "plantilla", nombre: "Libros", dueno: "asambleas:comun" }), /primer nivel/);
  await assert.rejects(biblioteca.crearCarpeta(lince, { clase: "plantilla", nombre: "Actas" }), /administración/);
  const actas = await biblioteca.crearCarpeta(admin, { clase: "plantilla", nombre: "Actas", dueno: "asambleas:comun" });
  const deLaOrg = await biblioteca.crearCarpeta(admin, { clase: "plantilla", nombre: "ORG 1", padre: actas.id, dueno: "asambleas:o1" });

  // Una plantilla común, una de la organización 1 y una de Lince compartida con su grupo.
  const comun = await biblioteca.crearElemento(admin, { clase: "plantilla", carpeta: actas.id, nombre: "Acta", dueno: "asambleas:comun", datos: { texto: "# Acta" } });
  await biblioteca.crearElemento(admin, { clase: "plantilla", carpeta: deLaOrg.id, nombre: "Acta de ORG 1", dueno: "asambleas:o1" });
  const suya = await biblioteca.crearElemento(lince, { clase: "plantilla", carpeta: actas.id, nombre: "Mi acta", compartido: [{ id: "asambleas:g7", nombre: "GRU 7" }] });
  assert.equal(suya.dueno, "asambleas:u:l");
  await assert.rejects(biblioteca.crearElemento(lince, { clase: "plantilla", carpeta: actas.id, nombre: "X", dueno: "asambleas:o1" }), /ese ámbito/);
  await assert.rejects(biblioteca.crearElemento(lince, { clase: "plantilla", carpeta: actas.id, nombre: "X", compartido: [{ id: "libros:comun" }] }), /misma aplicación/);

  const nombres = async (quien) => (await biblioteca.ver(quien)).elementos.map((e) => e.nombre);
  assert.deepEqual(await nombres(lince), ["Acta", "Acta de ORG 1", "Mi acta"]);
  assert.deepEqual(await nombres(nutria), ["Acta"]);
  assert.deepEqual(await nombres(otra), []);
  // Nutria no ve la carpeta de la organización 1 (no tiene nada suyo dentro).
  assert.deepEqual((await biblioteca.ver(nutria)).carpetas.map((c) => c.nombre), ["Actas"]);

  // Compartir con una persona suelta.
  await biblioteca.cambiarElemento(lince, suya.id, { compartido: [{ id: "asambleas:u:n", nombre: "Nutria" }] });
  assert.deepEqual(await nombres(nutria), ["Acta", "Mi acta"]);
  // Solo cambia quien puede.
  await assert.rejects(biblioteca.cambiarElemento(lince, comun.id, { nombre: "Otra" }), /No puedes/);
  await assert.rejects(biblioteca.cambiarElemento(nutria, suya.id, { nombre: "Otra" }), /No puedes/);
  await assert.rejects(biblioteca.borrarCarpeta(admin, deLaOrg.id), /no está vacía/);

  // Con un pase que limita las carpetas a otras, no se ve nada.
  const limitado = quienEs({ app: "asambleas", usuario: "l", alias: "Lince", ambitos: [{ id: "comun" }], carpetas: ["Libros"] }, app);
  assert.deepEqual((await biblioteca.ver(limitado)).carpetas, []);

  // Imágenes: solo la administración, solo imágenes de verdad.
  // (sus carpetas de primer nivel no se limitan: son de cada organización)
  const imagenes = await biblioteca.crearCarpeta(admin, { clase: "imagen", nombre: "ORG 1", dueno: "asambleas:o1" });
  await assert.rejects(biblioteca.subirImagen(lince, { carpeta: imagenes.id, nombre: "Yo", bytes: PNG }), /administración/);
  await assert.rejects(biblioteca.subirImagen(admin, { carpeta: imagenes.id, nombre: "Texto", dueno: "asambleas:comun", bytes: Buffer.from("hola") }), /PNG/);
  const logo = await biblioteca.subirImagen(admin, { carpeta: imagenes.id, nombre: "Logo", dueno: "asambleas:o1", bytes: PNG });
  assert.deepEqual((await biblioteca.imagen(lince, logo.id)).bytes, PNG);
  assert.equal(await biblioteca.imagen(nutria, logo.id), null);

  // En el disco no se lee nada: ni los nombres ni la imagen.
  const indice = await readFile(join(carpeta, "biblioteca", "indice.cif"));
  assert.ok(!indice.includes("Mi acta"));
  const [fichero] = await readdir(join(carpeta, "biblioteca", "imagenes"));
  assert.ok(!(await readFile(join(carpeta, "biblioteca", "imagenes", fichero))).includes(PNG.subarray(8, 24)));
  // Y otra biblioteca sobre la misma carpeta (al reiniciar) lo lee igual; con otra clave, no.
  const reiniciada = crearBiblioteca({ carpeta, clave: CLAVE });
  assert.deepEqual((await reiniciada.ver(lince)).elementos.map((e) => e.nombre), await nombres(lince));
  await assert.rejects(crearBiblioteca({ carpeta, clave: randomBytes(32) }).ver(lince));
});

test("las direcciones HTTP y la compilación con plantilla, membrete e imagen", async () => {
  const carpeta = await mkdtemp(join(tmpdir(), "editor-"));
  const servidor = crearServidor({ aplicaciones: { asambleas: { secreto: SECRETO, url: "http://127.0.0.1:1", carpetas: ["Actas"] } }, carpeta, clave: CLAVE });
  await servidor.listen(0);
  const base = `http://127.0.0.1:${servidor.address.port}`;
  try {
    const pase = (usuario, ambitos, extra = {}) =>
      crearPase({ app: "asambleas", sala: "biblioteca", alias: usuario, permiso: "leer", usuario, ambitos, exp: Math.floor(Date.now() / 1000) + 300, ...extra }, SECRETO);
    const deAdmin = pase("a", [{ id: "comun", nombre: "Toda", cambiar: true }]);
    // Llama a la biblioteca con un pase; devuelve [estado, cuerpo leído].
    const pedir = async (camino, { pase: elPase = deAdmin, metodo = "GET", cuerpo } = {}) => {
      const respuesta = await fetch(base + camino, { method: metodo, headers: { Authorization: `Bearer ${elPase}` }, body: cuerpo && !Buffer.isBuffer(cuerpo) ? JSON.stringify(cuerpo) : cuerpo });
      const tipo = respuesta.headers.get("content-type") || "";
      return [respuesta.status, tipo.includes("json") ? await respuesta.json() : await respuesta.text()];
    };

    assert.equal((await pedir("/biblioteca", { pase: "malo" }))[0], 403);
    // Sin usuario en el pase, no hay biblioteca.
    assert.equal((await pedir("/biblioteca", { pase: crearPase({ app: "asambleas", sala: "x", alias: "x", permiso: "leer", exp: Math.floor(Date.now() / 1000) + 300 }, SECRETO) }))[0], 403);

    const [, plantillas] = await pedir("/biblioteca/carpetas", { metodo: "POST", cuerpo: { clase: "plantilla", nombre: "Actas", dueno: "asambleas:comun" } });
    const [, membretes] = await pedir("/biblioteca/carpetas", { metodo: "POST", cuerpo: { clase: "membrete", nombre: "Actas", dueno: "asambleas:comun" } });
    const [, imagenes] = await pedir("/biblioteca/carpetas", { metodo: "POST", cuerpo: { clase: "imagen", nombre: "Actas", dueno: "asambleas:comun" } });
    const [estado, logo] = await pedir(`/biblioteca/imagenes?carpeta=${imagenes.id}&nombre=Logo&dueno=asambleas:comun`, { metodo: "POST", cuerpo: PNG });
    assert.equal(estado, 200);
    const [, plantilla] = await pedir("/biblioteca/elementos", {
      metodo: "POST", cuerpo: { clase: "plantilla", carpeta: plantillas.id, nombre: "Acta", dueno: "asambleas:comun", datos: { aspecto: '#set text(size: 12pt)\n#heading(titulo)', texto: "# Acta" } },
    });
    const [, membrete] = await pedir("/biblioteca/elementos", {
      metodo: "POST", cuerpo: { clase: "membrete", carpeta: membretes.id, nombre: "ORG", dueno: "asambleas:comun", datos: { cabecera: `#image("/imagenes/${logo.id}", height: 1cm) Cabecera de prueba`, pie: "Pie de prueba" } },
    });

    // La imagen se ve con el pase (también en la dirección, para <img>) y no sin él.
    const respuesta = await fetch(`${base}/biblioteca/imagenes/${logo.id}?pase=${encodeURIComponent(deAdmin)}`);
    assert.equal(respuesta.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await respuesta.arrayBuffer()), PNG);
    assert.equal((await pedir(`/biblioteca/imagenes/${logo.id}`, { pase: pase("n", []) }))[0], 404);

    // Previsualizar una cabecera y pie mientras se escribe.
    const [estadoPrevia, svg] = await pedir("/biblioteca/previa", { metodo: "POST", cuerpo: { texto: "Hola", cabecera: "Arriba", pie: "Abajo" } });
    assert.equal(estadoPrevia, 200);
    assert.match(svg, /<svg/);

    // Lo ve todo el mundo de la aplicación con «comun»: GET /biblioteca.
    const [, vista] = await pedir("/biblioteca", { pase: pase("l", [{ id: "comun", nombre: "Toda" }]) });
    assert.deepEqual(vista.elementos.map((e) => e.nombre).sort(), ["Acta", "Logo", "ORG"]);
    assert.equal(vista.elementos.find((e) => e.nombre === "Acta").puedeCambiar, false);

    // Una sala que ha elegido plantilla y membrete compila con ellos (y con la imagen). Se deja su copia en
    // el disco, como si alguien la hubiera escrito antes.
    const { componer } = await import("../src/typst.mjs");
    assert.match(componer("x", "markdown", "T", { aspecto: plantilla.datos.aspecto, membrete: membrete.datos }), /Cabecera de prueba/);
    const documento = new Y.Doc();
    documento.getText("texto").insert(0, `Hola ![logo](imagen:${logo.id})`);
    documento.getMap("opciones").set("plantilla", plantilla.id);
    documento.getMap("opciones").set("membrete", membrete.id);
    await guardar(carpeta, "asambleas/documentos.documento:5", Y.encodeStateAsUpdate(documento), 1);
    const paseDeSala = pase("l", [{ id: "comun", nombre: "Toda" }], { sala: "documentos.documento:5" });
    const pdf = await fetch(`${base}/pdf?pase=${encodeURIComponent(paseDeSala)}`);
    assert.equal(pdf.status, 200, await pdf.clone().text());
    // Con la vista: el SVG lleva la imagen (incrustada) y el texto de la cabecera.
    const vistaTypst = await fetch(`${base}/render`, { method: "POST", body: new URLSearchParams({ pase: paseDeSala }) });
    const dibujo = await vistaTypst.text();
    assert.equal(vistaTypst.status, 200, dibujo);
    assert.match(dibujo, /<image/);
  } finally {
    await servidor.destroy();
  }
});
