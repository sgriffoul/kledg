/**
 * Full control tool on invoices: record a draft purchase or sales invoice,
 * optionally with its draft entry. A sales invoice follows the company's
 * numbering like the form (lib/invoices/create-in-qonto.service.ts
 * issueInvoice): created in Qonto first, numbered by Kledg's series when
 * posted, or recorded with the number it was issued with. A thin wrapper over
 * lib/invoices/manage-invoices.service.ts (totals computed on the server,
 * French VAT rates, tiers of the company, due date within L441-10) and
 * post-invoice.service.ts (fiscal year containing the date, accounts of
 * that year). Follows the connection's execution mode (approval in Kledg or
 * automatic): the dry run shows the totals the invoice would have.
 */

import { adoptPurchase } from '@/lib/invoices/adopt-purchase.service'
import { purchaseTermsSchema, checkPurchaseTerms } from '@/lib/invoices/purchase-terms'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { NotFoundError, ValidationError } from '@/lib/accounting/errors'
import { computeInvoiceTotals, parseQuantity, rateToBasisPoints } from '@/lib/invoices/amounts'
import { assertInvoiceAmountsFit } from '@/lib/invoices/amount-bounds'
import { AUTO_NUMBER_TYPED, INVOICE_NUMBERING_CHOICES } from '@/lib/invoices/manage-invoices.service'
import { issueInvoice, qontoFirstActive } from '@/lib/invoices/create-in-qonto.service'
import { loadNumberingSettings, peekNextNumber } from '@/lib/invoices/numbering/series'
import { postInvoice } from '@/lib/invoices/post-invoice.service'
import { analyzeEInvoice, importEInvoice, type EInvoiceAnalysis } from '@/lib/invoices/import-e-invoice.service'
import { findStagedReceipt } from '@/lib/receipts/stage-receipt.service'
import { receiptActorOf } from '@/lib/receipts/actor'
import { assertFileSize } from '@/lib/api/files'
import { enforceRateLimit } from '@/lib/rate-limit'
import { fromCents, toCents } from '@/lib/utils/money'
import { fullControlTool, type RegisterTool } from './define'
import { ACTS_AS_USER, TWO_STEP } from './descriptions'
import { companyLock, rowTargets } from './fingerprint'

const input = {
  purchaseTerms: purchaseTermsSchema.optional().describe("Purchase only. Lines in EUR, original USD gross total and dated units per EUR. Reverse charge rate in basis points for untaxed service lines. A wallet top-up uses line account 4091."),
  stagedReceiptId: z.string().min(1).max(100).optional().describe('Purchase only: original PDF from stage_receipt, filed with the invoice.'),
  direction: z.enum(['SALE', 'PURCHASE']).describe('SALE: invoice issued to a customer (journal VE); PURCHASE: invoice received from a supplier (journal AC).'),
  tiers: z.string().min(1).max(64).describe('Tiers id or auxiliary account number, from list_tiers (a customer for a sale, a supplier for a purchase).'),
  number: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe('Invoice number as printed on the document: required for a purchase, for numbering recorded and when the company types its numbers; omitted when Kledg (numbering kledg, automatic) or Qonto gives it.'),
  numbering: z
    .enum(INVOICE_NUMBERING_CHOICES)
    .optional()
    .describe('Sales only. qonto: created in Qonto, which gives the number and the PDF; kledg: Kledg numbers it in its series when posted (or the number is typed when the company numbers elsewhere); recorded: an invoice already issued elsewhere, with its own number, outside the series. Omitted: the company setting (get_company_settings section invoice_numbering).'),
  qontoStatus: z
    .enum(['draft', 'finalized'])
    .optional()
    .describe('Created in Qonto only. finalized (default): Qonto numbers the invoice at once; draft: a draft in Qonto, without number and not postable until a person finalizes it in Qonto (the Qonto import then brings its number).'),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu\u00a0: AAAA-MM-JJ'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu\u00a0: AAAA-MM-JJ').optional().describe('Defaults to the payment terms of the tiers or the company.'),
  creditNote: z.boolean().default(false).describe('true for a credit note (avoir, type 381).'),
  label: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        label: z.string().min(1).max(500),
        quantity: z.number().positive().max(1e9),
        unitPrice: z.number().min(0).max(1e11).describe('Unit price excluding tax, in euros, two decimals at most.'),
        vatRate: z.number().min(0).max(100).describe('VAT rate in percent: 20, 10, 5.5, 2.1 or 0 (also 13, 8.5, 1.75, 1.05, 0.9 for Corsica and overseas).'),
        accountCode: z.string().max(20).optional().describe('Expense (class 6), fixed asset (class 2) or revenue (class 7) account, from search_accounts.'),
        nature: z.enum(['GOODS', 'SERVICES']).default('SERVICES'),
        fixedAsset: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200),
  post: z.boolean().default(false).describe('true: also create its DRAFT entry (validated later by a person in Kledg).'),
}

