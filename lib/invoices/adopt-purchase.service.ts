import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { recoverBankAdvance } from './recover-bank-advance'
import { resolveDueDate } from './manage-invoices.service'
import { dayToDate } from '@/lib/accounting/entry-date'
import { prisma } from '@/lib/prisma'
import { ConflictError, ValidationError } from '@/lib/accounting/errors'

const factsSchema = z.object({
  purchaseDocument: z.object({
    number: z.string().min(1), currency: z.enum(['USD', 'EUR']), date: z.iso.date(),
    total: z.number().int().nonnegative(), net: z.number().int().nonnegative().nullable(),
  }),
})
const D = Prisma.Decimal

/** Bind an existing purchase posting to its source PDF without posting a second entry.
 * Currency quotations are expressed as units of foreign currency per euro. */
export async function adoptPurchase(companyId: string, attachmentId: string, quote?: { rate: string; date: string; source: string }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM attachments WHERE id=${attachmentId} AND "companyId"=${companyId} FOR UPDATE`
    const file = await tx.attachment.findFirstOrThrow({
      where: { id: attachmentId, companyId, receiptFile: { companyId, contentType: 'application/pdf' },
        supplier: { companyId, kind: 'SUPPLIER' }, expenseLines: { none: {} } },
      include: { supplier: true, supportedEntries: { where: { companyId, journal: { code: 'AC' } },
        select: { id: true, date: true, reference: true, fiscalYear: { select: { isClosed: true } } } } },
    })
    const facts = factsSchema.parse(file.providerData).purchaseDocument
    const supplier = file.supplier!
    const existing = await tx.invoice.findFirst({ where: { companyId, direction: 'PURCHASE', tiersId: supplier.id, number: facts.number } })
    if (existing) {
      if (!existing.documentFileId && !existing.externalAttachmentId && existing.entryId && facts.currency === existing.currency &&
          existing.totalInclTax.mul(100).eq(facts.total) && file.supportedEntries.some(e => e.id === existing.entryId && !e.fiscalYear.isClosed)) {
        await tx.invoice.update({ where: { id: existing.id }, data: { documentFileId: file.receiptFileId, attachmentFileName: file.fileName } })
        return existing.id
      }
      if (existing.documentFileId !== file.receiptFileId) throw new ConflictError('Cette référence désigne un autre document.')
      return existing.id
    }
    const foreign = facts.currency !== 'EUR'
    if (foreign && (!quote || !/^\d+(\.\d{1,8})?$/.test(quote.rate) || !new D(quote.rate).gt(0) ||
      !z.iso.date().safeParse(quote.date).success || quote.date > facts.date || !quote.source.trim())) throw new ValidationError('Cours de change daté et sourcé requis.')
    const rate = new D(foreign ? quote!.rate : 1)
    const inEuros = (cents: number) => new D(cents).div(100).div(rate).toDecimalPlaces(2)
    const total = inEuros(facts.total)
    const entries = file.supportedEntries.filter(e => e.reference === facts.number && e.date.toISOString().slice(0,10) === facts.date)
    if (entries.length > 1) throw new ConflictError('Plusieurs écritures d’achat correspondent à la facture.')
    let entryId = entries[0]?.id
    if (total.isZero()) {
      const offsets = await tx.accountingEntry.findMany({ where: { companyId, reference: facts.number, date: dayToDate(facts.date),
        journal: { code: 'OD' }, fiscalYear: { isClosed: false }, supportingAttachments: { some: { id: attachmentId } } },
        include: { lines: { include: { account: true } } } })
      const offset = offsets[0]
      if (facts.net !== 0 || offsets.length !== 1 || offset.lines.length !== 2 ||
          !offset.lines.some(l => l.debit.gt(0) && l.account.code.startsWith('6')) ||
          !offset.lines.some(l => l.credit.gt(0) && l.account.code.startsWith('4091') && l.auxiliaryAccountNumber === supplier.auxiliaryAccountNumber))
        throw new ConflictError('La consommation de l’avance doit être justifiée par son écriture.')
      entryId = offset.id
    } else if (!entryId) {
      entryId = await recoverBankAdvance(tx,{companyId, attachmentId, number:facts.number,day:facts.date,euros:total,
        payableCode:supplier.collectiveAccountCode ?? '401',auxiliary:supplier.auxiliaryAccountNumber,name:supplier.name})
    }
    await tx.$queryRaw`SELECT id FROM accounting_entries WHERE id=${entryId} FOR UPDATE`
    const entry = await tx.accountingEntry.findFirstOrThrow({where:{companyId,id:entryId,fiscalYear:{isClosed:false}},
      include:{lines:{include:{account:true}}}})
    if (!total.isZero()) {
      const payable = entry.lines.filter(l => (supplier.collectiveAccountCode ? l.account.code === supplier.collectiveAccountCode : l.account.code.startsWith('401')) && l.auxiliaryAccountNumber === supplier.auxiliaryAccountNumber)
      if (payable.length !== 1 || !payable[0].debit.isZero() || !total.eq(payable[0].credit)) throw new ConflictError('La dette en euros doit correspondre au TTC converti et au tiers.')
    }
    const net = facts.net === null ? new D(0) : inEuros(facts.net)
    const vat = facts.net === null ? new D(0) : total.minus(net)
    if (vat.isNegative()) throw new ValidationError('TVA incohérente sur la facture.')
    const dueDate = await resolveDueDate(companyId, supplier, facts.date, undefined)
    const invoice = await tx.invoice.create({ data: {
      companyId, direction: 'PURCHASE', tiersId: supplier.id, number: facts.number, issueDate: entry.date,
      dueDate: dayToDate(dueDate), label: 'Reprise sur écriture existante', unitemizedAmount: facts.net === null ? total : 0, documentFileId: file.receiptFileId,
      attachmentFileName: file.fileName, entryId: entry.id, totalInclTax: total, totalExclTax: net, totalVat: vat,
      purchaseOriginal: { currency: facts.currency, total: new D(facts.total).div(100).toFixed(2),
        net: facts.net === null ? null : new D(facts.net).div(100).toFixed(2), dueDateSource: 'conditions de paiement du tiers', rate: rate.toString(),
        rateDate: foreign ? quote!.date : facts.date, source: foreign ? quote!.source : 'EUR' },
    } })
    return invoice.id
  }, { isolationLevel: 'Serializable' })
}
