import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { documentTextLooksUsable, hasPptxEnhancedParser, parseLocalDocument, supportsLocalDocumentParsing } from '../document-parser.js';

function textPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('local document parser accepts only the supported binary formats', () => {
  assert.equal(supportsLocalDocumentParsing('report.pdf'), true);
  assert.equal(supportsLocalDocumentParsing('brief.DOCX'), true);
  assert.equal(supportsLocalDocumentParsing('deck.PPTX'), true);
  assert.equal(supportsLocalDocumentParsing('show.ppsx'), true);
  assert.equal(supportsLocalDocumentParsing('legacy.doc'), false);
  assert.equal(supportsLocalDocumentParsing('../report.pdf.exe'), false);
});

test('PPTX enhanced parser is enabled only by its isolated component marker', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-pptx-component-test-'));
  const previous = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = root;
  try {
    assert.equal(await hasPptxEnhancedParser(), false);
    const component = path.join(root, 'components', 'pptx-enhanced');
    mkdirSync(component, { recursive: true });
    writeFileSync(path.join(component, 'installed.json'), '{"schemaVersion":1}');
    assert.equal(await hasPptxEnhancedParser(), true);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR;
    else process.env.OPENCLAWX_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('document quality gate rejects empty and replacement-heavy output', () => {
  assert.equal(documentTextLooksUsable('short'), false);
  assert.equal(documentTextLooksUsable('A useful paragraph '.repeat(10)), true);
  assert.equal(documentTextLooksUsable(`Readable ${'�'.repeat(100)}`), false);
});

test('DOCX base parsing stays inside Node and does not require packaged Python', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Portable Word extraction &amp; packaging verification.</w:t></w:r></w:p></w:body></w:document>';
  const bytes = Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));
  const previousPython = process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  process.env.OPENCLAWX_AGENTSCOPE_PYTHON = path.join(os.tmpdir(), 'python-that-does-not-exist');
  try {
    const result = await parseLocalDocument({ fileName: 'portable.docx', bytes });
    assert.equal(result.parser, 'builtin');
    assert.equal(result.markdown, 'Portable Word extraction & packaging verification.');
  } finally {
    if (previousPython === undefined) delete process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
    else process.env.OPENCLAWX_AGENTSCOPE_PYTHON = previousPython;
  }
});

test('PDF base parsing stays inside Node and does not require packaged Python', async () => {
  const previousPython = process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  process.env.OPENCLAWX_AGENTSCOPE_PYTHON = path.join(os.tmpdir(), 'python-that-does-not-exist');
  try {
    const result = await parseLocalDocument({ fileName: 'portable.pdf', bytes: textPdf('Portable PDF extraction verification content.') });
    assert.equal(result.parser, 'builtin');
    assert.match(result.markdown, /Portable PDF extraction verification content/);
  } finally {
    if (previousPython === undefined) delete process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
    else process.env.OPENCLAWX_AGENTSCOPE_PYTHON = previousPython;
  }
});

test('document parser invokes the isolated runtime and consumes structured output', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-parser-test-'));
  const packageRoot = path.join(root, 'src', 'openclawx_agentscope_runtime');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, '__init__.py'), '');
  writeFileSync(path.join(packageRoot, 'document_parser.py'), [
    'import json, sys',
    'print(json.dumps({"markdown": "# Parsed\\n\\n" + "content " * 20, "parser": "markitdown", "warnings": []}))',
  ].join('\n'));
  const previousRoot = process.env.OPENCLAWX_AGENTSCOPE_ROOT;
  const previousPython = process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  const previousData = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_AGENTSCOPE_ROOT = root;
  process.env.OPENCLAWX_DATA_DIR = root;
  delete process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
  const component = path.join(root, 'components', 'pptx-enhanced');
  mkdirSync(component, { recursive: true });
  writeFileSync(path.join(component, 'installed.json'), '{"schemaVersion":1}');
  try {
    const result = await parseLocalDocument({ fileName: 'brief.pptx', bytes: Buffer.from('test') });
    assert.equal(result.parser, 'markitdown');
    assert.match(result.markdown, /^# Parsed/);
  } finally {
    if (previousRoot === undefined) delete process.env.OPENCLAWX_AGENTSCOPE_ROOT;
    else process.env.OPENCLAWX_AGENTSCOPE_ROOT = previousRoot;
    if (previousData === undefined) delete process.env.OPENCLAWX_DATA_DIR;
    else process.env.OPENCLAWX_DATA_DIR = previousData;
    if (previousPython === undefined) delete process.env.OPENCLAWX_AGENTSCOPE_PYTHON;
    else process.env.OPENCLAWX_AGENTSCOPE_PYTHON = previousPython;
    rmSync(root, { recursive: true, force: true });
  }
});