type Args = z.infer<z.ZodObject<typeof input>> & { companyId: string }

async function resolveTiers(companyId: string, ref: string) {
  const tiers = await prisma.tiers.findFirst({
    where: { companyId, OR: [{ id: ref }, { auxiliaryAccountNumber: ref.toUpperCase() }] },
    select: { id: true, name: true, kind: true, auxiliaryAccountNumber: true },
  })
  if (!tiers) throw new NotFoundError('Tiers introuvable : utilisez list_tiers.')
  return tiers
}

function linesOf(args: Args) {
  return args.lines.map((line, i) => {
    const unitPriceCents = toCents(line.unitPrice)
    const vatRateBp = rateToBasisPoints(String(line.vatRate), 'percent')
    const quantity = parseQuantity(line.quantity)
    if (unitPriceCents === null || vatRateBp === null || quantity === null) {
      throw new ValidationError(`Ligne ${i + 1} : quantité (3 décimales), prix (2 décimales) ou taux de TVA invalide.`)
    }
    return { label: line.label, quantity: String(line.quantity), unitPriceCents, vatRateBp, accountCode: line.accountCode ?? null, nature: line.nature, fixedAsset: line.fixedAsset, quantityThousandths: quantity }
  })
}

/** How the invoice of `args` will be numbered, for the dry run, and what the numbering refuses. */
async function numberingPreview(args: Args): Promise<{ text: string; problem: string | null }> {
  if (args.direction === 'PURCHASE') return { text: 'Numéro du fournisseur, saisi tel quel.', problem: args.number ? null : 'Le numéro est requis' }
  const typeCode = args.creditNote ? '381' : '380'
  const choice = args.numbering ?? (args.qontoStatus ? 'qonto' : typeCode === '380' && !args.number && (await qontoFirstActive(args.companyId)) ? 'qonto' : 'kledg')
  if (choice === 'qonto') {
    return args.qontoStatus === 'draft'
      ? { text: 'Créée en brouillon dans Qonto : sans numéro jusqu’à sa finalisation dans Qonto.', problem: null }
      : { text: 'Créée dans Qonto : Qonto donne le numéro et le PDF.', problem: null }
  }
  if (choice === 'recorded') return { text: `Facture déjà émise, enregistrée sous le n° ${args.number ?? '(à préciser)'}.`, problem: args.number ? null : 'Le numéro est requis' }
  const settings = await loadNumberingSettings(prisma, args.companyId)
  if (settings.mode !== 'AUTO') return { text: `Numéro saisi : ${args.number ?? '(à préciser)'}.`, problem: args.number ? null : 'Le numéro est requis' }
  const next = await peekNextNumber(prisma, args.companyId, typeCode, args.issueDate, settings).catch(() => null)
  return {
    text: `Numéro attribué à la comptabilisation${next ? ` (prochain : ${next})` : ''}.`,
    problem: args.number ? AUTO_NUMBER_TYPED : null,
  }
}

