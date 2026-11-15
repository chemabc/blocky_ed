// Pruebas de la conversión a Typst (src/typst.mjs) y de la compilación (src/renderizador.mjs): los signos
// sueltos no se convierten en formato, las listas numeradas guardan su número, las tablas salen como
// #table, no se dejan usar paquetes de fuera y un texto de Typst con errores dice por qué.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { pararRenderizador, renderizar } from "../src/renderizador.mjs";
import { componer, escapar, markdownATypst } from "../src/typst.mjs";

after(() => pararRenderizador());

// Lo que en Typst significa algo se escapa.
test("escapar", () => {
  assert.equal(escapar("#1 @todos *no* a/b"), "\\#1 \\@todos \\*no\\* a\\/b");
  assert.equal(escapar("= no es título"), "\\= no es título");
});

// Títulos, negrita, enlaces, listas (con su número) y tablas.
test("de Markdown a Typst", () => {
  const typst = markdownATypst("## Puntos\n\n3. **Huerto** [ver](https://x.org)\n4. Agua\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.match(typst, /^== Puntos/);
  assert.match(typst, /3\. #strong\[Huerto\] #link\("https:\/\/x.org"\)\[ver\]/);
  assert.match(typst, /4\. Agua/);
  assert.match(typst, /#table\(columns: 2, \[#strong\[A\]\], \[#strong\[B\]\], \[1\], \[2\]\)/);
});

// Compila a SVG y a PDF; los paquetes de fuera y los errores se explican.
test("compilar", async () => {
  assert.match(await renderizar(componer("## Acta\n\n- uno", "markdown", "Acta"), "svg"), /<svg/);
  const pdf = await renderizar(componer("= Hola", "typst"), "pdf");
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), "%PDF");
  assert.throws(() => componer('#import "@preview/cetz:0.3.0"', "typst"), /paquetes/);
  await assert.rejects(renderizar(componer("#let x =", "typst"), "svg"), /expected/);
});
