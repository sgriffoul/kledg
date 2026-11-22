import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ConflictError, ValidationError } from '@/lib/accounting/errors'
import { createEntryInTx } from '@/lib/accounting/services/entry-lifecycle.service'
import { resolveBankAccountLedger } from '@/lib/banking/ledger-account'
import { createEntryAndReconcile, loadTransaction } from '@/lib/reconciliation/service'
import { calendarDayOf } from '@/lib/utils/date'
import { centsToDecimal } from '@/lib/utils/money'
import { accountByRoot } from './ledger-accounts'
import { lockInvoice } from './manage-invoices.service'
import { isAdvance, purchaseTermsSchema } from './purchase-terms'

export const settlementInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('bank'), transactionId: z.string().min(1).max(100) }).strict(),
  z.object({ method: z.literal('wallet'), date: z.iso.date() }).strict(),
])
type Settlement = z.infer<typeof settlementInput>

/** Prepare a single full settlement. Partial or grouped payments use the ordinary banking workflow. */
export async function preparePurchasePayment(companyId: string, invoiceId: string, input: Settlement, preview = false) {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId, companyId, direction: 'PURCHASE', typeCode: '380', entryId: { not: null } },
    include: { _count: { select: { payments: true } }, tiers: true, entry: { include: { fiscalYear: true } }, lines: true },
  })
  if (!invoice.number || !invoice.entry || invoice.purchaseOriginal || !invoice.totalInclTax.gt(0))
    throw new ConflictError('Choisissez une nouvelle facture fournisseur comptabilisée avec un montant positif.')
  if (invoice._count.payments) throw new ConflictError('Un règlement existe déjà pour cette facture.')
  const number = invoice.number
  const year = invoice.entry.fiscalYear
  const { auxiliaryAccountNumber, name: auxiliaryAccountLabel } = invoice.tiers
  const supplier = { auxiliaryAccountNumber, auxiliaryAccountLabel }
  const terms = invoice.purchaseTerms ? purchaseTermsSchema.parse(invoice.purchaseTerms) : undefined
  const payment = input.method === 'bank' ? await loadTransaction(companyId, input.transactionId) : null
  const date = input.method === 'wallet' ? input.date : calendarDayOf(payment!.date)!
  if (date < calendarDayOf(invoice.issueDate)! || date > calendarDayOf(year.endDate)! || year.isClosed)
    throw new ValidationError('Ce règlement intégral doit suivre la facture dans le même exercice ouvert.')
  if (payment && (payment.side !== 'debit' || payment.reconciled)) throw new ConflictError('Choisissez un débit bancaire à rapprocher.')
  const amount = invoice.totalInclTax.times(100).toNumber()
  if (!payment && invoice.lines.some(line => isAdvance(line.accountCode))) throw new ValidationError('Une recharge ne se règle pas avec le portefeuille lui-même.')
  const account = async (code: string) => accountByRoot(prisma, companyId, year, code, code)
  const payable = await account(invoice.tiers.collectiveAccountCode ?? '401')
  const counterpart = payment ? await resolveBankAccountLedger(companyId, year.id, payment.bankAccountId) : await account('4091')
  if (!counterpart) throw new ValidationError('Configurez le compte bancaire 512 pour ce règlement.')
  async function walletCost(db: Prisma.TransactionClient) {
    const rows = await db.entryLine.findMany({ where: { accountId: counterpart!.id, auxiliaryAccountNumber,
      accountingEntry: { companyId, fiscalYearId: year.id },
      OR: [{ credit: { gt: 0 } }, { accountingEntry: { status: 'validated', date: { lte: new Date(date) } } }],
    }, select: { debit: true, credit: true, currencyCode: true, currencyAmount: true, accountingEntry: { select: { date: true } } } })
    const fx = terms?.exchange
    let euros = new Prisma.Decimal(0), units = new Prisma.Decimal(0)
    for (const row of rows) {
      if (row.accountingEntry.date > new Date(date) || (row.currencyCode ?? 'EUR') !== (fx?.currency ?? 'EUR') ||
          (fx && (!row.currencyAmount || row.currencyAmount.isZero() || row.currencyAmount.isNegative() !== row.credit.gt(0))))
        throw new ConflictError('Vérifiez la devise, la chronologie et le solde d’ouverture du portefeuille.')
      euros = euros.plus(row.debit).minus(row.credit)
      units = units.plus(row.currencyAmount ?? row.debit.minus(row.credit))
    }
    const use = new Prisma.Decimal(fx?.total ?? invoice.totalInclTax)
    if (units.lt(use) || euros.lte(0)) throw new ConflictError('Le crédit justifié disponible sur le 4091 du fournisseur est insuffisant.')
    return euros.times(100).times(use).div(units).toDecimalPlaces(0).toNumber()
  }
  const bankAmount = payment ? payment.amount.abs().times(100).toNumber() : await walletCost(prisma)
  const difference = bankAmount - amount
  if (difference && !terms?.exchange) throw new ValidationError('Le règlement diffère du total de cette facture en euros.')
  const exchange = difference ? await account(difference > 0 ? '656' : '756') : null
  const lines = [
    { accountId: payable.id, code: payable.code, debitCents: amount, creditCents: 0, ...supplier },
    { accountId: counterpart.id, code: counterpart.code, debitCents: 0, creditCents: bankAmount, ...(!payment ? supplier : {}) },
  ]
  if (exchange) lines.push({ accountId: exchange.id, code: exchange.code, debitCents: Math.max(difference, 0), creditCents: Math.max(-difference, 0) })
  const summary = { date, lines: lines.map(l => ({ accountCode: l.code, debit: l.debitCents / 100, credit: l.creditCents / 100, auxiliaryAccountNumber: l.auxiliaryAccountNumber })) }
  const journal = await prisma.journal.findFirstOrThrow({ where: { companyId, code: payment ? 'BQ' : 'OD' } })
  async function check(db: Prisma.TransactionClient, ownEntry?: string) {
    const locked = await lockInvoice(db, companyId, invoiceId)
    if (locked.entryId !== invoice.entryId || locked.tiersId !== invoice.tiersId || !locked.totalInclTax.eq(invoice.totalInclTax)) throw new ConflictError('La facture a changé.')
    if (payment && ownEntry) {
      const claimed = await db.bankTransaction.findUniqueOrThrow({ where: { id: payment.id } })
      if (!claimed.amount.eq(payment.amount) || claimed.side !== payment.side || claimed.bankAccountId !== payment.bankAccountId ||
          claimed.date.getTime() !== payment.date.getTime()) throw new ConflictError('Le mouvement bancaire a changé.')
    }
    const existing = await db.entryLine.count({ where: {
      accountingEntry: { companyId, reference: number, ...(ownEntry ? { id: { not: ownEntry } } : {}) },
      accountId: payable.id, debit: { gt: 0 }, auxiliaryAccountNumber,
    } })
    if (existing || await db.invoicePayment.count({ where: { invoiceId } })) throw new ConflictError('Un règlement existe déjà pour cette facture.')
    if (!payment && await walletCost(db) !== bankAmount) throw new ConflictError('Le solde du portefeuille a changé.')
  }
  if (preview) {
    await prisma.$transaction(db => check(db))
    return { ...summary, entryId: null }
  }
  const description = `Règlement ${invoice.tiers.name} · ${number}`
  if (payment) {
    const result = await createEntryAndReconcile({ companyId, transactionId: payment.id, journalId: journal.id, fiscalYearId: year.id,
      date: new Date(date), description, reference: number, lines, afterCreate: check })
    return { ...summary, entryId: result.id }
  }
  return prisma.$transaction(async db => {
    await check(db)
    const draft = await createEntryInTx(db, { companyId, journalId: journal.id, fiscalYearId: year.id, date, description, reference: number,
      lines: lines.map(l => ({ ...l, ...(terms?.exchange && l.accountId === counterpart.id ? {
        currencyCode: terms.exchange.currency, currencyAmount: '-' + terms.exchange.total,
      } : {}), debit: centsToDecimal(l.debitCents), credit: centsToDecimal(l.creditCents) })) })
    return { ...summary, entryId: draft.id }
  }, { isolationLevel: 'Serializable' })
}