const createDraftInvoiceTool = fullControlTool({
  name: 'create_draft_invoice',
  level: 'write',
  async authorizeArgs(args, ctx) {
    if (!ctx.access.canAdmin && (args.direction !== 'PURCHASE' || args.numbering || args.qontoStatus))
      throw new ValidationError('Cette connexion peut préparer les factures d’achat dans Kledg.')
  },
  title: 'Enregistrer une facture',
  description: `Records a purchase or sales invoice in Kledg as a draft (brouillon), with its lines and several VAT rates: totals are computed by Kledg (VAT per rate on the sum of the line totals, CGI ann. II art. 242 nonies A). A sales invoice follows the company's numbering (numbering): with Qonto-first it is created in Qonto (finalized there, Qonto's number and PDF; qontoStatus draft: a draft in Qonto, numbered once a person finalizes it there), else Kledg's series numbers it when it is posted, or the number typed is kept (an invoice already issued elsewhere: numbering recorded). With post: true it also creates the DRAFT entry (AC or VE journal) in the fiscal year containing the invoice date; a person validates it in Kledg. Kledg never sends the invoice to the customer. ${ACTS_AS_USER} ${TWO_STEP} The dry run shows the totals, the VAT breakdown and how the invoice will be numbered.`,
  input,
  permission: { entries: ['create'] },
  amounts: 'euros',
  units: 'VAT rates in percent, dates as yyyy-mm-dd.',
  never: 'sends the invoice to the customer or validates its entry (the entry stays a draft).',
  openWorld: true,
  targetState: ({ companyId, stagedReceiptId }) => [companyLock(companyId), ...rowTargets('staged_receipts', companyId, stagedReceiptId)],
  confirmation: true,
  async preview(args, ctx) {
    const receipt = args.stagedReceiptId
      ? await findStagedReceipt(args.companyId, args.stagedReceiptId, await receiptActorOf(ctx.access.user, args.companyId))
      : null
    const tiers = await resolveTiers(args.companyId, args.tiers)
    const lines = linesOf(args)
    const totals = computeInvoiceTotals(lines)
    assertInvoiceAmountsFit(totals)
    checkPurchaseTerms(args.purchaseTerms, args.direction, args.issueDate, totals.totalInclTaxCents, lines)
    const problems: string[] = []
    if ((args.direction === 'SALE') !== (tiers.kind === 'CUSTOMER')) problems.push(args.direction === 'SALE' ? 'Une facture de vente s’adresse à un client.' : 'Une facture d’achat vient d’un fournisseur.')
    if (receipt && (args.direction !== 'PURCHASE' || args.numbering || args.qontoStatus || !receipt.fileId || receipt.status !== 'staged' || receipt.contentType !== 'application/pdf' || receipt.expiresAt <= new Date())) {
      problems.push('Choisissez un PDF disponible pour cette facture fournisseur.')
    }
    const numbering = await numberingPreview(args)
    if (numbering.problem) problems.push(numbering.problem)
    return {
      tiers,
      number: args.number ?? null,
      numbering: numbering.text,
      totalExclTax: fromCents(totals.totalExclTaxCents),
      totalVat: fromCents(totals.totalVatCents),
      totalInclTax: fromCents(totals.totalInclTaxCents),
      vatBreakdown: totals.breakdown.map((row) => ({ ratePercent: row.vatRateBp / 100, base: fromCents(row.baseCents), vat: fromCents(row.vatCents) })),
      ...(receipt ? { document: { fileName: receipt.fileName, sha256: receipt.sha256 } } : {}),
      purchaseTerms: args.purchaseTerms,
      willPost: args.post,
      problems,
    }
  },
  async execute(args, ctx) {
    const tiers = await resolveTiers(args.companyId, args.tiers)
    const invoice = await issueInvoice(
      args.companyId,
      {
        direction: args.direction,
        tiersId: tiers.id,
        purchaseTerms: args.purchaseTerms,
        number: args.number ?? null,
        numbering: args.numbering,
        qontoStatus: args.qontoStatus,
        issueDate: args.issueDate,
        dueDate: args.dueDate ?? null,
        typeCode: args.creditNote ? '381' : '380',
        label: args.label ?? null,
        lines: linesOf(args).map((line) => ({ label: line.label, quantity: line.quantity, unitPriceCents: line.unitPriceCents, vatRateBp: line.vatRateBp, accountCode: line.accountCode, nature: line.nature, fixedAsset: line.fixedAsset })),
      },
      { source: 'mcp', ...(args.stagedReceiptId ? { purchaseReceipt: { id: args.stagedReceiptId, actor: await receiptActorOf(ctx.access.user, args.companyId) } } : {}) },
    )
    const posted = args.post ? await postInvoice(args.companyId, invoice.id, { source: 'mcp' }) : null
    return {
      invoiceId: invoice.id,
      number: posted?.number ?? invoice.number,
      origin: invoice.origin,
      status: posted ? 'posted' : 'draft',
      totalInclTax: fromCents(invoice.totalInclTaxCents),
      entryId: posted?.entryId ?? null,
      message: posted
        ? 'Facture enregistrée et écriture créée en brouillon\u00a0: elle doit être validée dans Kledg.'
        : 'Facture enregistrée en brouillon\u00a0: comptabilisez-la dans Kledg (ou rappelez l’outil avec post: true).',
    }
  },
  audit: (args, result) => ({ invoiceId: result.invoiceId, number: result.number ?? null, numbering: args.numbering ?? null, direction: args.direction, entryId: result.entryId }),
})

