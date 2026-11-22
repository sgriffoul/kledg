import { NextResponse } from 'next/server'
import { companyRoute, fromResource } from '@/lib/api/route'
import { companyOfInvoice } from '@/lib/api/resources'
import { preparePurchasePayment, settlementInput } from '@/lib/invoices/prepare-purchase-payment'
import { z } from 'zod'

export const POST = companyRoute({
  company: fromResource(companyOfInvoice), permission: { entries: ['create'], banking: ['reconcile'] },
  body: z.object({ settlement: settlementInput, preview: z.boolean().default(true) }),
}, async ({ companyId, params, body }) => NextResponse.json(
  await preparePurchasePayment(companyId, params.id as string, body.settlement, body.preview),
))
