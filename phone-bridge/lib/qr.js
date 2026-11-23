// 二维码：把配对链接渲染成 SVG。编码器是 MIT 许可的 qrcode-generator（见 vendor/）。
// 纯本地生成，不联网、不依赖浏览器。
import createQr from './vendor/qrcode-generator.cjs';

/**
 * @param {string} text 要编码的内容
 * @param {{ecc?: 'L'|'M'|'Q'|'H'}} [options]
 * @returns {{size: number, rows: boolean[][]}}
 */
export function qrMatrix(text, options = {}) {
  const qr = createQr(0, options.ecc ?? 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) line.push(qr.isDark(row, col));
    rows.push(line);
  }
  return { size, rows };
}

/**
 * 生成可直接内联进 HTML 的 SVG。
 * @param {string} text
 * @param {{scale?: number, margin?: number, ecc?: 'L'|'M'|'Q'|'H', dark?: string, light?: string}} [options]
 */
export function qrSvg(text, options = {}) {
  const { size, rows } = qrMatrix(text, { ecc: options.ecc });
  const scale = options.scale ?? 8;
  const margin = options.margin ?? 4;
  const dimension = (size + margin * 2) * scale;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';

  let path = '';
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!rows[row][col]) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < size && rows[row][col + run]) run += 1;
      const x = (margin + col) * scale;
      const y = (margin + row) * scale;
      path += `M${x} ${y}h${run * scale}v${scale}h${-run * scale}z`;
      col += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" aria-label="配对二维码">` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
