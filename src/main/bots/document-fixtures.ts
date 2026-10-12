import AdmZip from "adm-zip"

export function wordDocument(text: string): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    )
  )
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    )
  )
  return zip.toBuffer()
}

export function pdfDocument(texts: string[]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]
  for (let i = 0; i < texts.length; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    )
    const content = `BT /F1 12 Tf 10 250 Td (${texts[i]}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  return pdfObjects(objects)
}

export function scannedPdfDocument(
  image: Buffer,
  width = 300,
  height = 150,
  rotate = 0,
  pageWidth = width,
  pageHeight = height
): Buffer {
  const content = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q`
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Rotate ${rotate} /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`
      ),
      image,
      Buffer.from("\nendstream")
    ])
  ])
}

function pdfObjects(objects: (string | Buffer)[]): Buffer {
  let source = Buffer.from("%PDF-1.7\n")
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source = Buffer.concat([
      source,
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof object === "string" ? Buffer.from(object) : object,
      Buffer.from("\nendobj\n")
    ])
  }
  const xref = Buffer.byteLength(source)
  const trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.concat([source, Buffer.from(trailer)])
}

export function presentationDocument(external = false): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    "ppt/presentation.xml",
    Buffer.from(
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="second"/><p:sldId id="2" r:id="first"/></p:sldIdLst></p:presentation>'
    )
  )
  zip.addFile(
    "ppt/_rels/presentation.xml.rels",
    Buffer.from(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${external ? "https://example.com/secret" : "slides/slide2.xml"}" ${external ? 'TargetMode="External"' : ""}/></Relationships>`
    )
  )
  for (const [i, text] of ["Second slide", "First slide"].entries())
    zip.addFile(
      `ppt/slides/slide${i + 1}.xml`,
      Buffer.from(
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`
      )
    )
  return zip.toBuffer()
}
