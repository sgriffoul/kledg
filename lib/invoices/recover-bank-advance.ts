import type { Prisma } from '@prisma/client'
import { ConflictError } from '@/lib/accounting/errors'
import { createEntryInTx } from '@/lib/accounting/services/entry-lifecycle.service'

/** A bank-posted advance is already on 4091. Introduce 401 in two drafts
 * (PCG, accounts 401/4091), keeping the old bank and exchange lines once. */
export async function recoverBankAdvance(tx: Prisma.TransactionClient, input: {
  companyId: string; attachmentId: string; number: string; day: string; euros: Prisma.Decimal;
  payableCode: string; auxiliary: string; name: string
}) {
  const { companyId, number, euros, auxiliary, name } = input
  const entries = await tx.accountingEntry.findMany({ where: {
    companyId, reference: number,
    supportingAttachments: { some: { id: input.attachmentId, companyId } },
    journal: { code: 'BQ' }, status: 'validated',
  }, include: { lines: { include: { account: true } } } })
  const entry = entries.length === 1 ? entries[0] : null
  const advance = entry?.lines.filter(l => l.account.code.startsWith('4091') && l.debit.eq(euros))
  const cash = entry?.lines.filter(l => l.account.code.startsWith('512') && l.credit.gt(0))
  if (!entry || advance?.length !== 1 || cash?.length !== 1 ||
      entry.lines.some(l => !['4091','512','656','756'].some(prefix => l.account.code.startsWith(prefix))) ||
      (advance[0].auxiliaryAccountNumber && advance[0].auxiliaryAccountNumber !== auxiliary))
    throw new ConflictError('Aucun prépaiement bancaire unique et justifié à reprendre.')
  const already = await tx.accountingEntry.count({ where: { companyId, reference: number, journal: { code: { in: ['AC','OD'] } } } })
  if (already) throw new ConflictError('Une écriture d’achat ou de reclassement existe déjà pour cette référence.')
  const bank = await tx.bankTransaction.findMany({ where: { bankAccount: { bankConnection: { companyId } }, reconciled: true, reconciledWith: entry.id, side: 'debit' } })
  if (bank.length !== 1 || !bank[0].amount.abs().eq(cash[0].credit)) throw new ConflictError('Le paiement bancaire ne correspond pas au prépaiement.')
  const account = await tx.account.findFirstOrThrow({ where: { companyId, fiscalYearId: entry.fiscalYearId, code: input.payableCode } })
  const journal = async (code: string) => (await tx.journal.findFirstOrThrow({ where: { companyId, code } })).id
  const amount = euros.toFixed(2)
  const supplier = { auxiliaryAccountNumber: auxiliary, auxiliaryAccountLabel: name }
  const ac = await createEntryInTx(tx,{ companyId, reference:number, date:input.day, journalId:await journal('AC'),
    description: `${name} · achat de crédits · ${number}`, lines:[
      { accountId:advance[0].accountId, debit:amount, ...supplier },{ accountId:account.id, credit:amount, ...supplier },
    ] })
  const od = await createEntryInTx(tx,{ companyId, reference:number, date:entry.date, journalId:await journal('OD'),
    description: `${name} · règlement déjà pointé BQ ${entry.entryNumber} · ${number}`, lines:[
      { accountId:account.id, debit:amount, ...supplier },{ accountId:advance[0].accountId, credit:amount,
        auxiliaryAccountNumber:advance[0].auxiliaryAccountNumber, auxiliaryAccountLabel:advance[0].auxiliaryAccountLabel },
    ] })
  const pay = await tx.entryLine.findFirstOrThrow({where:{accountingEntryId:od.id,accountId:account.id}})
  await tx.entryLine.update({where:{id:pay.id},data:{settlementBankId:bank[0].id}})
  await tx.attachment.update({where:{id:input.attachmentId},data:{supportedEntries:{connect:[ac,od]}}})
  return ac.id
}
