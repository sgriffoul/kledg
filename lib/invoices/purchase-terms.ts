import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { ValidationError } from '@/lib/accounting/errors'
import { isFrenchVatRate } from './amounts'

export const purchaseTermsSchema = z.object({
  exchange: z.object({
    currency: z.literal('USD'),
    total: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    rate: z.string().regex(/^\d{1,6}(\.\d{1,8})?$/),
    date: z.iso.date(),
    source: z.string().trim().min(1).max(120),
  }).strict().optional(),
  reverseChargeRateBp: z.number().int().positive().refine(isFrenchVatRate).optional(),
}).strict()

export type PurchaseTerms = z.infer<typeof purchaseTermsSchema>
export const isAdvance = (code?: string | null) => /^4091\d*$/.test(code ?? '')

export function checkPurchaseTerms(terms: PurchaseTerms | undefined, direction: string, day: string, totalCents: number,
  lines: Array<{ vatRateBp: number; fixedAsset: boolean; nature: string; accountCode?: string | null }>) {
  if (terms && direction !== 'PURCHASE') throw new ValidationError('Ces options sont réservées aux achats.')
  for (const line of lines) {
    if (isAdvance(line.accountCode) && (direction !== 'PURCHASE' || line.fixedAsset || line.vatRateBp || terms?.reverseChargeRateBp))
      throw new ValidationError('Une recharge de portefeuille doit être saisie sans TVA fournisseur sur le compte 4091.')
    if (terms?.reverseChargeRateBp && (line.nature !== 'SERVICES' || line.fixedAsset || line.vatRateBp))
      throw new ValidationError('L’autoliquidation proposée concerne les prestations courantes facturées hors taxe.')
  }
  const fx = terms?.exchange
  if (fx) {
    if (lines.some(l => isAdvance(l.accountCode)) && lines.length !== 1) throw new ValidationError('Une recharge en devise doit occuper une ligne unique pour suivre le solde du portefeuille.')
    const rate = new Prisma.Decimal(fx.rate)
    if (!rate.gt(0) || fx.date > day || !new Prisma.Decimal(fx.total).times(100).div(rate).toDecimalPlaces(0).eq(totalCents))
      throw new ValidationError('Vérifiez le cours, sa date et le total en euros des lignes converties.')
  }
}
