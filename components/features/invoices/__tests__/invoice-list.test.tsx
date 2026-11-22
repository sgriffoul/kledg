import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { CompanyAccessProvider } from '@/components/features/companies/company-access'
import { InvoiceList } from '../invoice-list'
import { ExpenseReportList } from '@/components/features/expense-reports/expense-report-list'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [], invoices: [], reports: [], nextCursor: null }), { status: 200 })),
  )
})
afterEach(() => vi.unstubAllGlobals())

const emptyState = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('[data-slot="empty-state"]') as HTMLElement

describe('empty lists say what to do next', () => {
  it('sales invoices: create the first invoice, or its customer first', async () => {
    render(<InvoiceList companyId="atelier" direction="SALE" />)
    const empty = await emptyState('Aucune facture de vente')
    expect(within(empty).getByRole('link', { name: 'Nouvelle facture' }).getAttribute('href')).toBe('/atelier/invoices/new?direction=SALE')
    expect(within(empty).getByRole('link', { name: 'Ajouter un client' }).getAttribute('href')).toBe('/atelier/tiers/new')
  })

  it('purchase invoices: create the first invoice', async () => {
    render(<InvoiceList companyId="atelier" direction="PURCHASE" />)
    const empty = await emptyState('Aucune facture d’achat')
    expect(within(empty).getByRole('link', { name: 'Nouvelle facture' }).getAttribute('href')).toBe('/atelier/invoices/new?direction=PURCHASE')
    expect(within(empty).queryByRole('link', { name: 'Ajouter un client' })).toBeNull()
  })

  it('opens an archived purchase directly from its row and displays the original currency', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [{
      id: 'a', attachmentId: 'a', number: 'USD-001', currency: 'USD', issueDate: '2026-06-30',
      tiers: { name: 'Supplier', auxiliaryAccountNumber: 'F1' }, totalInclTaxCents: 1200,
      dueDate: null, remainingCents: null, totalExclTaxCents: 1000, status: 'archived',
    }], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    render(<InvoiceList companyId="atelier" direction="PURCHASE" />)
    const table = within(await screen.findByRole('table'))
    expect(table.getByRole('link', { name: 'USD-001' })).toHaveAttribute('href', '/api/banking/attachments/a/proxy?companyId=atelier')
    expect(table.getByText('Archivée')).toBeInTheDocument()
    expect(table.getByText(/12,00.*US/)).toBeInTheDocument()
  })

  it('searches bank-backed receipts from purchase invoices and opens the original', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith('/api/transactions?')) return Response.json({ items: [], nextCursor: null })
      return Response.json({ transactions: [{
        id: 't1', label: 'OPENAI', date: '2026-11-21', amount: 16.5, reconciledWith: 'e1',
        attachments: [{ id: 'a1', fileName: '278896CD-0063.pdf' }],
      }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<InvoiceList companyId="atelier" direction="PURCHASE" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Rechercher un justificatif' }))
    expect(await screen.findByRole('link', { name: '278896CD-0063.pdf' })).toHaveAttribute(
      'href', '/api/banking/attachments/a1/proxy?companyId=atelier',
    )
    expect(screen.getByRole('link', { name: 'Voir l’écriture' })).toHaveAttribute('href', '/atelier/entries/e1')
    await user.type(screen.getByLabelText('Fournisseur ou numéro de facture'), '0063')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('hasAttachments=with') && url.includes('searchText=0063'))).toBe(true))
  })

  it('offers no creation to a role that cannot create invoices', async () => {
    render(
      <CompanyAccessProvider value={{ granted: { entries: ['read'] }, roleLabel: 'Lecteur' }}>
        <InvoiceList companyId="atelier" direction="SALE" />
      </CompanyAccessProvider>,
    )
    const empty = await emptyState('Aucune facture de vente')
    expect(within(empty).queryByRole('link', { name: 'Nouvelle facture' })).toBeNull()
  })

  it('expense reports: file the first one', async () => {
    render(<ExpenseReportList companyId="atelier" mine={false} />)
    const empty = await emptyState('Aucune note de frais')
    expect(within(empty).getByRole('link', { name: 'Nouvelle note de frais' }).getAttribute('href')).toBe('/atelier/expense-reports/new')
  })
})
