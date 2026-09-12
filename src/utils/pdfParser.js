/**
 * pdfParser.js — Client-side and offline PDF text extraction using pdfjs-dist.
 * Preserves tabular / line-by-line structure for CAS statements.
 */
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';

if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

/**
 * Extracts line-ordered text from a PDF ArrayBuffer or Uint8Array.
 * Groups text tokens on similar vertical coordinates (Y) to keep statement lines intact.
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @returns {Promise<string>}
 */
export async function extractTextFromPDF(input) {
  let data;
  if (input instanceof ArrayBuffer) {
    data = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    data = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (input && typeof input.arrayBuffer === 'function') {
    const ab = await input.arrayBuffer();
    data = new Uint8Array(ab);
  } else {
    data = new Uint8Array(input);
  }

  const getDoc = pdfjsLib.getDocument || pdfjsLib.default?.getDocument;
  
  const loadingTask = getDoc({
    data,
    useSystemFonts: true,
    disableFontFace: true
  });

  const pdfDoc = await loadingTask.promise;
  let fullText = '';

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = (textContent.items || []).filter(it => it.str && it.str.trim());

    // Deterministic line clustering by Y-coordinate, then sorted by X-coordinate
    const lineBuckets = [];
    for (const item of items) {
      const x = item.transform ? item.transform[4] : 0;
      const y = item.transform ? item.transform[5] : 0;
      let foundBucket = null;
      for (const bucket of lineBuckets) {
        if (Math.abs(bucket.y - y) <= 3) {
          foundBucket = bucket;
          break;
        }
      }
      if (foundBucket) {
        foundBucket.items.push({ str: item.str.trim(), x });
      } else {
        lineBuckets.push({ y, items: [{ str: item.str.trim(), x }] });
      }
    }

    // Sort lines top-to-bottom (PDF coordinate Y decreases going down)
    lineBuckets.sort((a, b) => b.y - a.y);

    const pageLines = [];
    for (const bucket of lineBuckets) {
      // Sort words in line left-to-right
      bucket.items.sort((a, b) => a.x - b.x);
      pageLines.push(bucket.items.map(it => it.str).join(' '));
    }

    fullText += `\n--- Page ${pageNum} ---\n` + pageLines.join('\n');
  }

  return fullText;
}
