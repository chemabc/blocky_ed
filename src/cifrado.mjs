// Cifrado de lo que el editor guarda en disco de la biblioteca (plantillas, fragmentos, cabeceras y pies, e
// imágenes).
//
// Se usa AES-256-GCM (del módulo «crypto» de Node, sin librerías): cifra y, además, sella. Si alguien
// cambia un solo byte del fichero, al leerlo da error en vez de devolver basura. Cada fichero lleva su
// propio número al azar (iv), así dos textos iguales no se parecen cifrados.
//
// La clave (32 bytes, en base64) viene de la variable de entorno EDITOR_CLAVE. Sin ella, la biblioteca no se
// abre. Protege lo guardado si alguien se lleva el disco o una copia de seguridad; no protege de quien
// controla el servidor del editor mientras funciona (tiene la clave en memoria).
//
// Forma de cada fichero cifrado: iv (12 bytes) + sello (16 bytes) + datos cifrados.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Bytes del número al azar (iv) y del sello de GCM.
const IV = 12;
const SELLO = 16;

// Lee la clave de la variable de entorno (o del texto que se le pase). Devuelve un Buffer de 32 bytes o
// null si no hay. Lanza un error si hay algo pero no es una clave válida.
export function leerClave(texto = process.env.EDITOR_CLAVE || "") {
  if (!texto) return null;
  const clave = Buffer.from(texto, "base64");
  if (clave.length !== 32) throw new Error("EDITOR_CLAVE debe ser 32 bytes en base64 (por ejemplo: openssl rand -base64 32).");
  return clave;
}

// Cifra unos datos (texto o bytes).
//   - clave: la de leerClave().
//   - para: de qué es (por ejemplo, «indice» o el número de una imagen). Va sellado con los datos: así no
//     se puede cambiar un fichero cifrado por otro.
export function cifrar(datos, clave, para) {
  const iv = randomBytes(IV);
  const cifrador = createCipheriv("aes-256-gcm", clave, iv);
  cifrador.setAAD(Buffer.from(para));
  const cifrado = Buffer.concat([cifrador.update(Buffer.from(datos)), cifrador.final()]);
  return Buffer.concat([iv, cifrador.getAuthTag(), cifrado]);
}

// Descifra lo que cifró cifrar(). Devuelve un Buffer. Lanza un error si la clave no es la buena o si el
// fichero se ha tocado.
export function descifrar(bytes, clave, para) {
  const datos = Buffer.from(bytes);
  const descifrador = createDecipheriv("aes-256-gcm", clave, datos.subarray(0, IV));
  descifrador.setAAD(Buffer.from(para));
  descifrador.setAuthTag(datos.subarray(IV, IV + SELLO));
  return Buffer.concat([descifrador.update(datos.subarray(IV + SELLO)), descifrador.final()]);
}
