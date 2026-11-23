/**
 * Generatore XML in formato Danea EasyFatt (tracciato "EasyfattDocuments").
 * Produce il documento di un ordine da importare in EasyFatt.
 *
 * NOTA: il tracciato EasyFatt ha molti campi opzionali; questo copre i
 * principali per corrispettivo/fattura di vendita online. Da validare con
 * UN import di prova nella tua versione di EasyFatt e rifinire se serve.
 */

export interface EasyfattRow {
  code?: string;      // SKU
  description: string;
  qty: number;
  price: number;      // prezzo unitario IVA INCLUSA (lordo)
  vatPercent: number; // es. 22
}

export interface EasyfattDoc {
  // "I" = Fattura, "C" = Corrispettivo (vendita senza fattura)
  documentType: "I" | "C";
  number?: string;        // lascia vuoto per numerazione automatica di EasyFatt
  date: string;           // YYYY-MM-DD
  customerName: string;
  customerAddress?: string;
  customerPostcode?: string;
  customerCity?: string;
  customerProvince?: string;
  customerCountry?: string;  // "IT"
  customerVat?: string;      // P.IVA
  customerTaxCode?: string;  // Codice Fiscale
  customerEmail?: string;
  customerSdi?: string;      // Codice destinatario SdI
  customerPec?: string;
  rows: EasyfattRow[];
  shippingCost?: number;     // IVA inclusa
  shippingVatPercent?: number;
  paymentName?: string;      // es. "Stripe"
  externalNumber?: string;   // nostro riferimento ordine
}

const esc = (s: string | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const num = (n: number) => n.toFixed(2);

// Prezzo netto (imponibile) da lordo IVA inclusa
const netOf = (gross: number, vat: number) => gross / (1 + vat / 100);

export function buildEasyfattXml(doc: EasyfattDoc): string {
  const rowsXml = doc.rows.map((r) => {
    const netUnit = netOf(r.price, r.vatPercent);
    return `   <Row>
    <Code>${esc(r.code)}</Code>
    <Description>${esc(r.description)}</Description>
    <Qty>${r.qty}</Qty>
    <Um>pz</Um>
    <Price>${num(netUnit)}</Price>
    <Discounts></Discounts>
    <VatCode Perc="${r.vatPercent}" Class="Imponibile">${r.vatPercent}</VatCode>
    <Total>${num(netUnit * r.qty)}</Total>
   </Row>`;
  }).join("\n");

  const shipXml = (doc.shippingCost && doc.shippingCost > 0)
    ? `   <Row>
    <Description>Spese di spedizione</Description>
    <Qty>1</Qty>
    <Price>${num(netOf(doc.shippingCost, doc.shippingVatPercent ?? 22))}</Price>
    <VatCode Perc="${doc.shippingVatPercent ?? 22}" Class="Imponibile">${doc.shippingVatPercent ?? 22}</VatCode>
   </Row>`
    : "";

  // Totale documento lordo
  const grossTotal = doc.rows.reduce((s, r) => s + r.price * r.qty, 0) + (doc.shippingCost ?? 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<EasyfattDocuments AppVersion="2" Creator="FM Design Shop">
 <Documents>
  <Document>
   <DocumentType>${doc.documentType}</DocumentType>
   ${doc.number ? `<Number>${esc(doc.number)}</Number>` : ""}
   <Date>${doc.date}</Date>
   <CustomerName>${esc(doc.customerName)}</CustomerName>
   <CustomerAddress>${esc(doc.customerAddress)}</CustomerAddress>
   <CustomerPostcode>${esc(doc.customerPostcode)}</CustomerPostcode>
   <CustomerCity>${esc(doc.customerCity)}</CustomerCity>
   <CustomerProvince>${esc(doc.customerProvince)}</CustomerProvince>
   <CustomerCountry>${esc(doc.customerCountry ?? "IT")}</CustomerCountry>
   <CustomerVatCode>${esc(doc.customerVat)}</CustomerVatCode>
   <CustomerTel></CustomerTel>
   <CustomerEmail>${esc(doc.customerEmail)}</CustomerEmail>
   <CustomerFiscalCode>${esc(doc.customerTaxCode)}</CustomerFiscalCode>
   <CustomerEInvoiceDestCode>${esc(doc.customerSdi)}</CustomerEInvoiceDestCode>
   <CustomerPecEmail>${esc(doc.customerPec)}</CustomerPecEmail>
   <PaymentName>${esc(doc.paymentName ?? "Stripe")}</PaymentName>
   <InternalComment>Ordine web ${esc(doc.externalNumber)}</InternalComment>
   <Total>${num(grossTotal)}</Total>
   <Rows>
${rowsXml}${shipXml ? "\n" + shipXml : ""}
   </Rows>
  </Document>
 </Documents>
</EasyfattDocuments>`;
}