/** An e-invoice is small (the EN 16931 samples are under 100 kB, a Factur-X PDF a few hundred): 5 MB like a statement. */
const MAX_MCP_E_INVOICE_BYTES = 5 * 1024 * 1024

function decodeEInvoice(contentBase64: string): Uint8Array {
  const text = contentBase64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new ValidationError('Contenu du fichier invalide\u00a0: encodez-le en base64.')
  const bytes = new Uint8Array(Buffer.from(text, 'base64'))
  if (bytes.length === 0) throw new ValidationError('Fichier vide.')
  assertFileSize({ size: bytes.length }, MAX_MCP_E_INVOICE_BYTES)
  return bytes
}

/** The analysis in euros, as the other invoice tools give amounts. */
function inEuros(analysis: EInvoiceAnalysis) {
  return {
    format: analysis.format,
    number: analysis.number,
    creditNote: analysis.creditNote,
    issueDate: analysis.issueDate,
    dueDate: analysis.dueDate,
    supplier: analysis.supplier,
    lines: analysis.lines.map((line) => ({ label: line.label, quantity: line.quantity, unitPrice: fromCents(line.unitPriceCents), vatRatePercent: line.vatRateBp / 100, totalExclTax: fromCents(line.totalExclTaxCents) })),
    vatBreakdown: analysis.vatBreakdown.map((row) => ({ ratePercent: row.vatRateBp / 100, base: fromCents(row.baseCents), vat: fromCents(row.vatCents) })),
    totalExclTax: fromCents(analysis.totalExclTaxCents),
    totalVat: fromCents(analysis.totalVatCents),
    totalInclTax: fromCents(analysis.totalInclTaxCents),
    alreadyImported: analysis.alreadyImported,
    warnings: analysis.warnings,
  }
}

