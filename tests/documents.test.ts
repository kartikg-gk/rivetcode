import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocument } from "../src/daemon/documents.js";

describe("document extraction", () => {
  it("extracts DOCX text without rendering document HTML", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>document-marker</w:t></w:r></w:p></w:body></w:document>');
    const base64 = await zip.generateAsync({ type: "base64" });
    expect(await extractDocument({ name: "example.docx", base64 })).toMatchObject({ text: expect.stringContaining("document-marker"), truncated: false });
  });

  it("extracts a PDF text page", async () => {
    const stream = "BT /F1 12 Tf 10 10 Td (pdf-marker) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(await extractDocument({ name: "example.pdf", base64: Buffer.from(pdf).toString("base64") })).toMatchObject({ text: expect.stringContaining("pdf-marker") });
  });

  it("rejects invalid documents and reports truncated previews", async () => {
    await expect(extractDocument({ name: "bad.pdf", base64: Buffer.from("invalid").toString("base64") })).rejects.toThrow("Document preview failed");
    expect(await extractDocument({ name: "long.txt", base64: Buffer.from("x".repeat(40000)).toString("base64") })).toMatchObject({ truncated: true, text: "x".repeat(32000) });
  });
});
