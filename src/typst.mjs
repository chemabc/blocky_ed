// De texto a Typst: convierte el Markdown a Typst y lo mete en una plantilla (cabecera, márgenes, letra).
// Si el texto ya está escrito en Typst, solo le pone la plantilla. Lo usa renderizador.mjs antes de
// compilar, y las pruebas.
//
// Markdown → Typst: se lee el Markdown con markdown-it (MIT) en una lista de piezas (título, párrafo,
// lista, tabla, negrita…) y cada pieza se escribe con su equivalente en Typst. Todo lo escrito por las
// personas se «escapa» (se le pone \ delante a los signos que en Typst significan algo), para que un
// asterisco suelto no se convierta en negrita ni un # en código.

import MarkdownIt from "markdown-it";

// Lector de Markdown: sin HTML (como en la plataforma) y con tablas.
const lector = new MarkdownIt({ html: false, linkify: false });

// Signos que en Typst significan algo dentro del texto y hay que escapar.
const ESPECIALES = /[\\*_#$@<>[\]`~/]/g;

// Escapa un trozo de texto para que Typst lo ponga tal cual. Los signos que solo cuentan al principio de
// una línea (=, -, +, números con punto) se escapan también ahí.
export function escapar(texto) {
  return texto.replace(ESPECIALES, (signo) => `\\${signo}`).replace(/^(\s*)([=+-]|\d+\.)/gm, (_, espacio, signo) => `${espacio}\\${signo}`);
}

// Texto entre comillas para Typst («"…"», con las comillas y las barras escapadas).
function cadena(texto) {
  return JSON.stringify(texto);
}

// Convierte las piezas de dentro de una línea (negrita, cursiva, enlaces, código…) a Typst.
function enLinea(piezas) {
  let salida = "";
  for (const pieza of piezas) {
    switch (pieza.type) {
      case "text":
        salida += escapar(pieza.content);
        break;
      case "strong_open":
        salida += "#strong[";
        break;
      case "em_open":
        salida += "#emph[";
        break;
      case "s_open":
        salida += "#strike[";
        break;
      case "link_open":
        salida += `#link(${cadena(pieza.attrGet("href") || "")})[`;
        break;
      case "strong_close":
      case "em_close":
      case "s_close":
      case "link_close":
        salida += "]";
        break;
      case "code_inline":
        salida += `#raw(${cadena(pieza.content)})`;
        break;
      case "softbreak":
        salida += "\n";
        break;
      case "hardbreak":
        salida += " \\\n";
        break;
      case "image": {
        // Las de la biblioteca («imagen:<número>») se ponen; las de otras webs no se descargan: se pone su
        // texto alternativo.
        const de = /^imagen:([0-9a-f]{16})$/.exec(pieza.attrGet("src") || "");
        salida += de ? `#box(image(${cadena(`/imagenes/${de[1]}`)}, alt: ${cadena(pieza.content || "imagen")}))` : `[${escapar(pieza.content || "imagen")}]`;
        break;
      }
      default:
        salida += escapar(pieza.content || "");
    }
  }
  return salida;
}

// Convierte un texto Markdown entero a Typst.
export function markdownATypst(texto) {
  const piezas = lector.parse(texto || "", {});
  const listas = []; // pila de listas abiertas: { numero } (numeradas, el siguiente número) o {} (viñetas)
  let salida = "";
  let prefijo = ""; // lo que va delante de la próxima línea (la marca de un elemento de lista)
  let tabla = null; // la tabla que se está leyendo: { columnas, celdas, cabecera }
  let celda = null;
  for (const pieza of piezas) {
    switch (pieza.type) {
      case "heading_open":
        salida += `${"=".repeat(Number(pieza.tag.slice(1)))} `;
        break;
      case "heading_close":
        salida += "\n\n";
        break;
      case "paragraph_close":
        if (!pieza.hidden) salida += "\n\n";
        else if (!tabla) salida += "\n";
        break;
      case "bullet_list_open":
      case "ordered_list_open":
        listas.push(pieza.type === "bullet_list_open" ? {} : { numero: Number(pieza.attrGet("start") || 1) });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listas.pop();
        if (!listas.length) salida += "\n";
        break;
      case "list_item_open":
        // Las numeradas llevan su número («3.»), así se respeta si la lista no empieza por 1.
        prefijo = `${"  ".repeat(listas.length - 1)}${listas.at(-1).numero === undefined ? "-" : `${listas.at(-1).numero++}.`} `;
        break;
      case "blockquote_open":
        salida += "#quote(block: true)[\n";
        break;
      case "blockquote_close":
        salida += "]\n\n";
        break;
      case "fence":
      case "code_block":
        salida += `#raw(block: true, ${cadena(pieza.content.replace(/\n$/, ""))})\n\n`;
        break;
      case "hr":
        salida += "#line(length: 100%)\n\n";
        break;
      case "table_open":
        tabla = { columnas: 0, celdas: [], cabecera: false };
        break;
      case "thead_open":
        tabla.cabecera = true;
        break;
      case "thead_close":
        tabla.cabecera = false;
        break;
      case "th_open":
      case "td_open":
        celda = "";
        if (tabla.cabecera) tabla.columnas += 1;
        break;
      case "th_close":
        tabla.celdas.push(`[#strong[${celda}]]`);
        celda = null;
        break;
      case "td_close":
        tabla.celdas.push(`[${celda}]`);
        celda = null;
        break;
      case "table_close":
        salida += `#table(columns: ${Math.max(tabla.columnas, 1)}, ${tabla.celdas.join(", ")})\n\n`;
        tabla = null;
        break;
      case "inline":
        if (celda !== null) celda += enLinea(pieza.children);
        else {
          salida += prefijo + enLinea(pieza.children);
          prefijo = "";
        }
        break;
      default:
        break;
    }
  }
  return salida.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Pone delante del texto ya en Typst la plantilla común (A4, márgenes, letra, número de página) y, si el
// documento los ha elegido, el aspecto de su plantilla y su cabecera y pie (ver biblioteca.mjs).
//   - titulo: el título del documento. Va en los metadatos del PDF y en la variable «titulo», que las
//     plantillas pueden usar. Sin plantilla, se pone arriba de la primera página.
//   - aspecto: el Typst de la plantilla elegida (reglas «#set», «#show»…), o "".
//   - membrete: { cabecera, pie } en Typst, o null. El pie vacío deja el número de página.
export function plantilla(cuerpo, titulo = "", { aspecto = "", membrete = null } = {}) {
  const cabecera = [
    `#let titulo = ${cadena(titulo || "")}`,
    `#set document(title: ${cadena(titulo || "Documento")})`,
    '#set page(paper: "a4", margin: 2cm, numbering: "1 / 1")',
    '#set text(lang: "es", size: 11pt)',
    "#set par(justify: true)",
    membrete?.cabecera?.trim() ? `#set page(header: [${membrete.cabecera}])` : "",
    membrete?.pie?.trim() ? `#set page(footer: [${membrete.pie}])` : "",
    aspecto.trim(),
    titulo && !aspecto.trim() ? `#align(center, text(size: 17pt, weight: "bold", ${cadena(titulo)}))` : "",
  ];
  return `${cabecera.filter(Boolean).join("\n")}\n\n${cuerpo}`;
}

// Prepara el texto de una sala para compilarlo: Markdown se convierte; Typst va tal cual. Lanza un error
// si algo (el texto, la plantilla o el membrete) intenta usar paquetes de fuera (se descargarían de internet).
//   - formato: «markdown» o «typst».
//   - extras: { aspecto, membrete } (ver plantilla()).
export function componer(texto, formato = "markdown", titulo = "", extras = {}) {
  const fuente = plantilla(formato === "typst" ? texto : markdownATypst(texto), titulo, extras);
  if (/@(preview|local)\//.test(fuente)) throw new Error("No se pueden usar paquetes de Typst («@preview/…»).");
  return fuente;
}

// Los números de las imágenes de la biblioteca que usa un Typst ya compuesto («/imagenes/<número>»).
export function imagenesUsadas(fuente) {
  return [...new Set([...fuente.matchAll(/\/imagenes\/([0-9a-f]{16})/g)].map((encontrado) => encontrado[1]))];
}
