import AdmZip from "adm-zip"
import XLSX from "xlsx"

const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships"
const relationship = (id, type, target) =>
  '<Relationship Id="' + id + '" Type="' + office + '/' + type + '" Target="' + target + '"/>'
const relationships = (...entries) =>
  '<Relationships xmlns="' + packageRelationships + '">' + entries.join("") + '</Relationships>'
const add = (zip, path, value) => zip.addFile(path, Buffer.from(value))

export function visualDocx(pngs, { imageOnly = false, missingRelationship = false } = {}) {
  const zip = new AdmZip()
  const image = index => '<w:drawing><wp:inline><wp:docPr id="' + index +
    '" name="Image"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="pic' +
    index + '"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
  const p = body => '<w:p><w:r>' + body + '</w:r></w:p>'
  const body = [...pngs.keys()].map(index => {
    const text = imageOnly ? "" : '<w:t>Row ' + (index + 1) + '</w:t>'
    return index === 1
      ? '<w:tbl><w:tr><w:tc>' + p(text + image(index)) + '</w:tc></w:tr></w:tbl>'
      : p(text + image(index))
  }).join("")
  add(zip, "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  add(zip, "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="' + office +
    '"><w:body>' + body + '</w:body></w:document>')
  add(zip, "word/_rels/document.xml.rels", relationships(...pngs.flatMap((png, index) => {
    if (missingRelationship && index === 0) return []
    if (png) add(zip, "word/media/p" + index + ".png", png)
    return [relationship("pic" + index, "image", "media/p" + index + ".png")]
  })))
  return zip.toBuffer()
}

export function visualXlsx(png) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Code", 147]]), "Report")
  const zip = new AdmZip(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
  const sheet = zip.readAsText("xl/worksheets/sheet1.xml")
  add(zip, "xl/worksheets/sheet1.xml", sheet.replace("</worksheet>",
    '<drawing xmlns:r="' + office + '" r:id="drawing1"/></worksheet>'))
  add(zip, "xl/worksheets/_rels/sheet1.xml.rels",
    relationships(relationship("drawing1", "drawing", "../drawings/drawing1.xml")))
  add(zip, "xl/drawings/drawing1.xml",
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + office + '">' +
    '<xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:row>4</xdr:row></xdr:from>' +
    '<xdr:pic><xdr:blipFill><a:blip r:embed="pic"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor>' +
    '<xdr:absoluteAnchor><xdr:graphicFrame><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>' +
    '</xdr:graphicFrame></xdr:absoluteAnchor></xdr:wsDr>')
  add(zip, "xl/drawings/_rels/drawing1.xml.rels", relationships(relationship("pic", "image", "../media/p.png")))
  add(zip, "xl/media/p.png", png)
  return zip.toBuffer()
}
