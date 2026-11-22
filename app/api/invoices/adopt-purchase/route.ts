import { NextResponse } from 'next/server'
import { z } from 'zod'
import { companyRoute, fromBody } from '@/lib/api/route'
import { adoptPurchase } from '@/lib/invoices/adopt-purchase.service'

const body = z.object({
  attachmentId: z.string().min(1).max(64),
  quote: z.object({ rate: z.string().max(20), date: z.iso.date(), source: z.string().trim().min(1).max(80) }).optional(),
})

export const POST = companyRoute(
  { company: fromBody(), permission: { entries: ['create'] }, body },
  async ({ companyId, body: input, authorize }) => {
    authorize({ banking: ['read'] })
    const id = await adoptPurchase(companyId, input.attachmentId, input.quote)
    return NextResponse.json({ id })
  },
)