const importEInvoiceTool = fullControlTool({
  name: 'import_e_invoice',
  title: 'Importer une facture électronique',
  description: `Records a received e-invoice file (Factur-X PDF, CII or UBL XML, as delivered by the company's approved e-invoicing platform) as a DRAFT purchase invoice: the document's lines, VAT per rate and totals are kept as they are (checked with the EN 16931 rules), the supplier is found by SIREN, VAT number or name (created otherwise), and the file is kept in Kledg as received. Only an invoice addressed to the company is accepted. Importing the same file twice creates nothing the second time. A person then chooses the accounts and posts the invoice in Kledg (manage_invoice). ${ACTS_AS_USER} ${TWO_STEP} The dry run shows what the file holds, the supplier found and the warnings (reverse charge, lines summed per rate, advance already paid).`,
  input: {
    fileName: z.string().min(1).max(200).describe('Original file name, e.g. "facture-F2026-001.pdf" (.pdf Factur-X, .xml CII or UBL).'),
    contentBase64: z.string().min(1).max(Math.ceil((MAX_MCP_E_INVOICE_BYTES * 4) / 3) + 4).describe('The file content, base64 encoded (5 MB at most).'),
  },
  permission: { entries: ['create'] },
  amounts: 'euros',
  never: 'posts the invoice, pays it or imports an invoice addressed to another company.',
  idempotent: true,
  targetState: ({ companyId }) => [companyLock(companyId)],
  confirmation: true,
  // Every parse counts in the import limit of the user, like the import route (app/api/invoices/import-e-invoice/route.ts).
  async preview({ companyId, fileName, contentBase64 }, ctx) {
    await enforceRateLimit('import', ctx.access.user.id)
    return inEuros(await analyzeEInvoice(companyId, { bytes: decodeEInvoice(contentBase64), fileName }))
  },
  async execute({ companyId, fileName, contentBase64 }, ctx) {
    await enforceRateLimit('import', ctx.access.user.id)
    const result = await importEInvoice(companyId, { bytes: decodeEInvoice(contentBase64), fileName }, { source: 'mcp' })
    return {
      invoiceId: result.invoiceId,
      created: result.created,
      supplierCreated: result.supplierCreated,
      ...inEuros(result),
      message: result.created
        ? 'Facture importée en brouillon\u00a0: choisissez les comptes de ses lignes et comptabilisez-la dans Kledg.'
        : 'Cette facture était déjà enregistrée\u00a0: rien n’a été créé.',
    }
  },
  audit: ({ fileName }, result) => ({ invoiceId: result.invoiceId, created: result.created, fileName }),
})

const adoptPurchaseTool = fullControlTool({
  name: 'adopt_purchase',
  title: 'Reprendre une pièce fournisseur déjà comptabilisée',
  description: `Links a historical supplier PDF and its verified entry to a native purchase invoice. A documented prepayment may require a pair of draft entries. For new purchases use create_draft_invoice. ${ACTS_AS_USER} ${TWO_STEP}`,
  input: {
    attachmentId: z.string().min(1).max(64),
    quote: z.object({ rate: z.string().max(20), date: z.iso.date(), source: z.string().trim().min(1).max(80) }).optional(),
  },
  permission: { entries: ['create'], banking: ['read'] },
  amounts: 'none',
  never: 'validates an entry.',
  confirmation: true,
  idempotent: true,
  targetState: ({ companyId, attachmentId }) => [companyLock(companyId), ...rowTargets('attachments', companyId, attachmentId)],
  async preview({ companyId, attachmentId, quote }) {
    const file = await prisma.attachment.findFirstOrThrow({ where: { id: attachmentId, companyId, supplier: { kind: 'SUPPLIER' },
      expenseLines: { none: {} } }, select: { fileName: true, providerData: true } })
    return { attachmentId, fileName: file.fileName, purchaseDocument: z.object({ purchaseDocument: z.unknown() }).parse(file.providerData).purchaseDocument, quote }
  },
  execute: async ({ companyId, attachmentId, quote }) => ({ invoiceId: await adoptPurchase(companyId, attachmentId, quote) }),
  audit: ({ attachmentId }, result) => ({ attachmentId, invoiceId: result.invoiceId }),
})

export function registerInvoiceTools(register: RegisterTool) {
  register(adoptPurchaseTool)
  register(createDraftInvoiceTool)
  register(importEInvoiceTool)
}
